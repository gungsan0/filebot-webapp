// FileBot-style format string engine.
// Supports tokens like {n}, {y}, {s}, {e}, {t}, {vf}, {vc}, {ac}
// and chained methods: {s.pad(2)}, {n.upper()}, {n.lower()},
// {t.replace('a','b')}, {n.space('.')}.
// A whole {…} group that evaluates to empty is dropped, and any
// orphaned separators / empty brackets it leaves behind are cleaned up.

const METHODS = {
  pad: (val, n) => String(val).padStart(parseInt(n, 10) || 2, '0'),
  upper: (val) => String(val).toUpperCase(),
  lower: (val) => String(val).toLowerCase(),
  space: (val, ch) => String(val).replace(/\s+/g, ch ?? '.'),
  replace: (val, a, b) => String(val).split(a).join(b ?? ''),
};

function applyMethod(value, call) {
  const m = call.match(/^(\w+)\((.*)\)$/);
  if (!m) return value;
  const name = m[1];
  const args = m[2]
    .split(',')
    .map((a) => a.trim().replace(/^['"]|['"]$/g, ''))
    .filter((a) => a !== '');
  const fn = METHODS[name];
  return fn ? fn(value, ...args) : value;
}

// Evaluate a single {…} expression against the metadata object.
function evalToken(expr, meta) {
  const parts = expr.split('.');
  const key = parts[0].trim();
  let value = meta[key];
  if (value === undefined || value === null || value === '') return '';
  for (let i = 1; i < parts.length; i++) {
    value = applyMethod(value, parts[i].trim());
  }
  return String(value);
}

// Render a format string for one metadata object.
export function formatName(template, meta) {
  let out = template.replace(/\{([^{}]+)\}/g, (_, expr) => {
    try {
      return evalToken(expr, meta);
    } catch {
      return '';
    }
  });

  // Clean up artifacts left by empty tokens.
  out = out
    .replace(/\[\s*(?:,\s*)*\]/g, '') // empty [ ] or [, , ]
    .replace(/\(\s*\)/g, '') // empty ( )
    .replace(/,\s*,/g, ',') // double commas
    .replace(/\[\s*,/g, '[') // leading comma in bracket
    .replace(/,\s*\]/g, ']') // trailing comma in bracket
    .replace(/\s{2,}/g, ' ') // collapse spaces
    .replace(/ +\//g, '/') // space before slash
    .replace(/\/ +/g, '/') // space after slash
    .replace(/\/{2,}/g, '/') // double slashes
    .replace(/[ \-]+$/g, '') // trailing dash/space per segment end
    .trim();

  // Trim stray separators on each path segment.
  out = out
    .split('/')
    .map((seg) => seg.replace(/^[\s\-]+|[\s\-]+$/g, '').trim())
    .join('/');

  return out;
}

// Characters illegal in file names on macOS/most filesystems → replaced.
export function sanitizePath(p) {
  return p
    .split('/')
    .map((seg) => seg.replace(/[:*?"<>|]/g, '').trim())
    .join('/');
}
