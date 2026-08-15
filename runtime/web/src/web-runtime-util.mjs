export function parseRange(value, total) {
  const text = String(value || '').trim();
  const match = text.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2]) || total < 0) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || total === 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) return null;
  end = Math.min(end, total - 1);
  return { offset: start, length: end - start + 1, end };
}

export function mimeFor(path) {
  const ext = String(path).toLowerCase().split('.').pop();
  return ({html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',json:'application/json; charset=utf-8',txt:'text/plain; charset=utf-8',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',wav:'audio/wav',mp3:'audio/mpeg',ogg:'audio/ogg',mp4:'video/mp4',webm:'video/webm',wasm:'application/wasm'})[ext] || 'application/octet-stream';
}

export function normalizeCapabilityDeclaration(input) {
  if (input == null) return {};
  if (Array.isArray(input)) return Object.fromEntries(input.map((name) => [String(name), true]));
  if (typeof input !== 'object') return {};
  return input;
}
