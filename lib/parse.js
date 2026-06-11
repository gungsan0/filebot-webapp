// Filename → metadata extraction, inspired by FileBot's matching heuristics.
// Works offline: everything is derived from the filename itself.

const VIDEO_EXT = new Set([
  'mkv', 'mp4', 'avi', 'mov', 'm4v', 'wmv', 'flv', 'ts', 'm2ts', 'webm', 'mpg', 'mpeg',
]);

const RES_PATTERNS = [
  [/\b(2160p|4k|uhd)\b/i, '2160p'],
  [/\b1080p\b/i, '1080p'],
  [/\b1080i\b/i, '1080i'],
  [/\b720p\b/i, '720p'],
  [/\b576p\b/i, '576p'],
  [/\b480p\b/i, '480p'],
];

const VCODEC_PATTERNS = [
  [/\b(x265|h\.?265|hevc)\b/i, 'HEVC'],
  [/\b(x264|h\.?264|avc)\b/i, 'h264'],
  [/\b(xvid)\b/i, 'XviD'],
  [/\b(av1)\b/i, 'AV1'],
  [/\b(vp9)\b/i, 'VP9'],
];

const ACODEC_PATTERNS = [
  [/\b(e-?ac-?3|ddp|dd\+|eac3)\b/i, 'EAC3'],
  [/\b(ac-?3|dd5\.1|dolby)\b/i, 'AC3'],
  [/\b(dts-?hd|dtshd)\b/i, 'DTS-HD'],
  [/\b(dts)\b/i, 'DTS'],
  [/\b(truehd)\b/i, 'TrueHD'],
  [/\b(flac)\b/i, 'FLAC'],
  [/\b(aac)\b/i, 'AAC'],
  [/\b(mp3)\b/i, 'MP3'],
  [/\b(opus)\b/i, 'Opus'],
];

// Junk tokens commonly found in scene release names.
const JUNK = /\b(bluray|blu-ray|brrip|bdrip|webrip|web-?dl|hdtv|dvdrip|remux|proper|repack|extended|unrated|internal|limited|complete|multi|dual|subbed|dubbed|hdr|hdr10|dv|dolby ?vision|imax|amzn|nf|dsnp|hmax|atvp|hulu|x264|x265|h264|h265|hevc|avc|xvid|av1|vp9|aac|ac3|eac3|ddp|dd5\.1|dts(?:-?hd)?|truehd|flac|mp3|opus|2160p|1080p|1080i|720p|576p|480p|4k|uhd)\b/gi;

function detect(patterns, name) {
  for (const [re, label] of patterns) {
    if (re.test(name)) return label;
  }
  return '';
}

function cleanTitle(raw) {
  let s = raw.replace(/[._]+/g, ' ');
  s = s.replace(JUNK, ' ');
  // Drop trailing release-group / bracket junk.
  s = s.replace(/[\(\[\{].*?[\)\]\}]/g, ' ');
  s = s.replace(/[\(\[\{\)\]\}]/g, ' '); // stray unmatched brackets
  s = s.replace(/-\s*\w+$/g, ' '); // trailing -GROUP
  s = s.replace(/\s{2,}/g, ' ').trim();
  // Title-case lightly without clobbering acronyms.
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 2 && w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Parse a single filename into FileBot-like metadata fields.
export function parseFilename(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const stem = filename.replace(/\.[^.]+$/, '');

  const meta = {
    filename,
    ext,
    isVideo: VIDEO_EXT.has(ext),
    type: 'unknown', // 'movie' | 'episode'
    n: '', // name / title
    y: '', // year
    s: '', // season
    e: '', // episode
    t: '', // episode title
    vf: detect(RES_PATTERNS, stem), // video resolution
    vc: detect(VCODEC_PATTERNS, stem), // video codec
    ac: detect(ACODEC_PATTERNS, stem), // audio codec
  };

  // --- TV episode patterns ---
  // S01E02 / s1e2 / 1x02 / Season 1 Episode 2
  const sxe = stem.match(/\bS(\d{1,2})[\s._-]?E(\d{1,3})\b/i)
    || stem.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (sxe) {
    meta.type = 'episode';
    meta.s = String(parseInt(sxe[1], 10));
    meta.e = String(parseInt(sxe[2], 10));
    const showPart = stem.slice(0, sxe.index);
    meta.n = cleanTitle(showPart);
    // Episode title = text after the SxxExx token, cleaned.
    const after = stem.slice(sxe.index + sxe[0].length);
    meta.t = cleanTitle(after);
    return meta;
  }

  // Episode markers WITHOUT an explicit season — common for Korean dramas and
  // anime: "E01", "EP.01", "Episode 5", "1화", "12회", "제3화". Season defaults
  // to 1 so the show still resolves against a TV datasource.
  const epOnly =
    stem.match(/\bE(?:P|PISODE)?[\s._-]?(\d{1,3})\b/i) ||
    stem.match(/제?\s*(\d{1,3})\s*(?:화|회)/);
  if (epOnly) {
    meta.type = 'episode';
    meta.s = '1';
    meta.e = String(parseInt(epOnly[1], 10));
    meta.n = cleanTitle(stem.slice(0, epOnly.index));
    meta.t = cleanTitle(stem.slice(epOnly.index + epOnly[0].length));
    // If the marker came first (e.g. "제3화 허수아비"), the show name landed in t.
    if (!meta.n && meta.t) {
      meta.n = meta.t;
      meta.t = '';
    }
    return meta;
  }

  // --- Movie pattern: Title (Year) or Title.Year ---
  const yearMatch = stem.match(/[\(\[\.\s_-](19\d{2}|20\d{2})[\)\]\.\s_-]/)
    || stem.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    meta.type = 'movie';
    meta.y = yearMatch[1];
    const idx = stem.indexOf(yearMatch[1]);
    meta.n = cleanTitle(stem.slice(0, idx));
    return meta;
  }

  // Fallback: whole stem as title.
  meta.type = 'movie';
  meta.n = cleanTitle(stem);
  return meta;
}
