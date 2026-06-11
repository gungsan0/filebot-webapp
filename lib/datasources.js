// Datasource layer — fetch canonical movie/episode metadata, FileBot-style.
//
// Providers:
//   - tvmaze : free, no API key (TV series only)
//   - tmdb   : TheMovieDB, requires apiKey (movies + TV)
//   - omdb   : OMDb, requires apiKey (movies + series)
//
// Each provider enriches a parsed file's fields (n, y, t) with authoritative
// values. On any failure it falls back to the filename-derived data so the
// rename pipeline never breaks.

const TIMEOUT_MS = 8000;
// Descriptive User-Agent — Wikidata's API policy requires one and throttles
// anonymous/blank agents aggressively.
const UA = 'filebot-webapp/1.0 (https://github.com/gungsan0/filebot-webapp)';

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const yearOf = (date) => (date ? String(date).slice(0, 4) : '');

// ---------------- TVmaze (no key, TV only) ----------------
const tvmaze = {
  async matchEpisode(file) {
    const show = await getJSON(
      `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(file.n)}`,
    );
    if (!show || !show.id) return null;
    const out = { n: show.name, y: yearOf(show.premiered), source: 'TVmaze' };
    if (file.s && file.e) {
      try {
        const ep = await getJSON(
          `https://api.tvmaze.com/shows/${show.id}/episodebynumber?season=${file.s}&number=${file.e}`,
        );
        if (ep && ep.name) out.t = ep.name;
      } catch {
        /* episode lookup optional */
      }
    }
    return out;
  },
  // TVmaze has no movie database.
  async matchMovie() {
    return null;
  },
};

// ---------------- Wikidata (no key, movies + TV series) ----------------
// Resolves canonical title + year. Comprehensive and keyless; episode-level
// titles aren't available here, so episode matching fixes the show name/year
// and leaves the episode title to the filename (or use TVmaze/TMDB for that).
const norm = (v) => (v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "instance of" (P31) QIDs that count as a film / a TV series.
const FILM_TYPES = new Set([
  'Q11424', 'Q24862', 'Q202866', 'Q24856', 'Q229390', 'Q506240',
  'Q24869', 'Q20650540', 'Q500834', 'Q1361932', 'Q130232', 'Q18011172',
]);
const TV_TYPES = new Set([
  'Q5398426', 'Q581714', 'Q1259759', 'Q63952888', 'Q1366112', 'Q15416', 'Q21191270',
]);

async function wikidataSearch(title, typeSet, year) {
  if (!title) return null;
  const search = await getJSON(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(title)}&language=en&format=json&type=item&limit=10&origin=*`,
  );
  if (!search.search || !search.search.length) return null;
  const ids = search.search.map((x) => x.id).join('|');
  const ents = await getJSON(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=claims|labels&languages=en&format=json&origin=*`,
  );
  const cands = [];
  for (const item of search.search) {
    const ent = ents.entities && ents.entities[item.id];
    if (!ent) continue;
    const p31 = (ent.claims?.P31 || []).map((c) => c.mainsnak?.datavalue?.value?.id);
    if (!p31.some((id) => typeSet.has(id))) continue;
    const time = ent.claims?.P577?.[0]?.mainsnak?.datavalue?.value?.time; // +2010-07-16T00:00:00Z
    cands.push({ label: ent.labels?.en?.value || item.label, y: time ? time.slice(1, 5) : '' });
  }
  if (!cands.length) return null;
  // Prefer an exact year match (filenames usually carry the right year),
  // then an exact title match, else the top-ranked film/series candidate.
  return (
    (year && cands.find((c) => c.y === year)) ||
    cands.find((c) => norm(c.label) === norm(title)) ||
    cands[0]
  );
}

const wikidata = {
  async matchMovie(file) {
    const r = await wikidataSearch(file.n, FILM_TYPES, file.y);
    return r ? { n: r.label, y: r.y, source: 'Wikidata' } : null;
  },
  async matchEpisode(file) {
    const r = await wikidataSearch(file.n, TV_TYPES, '');
    return r ? { n: r.label, y: r.y, source: 'Wikidata' } : null;
  },
};

// ---------------- TheMovieDB (key required) ----------------
function tmdb(apiKey, language = 'en-US') {
  const base = 'https://api.themoviedb.org/3';
  const key = `api_key=${apiKey}&language=${encodeURIComponent(language)}`;
  return {
    async matchMovie(file) {
      const yq = file.y ? `&year=${file.y}` : '';
      const data = await getJSON(
        `${base}/search/movie?${key}&query=${encodeURIComponent(file.n)}${yq}`,
      );
      const m = data.results && data.results[0];
      if (!m) return null;
      return { n: m.title || m.original_title, y: yearOf(m.release_date), source: 'TheMovieDB' };
    },
    async matchEpisode(file) {
      const data = await getJSON(`${base}/search/tv?${key}&query=${encodeURIComponent(file.n)}`);
      const show = data.results && data.results[0];
      if (!show) return null;
      const out = { n: show.name || show.original_name, y: yearOf(show.first_air_date), source: 'TheMovieDB' };
      if (file.s && file.e) {
        try {
          const ep = await getJSON(`${base}/tv/${show.id}/season/${file.s}/episode/${file.e}?${key}`);
          if (ep && ep.name) out.t = ep.name;
        } catch {
          /* episode lookup optional */
        }
      }
      return out;
    },
  };
}

// ---------------- OMDb (key required) ----------------
function omdb(apiKey) {
  const base = `https://www.omdbapi.com/?apikey=${apiKey}`;
  return {
    async matchMovie(file) {
      const yq = file.y ? `&y=${file.y}` : '';
      const data = await getJSON(`${base}&t=${encodeURIComponent(file.n)}${yq}&type=movie`);
      if (!data || data.Response === 'False') return null;
      return { n: data.Title, y: yearOf(data.Year), source: 'OMDb' };
    },
    async matchEpisode(file) {
      // OMDb can resolve series name + episode title via Season/Episode params.
      const show = await getJSON(`${base}&t=${encodeURIComponent(file.n)}&type=series`);
      if (!show || show.Response === 'False') return null;
      const out = { n: show.Title, y: yearOf(show.Year), source: 'OMDb' };
      if (file.s && file.e) {
        try {
          const ep = await getJSON(
            `${base}&t=${encodeURIComponent(file.n)}&Season=${file.s}&Episode=${file.e}`,
          );
          if (ep && ep.Response !== 'False' && ep.Title) out.t = ep.Title;
        } catch {
          /* optional */
        }
      }
      return out;
    },
  };
}

export function getProvider(source, apiKey, language) {
  switch ((source || '').toLowerCase()) {
    case 'tvmaze':
      return tvmaze;
    case 'wikidata':
      return wikidata;
    case 'tmdb':
    case 'themoviedb':
      if (!apiKey) throw new Error('TheMovieDB requires an API key');
      return tmdb(apiKey, language);
    case 'omdb':
      if (!apiKey) throw new Error('OMDb requires an API key');
      return omdb(apiKey);
    default:
      throw new Error(`Unknown datasource: ${source}`);
  }
}

// Enrich one parsed file via the chosen provider. Returns a new file object;
// on no-match or error, returns the original file with matched=false.
export async function matchFile(file, source, apiKey, language) {
  const provider = getProvider(source, apiKey, language);
  try {
    const result =
      file.type === 'episode'
        ? await provider.matchEpisode(file)
        : await provider.matchMovie(file);
    if (!result) return { ...file, matched: false };
    return {
      ...file,
      n: result.n || file.n,
      y: result.y || file.y,
      t: result.t !== undefined && result.t !== '' ? result.t : file.t,
      matched: true,
      source: result.source,
    };
  } catch (err) {
    return { ...file, matched: false, matchError: err.message };
  }
}
