import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import dns from 'node:dns';

// Some networks hang on IPv6 connect attempts before falling back; prefer IPv4
// so datasource lookups (TVmaze/TMDB/OMDb) connect reliably.
dns.setDefaultResultOrder('ipv4first');

import { parseFilename } from './lib/parse.js';
import { formatName, sanitizePath } from './lib/format.js';
import { matchFile } from './lib/datasources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 7420;

// Persist user data outside the app bundle (which is read-only once installed
// via the .pkg). Survives app updates and is independent of the browser.
const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'FileBot WebApp');
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json');
const DEFAULT_PRESETS_FILE = path.join(__dirname, 'presets.json'); // shipped defaults
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json'); // recently-used source folders
const DEST_FILE = path.join(DATA_DIR, 'destinations.json'); // recently-used destination roots
const MAX_RECENT = 12;

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Expand a leading ~ to the user's home directory.
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function readPresets() {
  try {
    return JSON.parse(await fs.readFile(PRESETS_FILE, 'utf8'));
  } catch {
    // First run: seed the user copy from the defaults shipped in the bundle.
    try {
      const def = await fs.readFile(DEFAULT_PRESETS_FILE, 'utf8');
      await ensureDataDir();
      await fs.writeFile(PRESETS_FILE, def);
      return JSON.parse(def);
    } catch {
      return [];
    }
  }
}

// Generic "recently-used" list persistence (source folders, destinations, …).
async function readList(file) {
  try {
    const list = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Move a value to the front of the recent list (dedup, capped).
async function recordRecent(file, value) {
  const v = (value || '').trim();
  if (!v) return;
  const list = await readList(file);
  const next = [v, ...list.filter((d) => d !== v)].slice(0, MAX_RECENT);
  await ensureDataDir();
  await fs.writeFile(file, JSON.stringify(next, null, 2));
}

async function removeRecent(file, value) {
  const list = (await readList(file)).filter((d) => d !== value);
  await ensureDataDir();
  await fs.writeFile(file, JSON.stringify(list, null, 2));
  return list;
}

// --- Presets CRUD ---
app.get('/api/presets', async (_req, res) => {
  res.json(await readPresets());
});

app.put('/api/presets', async (req, res) => {
  const presets = req.body;
  if (!Array.isArray(presets)) {
    return res.status(400).json({ error: 'Body must be an array of presets.' });
  }
  await ensureDataDir();
  await fs.writeFile(PRESETS_FILE, JSON.stringify(presets, null, 2));
  res.json({ ok: true, count: presets.length });
});

// --- Recent source folders ---
app.get('/api/folders', async (_req, res) => {
  res.json(await readList(FOLDERS_FILE));
});

app.post('/api/folders/forget', async (req, res) => {
  res.json({ ok: true, folders: await removeRecent(FOLDERS_FILE, req.body.dir) });
});

// --- Recent destination roots ---
app.get('/api/destinations', async (_req, res) => {
  res.json(await readList(DEST_FILE));
});

app.post('/api/destinations/forget', async (req, res) => {
  res.json({ ok: true, destinations: await removeRecent(DEST_FILE, req.body.dir) });
});

// --- Scan a directory and parse every media file ---
app.post('/api/scan', async (req, res) => {
  try {
    const dir = expandHome(req.body.dir);
    if (!dir) return res.status(400).json({ error: 'dir is required' });
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

    const recursive = req.body.recursive !== false;
    const files = [];

    async function walk(current) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(current, ent.name);
        if (ent.isDirectory()) {
          if (recursive) await walk(full);
        } else {
          const meta = parseFilename(ent.name);
          if (meta.isVideo) {
            files.push({ path: full, dir: current, ...meta });
          }
        }
      }
    }

    await walk(dir);
    await recordRecent(FOLDERS_FILE, req.body.dir); // remember what the user typed
    res.json({ dir, count: files.length, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Match files against a datasource to fetch real metadata ---
app.post('/api/match', async (req, res) => {
  try {
    const { files = [], source = 'wikidata', apiKey = '', language = 'en' } = req.body;
    if (!files.length) return res.status(400).json({ error: 'files is required' });

    // Resolve sequentially-ish but with bounded concurrency to be polite to APIs.
    const CONCURRENCY = 4;
    const out = new Array(files.length);
    let cursor = 0;
    async function worker() {
      while (cursor < files.length) {
        const i = cursor++;
        out[i] = await matchFile(files[i], source, apiKey, language);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

    const matched = out.filter((f) => f.matched).length;
    res.json({ source, matched, count: out.length, files: out });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Preview new names for a set of files ---
app.post('/api/preview', async (req, res) => {
  try {
    const { files = [], format, destRoot = '' } = req.body;
    if (!format) return res.status(400).json({ error: 'format is required' });
    const root = expandHome(destRoot);
    await recordRecent(DEST_FILE, destRoot); // remember the destination root

    const ops = files.map((f) => {
      const meta = { ...f };
      let rel = formatName(format, meta);
      rel = sanitizePath(rel);
      const newName = rel + (f.ext ? '.' + f.ext : '');
      const to = root ? path.join(root, newName) : path.join(f.dir, newName);
      return {
        from: f.path,
        to,
        fromName: path.basename(f.path),
        toName: newName,
        type: meta.type,
        ok: rel.length > 0,
      };
    });

    res.json({ ops });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Execute the rename / move / copy ---
app.post('/api/rename', async (req, res) => {
  const { ops = [], action = 'move' } = req.body;
  const results = [];

  for (const op of ops) {
    if (!op.from || !op.to) {
      results.push({ ...op, status: 'skipped', reason: 'missing path' });
      continue;
    }
    try {
      if (action === 'dryrun') {
        results.push({ ...op, status: 'dryrun' });
        continue;
      }
      if (path.resolve(op.from) === path.resolve(op.to)) {
        results.push({ ...op, status: 'skipped', reason: 'same path' });
        continue;
      }
      await fs.mkdir(path.dirname(op.to), { recursive: true });
      // Guard against clobbering an existing different file.
      try {
        await fs.access(op.to);
        results.push({ ...op, status: 'skipped', reason: 'destination exists' });
        continue;
      } catch {
        /* destination free */
      }
      if (action === 'copy') {
        await fs.copyFile(op.from, op.to);
      } else {
        await fs.rename(op.from, op.to).catch(async (err) => {
          // Cross-device rename → fall back to copy+unlink.
          if (err.code === 'EXDEV') {
            await fs.copyFile(op.from, op.to);
            await fs.unlink(op.from);
          } else {
            throw err;
          }
        });
      }
      results.push({ ...op, status: 'done' });
    } catch (err) {
      results.push({ ...op, status: 'error', reason: err.message });
    }
  }

  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  res.json({ results, summary });
});

// Graceful shutdown — lets the packaged (dock-less) app be stopped from the UI.
app.post('/api/quit', (_req, res) => {
  res.json({ ok: true });
  console.log('Shutdown requested via /api/quit');
  setTimeout(() => process.exit(0), 150);
});

app.listen(PORT, () => {
  console.log(`FileBot WebApp running at http://localhost:${PORT}`);
});
