import crypto from 'node:crypto';
import { networkOrigins, normalizeCapabilities } from '@wurster/format';

export function safeRequestPath(rawUrl, manifest) {
  const url = new URL(rawUrl);
  if (url.hostname !== 'app') throw new Error('Unknown Wurst host');
  const candidate = decodeURIComponent(url.pathname.replace(/^\//, '')) || manifest.entry;
  if (!candidate || typeof candidate !== 'string') throw new Error('Wurst request has no public path');
  if (candidate.startsWith('__wurst/') || candidate.startsWith('data/')) {
    throw new Error('Private Wurst data is not web-addressable');
  }
  return candidate;
}

export function cspFor(manifest) {
  const allowedNetwork = networkOrigins(manifest);
  const capabilities = normalizeCapabilities(manifest.capabilities);
  const connect = allowedNetwork.length ? allowedNetwork.join(' ') : "'none'";
  const scripts = capabilities['code.unsafeEval'] ? "'self' wurst://piglink wurst://runtime 'unsafe-eval'" : "'self' wurst://piglink wurst://runtime";
  return [
    "default-src 'self' data: blob:",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' wurst://pigfs data: blob:",
    "font-src 'self' wurst://pigfs data: blob:",
    "media-src 'self' wurst://pigfs data: blob:",
    "worker-src 'self' blob:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src wurst://runtime",
    "form-action 'none'"
  ].join('; ');
}

export function responseFor(entry, manifest, data = entry.data, range = null) {
  const headers = {
    'Content-Type': entry.mime,
    'Content-Security-Policy': cspFor(manifest),
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), usb=(), serial=(), hid=(), fullscreen=()',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(data.length)
  };
  if (range) headers['Content-Range'] = `bytes ${range.offset}-${range.offset + data.length - 1}/${range.total}`;
  return new Response(data, { status: range ? 206 : 200, headers });
}

export function parseHttpRange(value, total) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value).trim());
  if (!match) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? total - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) return null;
  end = Math.min(end, total - 1);
  return { offset: start, length: end - start + 1, total };
}

export function partitionFor(manifest, instanceKey = null) {
  const identity = instanceKey == null ? String(manifest.id) : `${manifest.id}\0${String(instanceKey)}`;
  const id = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const capabilities = normalizeCapabilities(manifest.capabilities);
  return capabilities['storage.local'] ? `persist:wurst-${id}` : `wurst-${id}-${crypto.randomUUID()}`;
}

export function networkRequestAllowed(rawUrl, manifest) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'wurst:' || url.protocol === 'data:' || url.protocol === 'blob:') return true;
    if (url.protocol !== 'https:') return false;
    return networkOrigins(manifest).includes(url.origin);
  } catch {
    return false;
  }
}
