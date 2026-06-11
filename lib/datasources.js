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

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'filebot-webapp' } });
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
