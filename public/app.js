// FileBot WebApp — client logic.

const $ = (id) => document.getElementById(id);
const api = async (url, body) => {
  const res = await fetch(url, {
    method: body ? (url === '/api/presets' ? 'PUT' : 'POST') : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

let presets = [];
let scannedFiles = [];
let previewOps = [];

// ---- Presets ----
async function loadPresets() {
  presets = await api('/api/presets');
  const sel = $('presetSelect');
  sel.innerHTML = '';
  presets.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${p.name} (${p.type})`;
    sel.appendChild(opt);
  });
  if (presets.length) applyPresetToForm(0);
}

function applyPresetToForm(i) {
  const p = presets[i];
  if (!p) return;
  $('presetSelect').value = i;
  $('presetName').value = p.name;
  $('presetType').value = p.type;
  $('formatStr').value = p.format;
}

$('presetSelect').addEventListener('change', (e) => applyPresetToForm(+e.target.value));

$('newPresetBtn').addEventListener('click', () => {
  presets.push({ id: 'custom-' + Date.now(), name: '새 프리셋', type: 'movie', format: '{n} ({y})' });
  loadPresetsUiKeepLast();
});
function loadPresetsUiKeepLast() {
  const sel = $('presetSelect');
  sel.innerHTML = '';
  presets.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${p.name} (${p.type})`;
    sel.appendChild(opt);
  });
  applyPresetToForm(presets.length - 1);
}

$('savePresetBtn').addEventListener('click', async () => {
  const i = +$('presetSelect').value;
  if (!presets[i]) return;
  presets[i] = {
    id: presets[i].id || 'custom-' + Date.now(),
    name: $('presetName').value.trim() || '이름없음',
    type: $('presetType').value,
    format: $('formatStr').value,
  };
  try {
    await api('/api/presets', presets);
    await loadPresets();
    setStatus('previewStatus', '프리셋 저장됨.', 'ok');
  } catch (e) {
    setStatus('previewStatus', '저장 실패: ' + e.message, 'err');
  }
});

$('deletePresetBtn').addEventListener('click', async () => {
  const i = +$('presetSelect').value;
  if (!presets[i]) return;
  presets.splice(i, 1);
  await api('/api/presets', presets);
  await loadPresets();
});

// ---- Scan ----
// Remember the source folder / scan options across sessions.
const DIR_STORE = 'fbw_scandir';
const RECURSIVE_STORE = 'fbw_recursive';
const MEDIATYPE_STORE = 'fbw_mediatype';

const savedDir = localStorage.getItem(DIR_STORE);
if (savedDir) $('scanDir').value = savedDir;
if (localStorage.getItem(RECURSIVE_STORE) === 'false') $('recursive').checked = false;
const savedMediaType = localStorage.getItem(MEDIATYPE_STORE);
if (savedMediaType) $('mediaType').value = savedMediaType;

$('scanDir').addEventListener('change', () => localStorage.setItem(DIR_STORE, $('scanDir').value.trim()));
$('recursive').addEventListener('change', () => localStorage.setItem(RECURSIVE_STORE, $('recursive').checked));

// Recently-used source folders are remembered server-side (survives browser
// changes and app restarts). Populate the autocomplete + dropdown and prefill.
async function loadFolders() {
  let folders = [];
  try { folders = await api('/api/folders'); } catch { /* ignore */ }
  $('recentFolders').innerHTML = folders.map((d) => `<option value="${esc(d)}">`).join('');
  $('recentSelect').innerHTML =
    '<option value="">— 최근 사용한 폴더 —</option>' + folders.map((d) => `<option>${esc(d)}</option>`).join('');
  $('recentRow').style.display = folders.length ? 'flex' : 'none';
  if (!$('scanDir').value.trim() && folders.length) $('scanDir').value = folders[0];
}

$('recentSelect').addEventListener('change', () => {
  if ($('recentSelect').value) $('scanDir').value = $('recentSelect').value;
});

$('forgetFolderBtn').addEventListener('click', async () => {
  const dir = $('recentSelect').value || $('scanDir').value.trim();
  if (!dir) return;
  try {
    await fetch('/api/folders/forget', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }),
    });
  } catch { /* ignore */ }
  await loadFolders();
});
$('mediaType').addEventListener('change', () => {
  localStorage.setItem(MEDIATYPE_STORE, $('mediaType').value);
  if (scannedFiles.length) renderPreviewFromScan();
});

// Effective file type: honor the manual movie/drama override, else the
// filename-detected type. Returns files with `type` set accordingly.
function typedFiles() {
  const sel = $('mediaType').value;
  return scannedFiles.map((f) => ({ ...f, type: sel === 'auto' ? (f.autoType ?? f.type) : sel }));
}

$('scanBtn').addEventListener('click', async () => {
  const dir = $('scanDir').value.trim();
  if (!dir) return setStatus('scanStatus', '폴더 경로를 입력하세요.', 'err');
  localStorage.setItem(DIR_STORE, dir);
  setStatus('scanStatus', '스캔 중…');
  try {
    const data = await api('/api/scan', { dir, recursive: $('recursive').checked });
    // Keep the auto-detected type so the override can be toggled back to "auto".
    scannedFiles = data.files.map((f) => ({ ...f, autoType: f.type }));
    setStatus('scanStatus', `${data.count}개 미디어 파일 발견.`, 'ok');
    renderPreviewFromScan();
    loadFolders(); // refresh the remembered-folder list with this scan
  } catch (e) {
    setStatus('scanStatus', '스캔 실패: ' + e.message, 'err');
  }
});

function renderPreviewFromScan() {
  const tbody = $('previewTable').querySelector('tbody');
  tbody.innerHTML = '';
  typedFiles().forEach((f) => {
    const tr = document.createElement('tr');
    const kind = f.type === 'episode' ? '드라마' : '영화';
    const meta = [kind + ':', f.n, f.y && '('+f.y+')', f.s && 'S'+f.s, f.e && 'E'+f.e, f.t].filter(Boolean).join(' ');
    let badge = '<span class="badge ready">scanned</span>';
    if (f.matched === true) badge = `<span class="badge matched">✓ ${esc(f.source || 'matched')}</span>`;
    else if (f.matched === false) badge = '<span class="badge unmatched">no match</span>';
    tr.innerHTML = `<td class="mono">${esc(f.filename)}</td><td class="arrow"></td>
      <td class="toName">${esc(meta)}</td><td>${badge}</td>`;
    tbody.appendChild(tr);
  });
}

// ---- Datasource match ----
const KEYLESS = ['tvmaze', 'wikidata'];
// Where to get an API key for each key-based source.
const KEY_URLS = {
  tmdb: 'https://www.themoviedb.org/settings/api',
  omdb: 'https://www.omdbapi.com/apikey.aspx',
  kmdb: 'https://www.kmdb.or.kr/info/api/apiDetail/6',
};

// Per-source API keys persist in the browser (localStorage) — switching the
// source auto-loads that source's saved key; editing the field auto-saves it.
const KEYS_STORE = 'fbw_apikeys';
const LANG_STORE = 'fbw_lang';
function loadKeys() {
  try { return JSON.parse(localStorage.getItem(KEYS_STORE)) || {}; } catch { return {}; }
}
function saveKeys(keys) {
  localStorage.setItem(KEYS_STORE, JSON.stringify(keys));
}
let apiKeys = loadKeys();

function syncSourceUI() {
  const source = $('sourceSelect').value;
  const needsKey = !KEYLESS.includes(source);
  $('apiKeyRow').style.display = needsKey ? 'flex' : 'none';
  if (needsKey) {
    $('apiKey').value = apiKeys[source] || '';
    const link = $('getKeyLink');
    if (KEY_URLS[source]) { link.href = KEY_URLS[source]; link.style.display = 'inline'; }
    else link.style.display = 'none';
  }
}

$('sourceSelect').addEventListener('change', syncSourceUI);

// Auto-save the key against the currently selected source as it's typed.
$('apiKey').addEventListener('input', () => {
  const source = $('sourceSelect').value;
  if (KEYLESS.includes(source)) return;
  apiKeys[source] = $('apiKey').value.trim();
  saveKeys(apiKeys);
});

// Remember the chosen language across sessions.
const savedLang = localStorage.getItem(LANG_STORE);
if (savedLang) $('langSelect').value = savedLang;
$('langSelect').addEventListener('change', () => localStorage.setItem(LANG_STORE, $('langSelect').value));

syncSourceUI();

$('matchBtn').addEventListener('click', async () => {
  if (!scannedFiles.length) return setStatus('matchStatus', '먼저 폴더를 스캔하세요.', 'err');
  const source = $('sourceSelect').value;
  const apiKey = KEYLESS.includes(source) ? '' : (apiKeys[source] || $('apiKey').value.trim());
  const language = $('langSelect').value;
  if (!KEYLESS.includes(source) && !apiKey) return setStatus('matchStatus', '이 데이터소스는 API 키가 필요합니다. 위에 키를 입력하세요.', 'err');
  setStatus('matchStatus', '데이터소스 조회 중…');
  try {
    const data = await api('/api/match', { files: typedFiles(), source, apiKey, language });
    scannedFiles = data.files;
    renderPreviewFromScan();
    setStatus('matchStatus', `${data.matched}/${data.count}개 매칭됨 (${data.source}, ${language}).`, 'ok');
  } catch (e) {
    setStatus('matchStatus', '매칭 실패: ' + e.message, 'err');
  }
});

// ---- Preview ----
$('previewBtn').addEventListener('click', doPreview);

async function doPreview() {
  if (!scannedFiles.length) return setStatus('previewStatus', '먼저 폴더를 스캔하세요.', 'err');
  const format = $('formatStr').value.trim();
  if (!format) return setStatus('previewStatus', '포맷을 입력하세요.', 'err');
  const type = $('presetType').value;
  const files = typedFiles().filter((f) => f.type === type || type === 'any');
  try {
    const data = await api('/api/preview', { files, format, destRoot: $('destRoot').value.trim() });
    previewOps = data.ops;
    renderOps(previewOps.map((o) => ({ ...o, status: o.ok ? 'ready' : 'skipped' })));
    setStatus('previewStatus', `${previewOps.length}개 파일 미리보기 (타입: ${type}).`, 'ok');
  } catch (e) {
    setStatus('previewStatus', '미리보기 실패: ' + e.message, 'err');
  }
}

// ---- Rename ----
$('renameBtn').addEventListener('click', async () => {
  if (!previewOps.length) return setStatus('previewStatus', '먼저 미리보기를 실행하세요.', 'err');
  const action = $('actionSelect').value;
  setStatus('previewStatus', '실행 중…');
  try {
    const data = await api('/api/rename', { ops: previewOps.filter((o) => o.ok), action });
    renderOps(data.results);
    const s = data.summary;
    setStatus('previewStatus', '완료: ' + Object.entries(s).map(([k, v]) => `${k} ${v}`).join(', '), 'ok');
  } catch (e) {
    setStatus('previewStatus', '실행 실패: ' + e.message, 'err');
  }
});

function renderOps(ops) {
  const tbody = $('previewTable').querySelector('tbody');
  tbody.innerHTML = '';
  ops.forEach((o) => {
    const tr = document.createElement('tr');
    const status = o.status || 'ready';
    tr.innerHTML = `<td class="mono">${esc(o.fromName || '')}</td>
      <td class="arrow">→</td>
      <td class="toName">${esc(o.toName || o.to || '')}</td>
      <td><span class="badge ${status}">${status}</span>${o.reason ? ' <span style="color:#9aa3ad">('+esc(o.reason)+')</span>' : ''}</td>`;
    tbody.appendChild(tr);
  });
}

// ---- helpers ----
function setStatus(id, msg, cls = '') {
  const el = $(id);
  el.textContent = msg;
  el.className = 'status ' + cls;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('footerInfo').textContent = 'FileBot WebApp · 로컬 미디어 파일 리네이머';

$('quitBtn').addEventListener('click', async () => {
  if (!confirm('서버를 종료할까요? 이 탭은 더 이상 동작하지 않습니다.')) return;
  try { await fetch('/api/quit', { method: 'POST' }); } catch { /* server exits mid-request */ }
  document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#9aa3ad">서버가 종료되었습니다. 이 탭을 닫으셔도 됩니다.<br>다시 시작하려면 FileBot WebApp 앱을 실행하세요.</div>';
});

loadPresets();
loadFolders();
