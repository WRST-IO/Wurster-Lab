import { decryptProtectedRange, mimeFor, normalizeWurstPath, openWurstRangeSource, unlockApplicationDataKey } from '@wurster/format';

const te = new TextEncoder();
const td = new TextDecoder();

function parseRange(value, total) {
  if (!value) return null;
  const match = String(value).match(/^bytes=(\d+)-(\d*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) return null;
  const bounded = Math.min(end, total - 1);
  return { offset: start, end: bounded, length: bounded - start + 1 };
}

function escapeHtmlText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '\u003c').replaceAll('>', '\u003e');
}

function bootstrapConfig(world, reader, sessionId) {
  const root = `wurst://runtime/__wurster/${encodeURIComponent(sessionId)}`;
  return {
    sessionId,
    root,
    origin: 'wurst://runtime',
    wurstId: reader.manifest?.id ?? null,
    piglinkEntry: reader.manifest?.piglink?.entry ?? null,
    piglink: reader.manifest?.piglink ?? null,
    parent: world.parent ?? null,
    embedModuleUrl: 'wurst://runtime/wurster-embed.js'
  };
}

function injectBootstrap(html, world, reader, sessionId) {
  const network = Array.isArray(reader.manifest?.capabilities?.network) ? reader.manifest.capabilities.network : [];
  const origin = 'wurst://runtime';
  const csp = `default-src ${origin} data: blob:; script-src ${origin} 'unsafe-inline' blob:; style-src ${origin} 'unsafe-inline' blob:; img-src ${origin} data: blob: ${network.join(' ')}; media-src ${origin} data: blob: ${network.join(' ')}; font-src ${origin} data: blob:; connect-src ${origin} ${network.join(' ')}; object-src 'none'; frame-src ${origin}; base-uri 'none';`;
  const config = bootstrapConfig(world, reader, sessionId);
  const script = `<meta http-equiv="Content-Security-Policy" content="${csp.replaceAll('"', '&quot;')}"><script type="application/json" id="__wurster-frame-config">${escapeHtmlText(JSON.stringify(config))}<\/script><script src="wurst://runtime/wurster-frame-bootstrap.js"><\/script>`;
  return /<head[\s>]/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${script}`) : `${script}${html}`;
}

async function worldReader(world) {
  if (world.routeReader && world.routeReaderSize === world.source.size) return world.routeReader;
  await world.routeReader?.close?.().catch(() => {});
  world.routeReader = await openWurstRangeSource(world.source);
  world.routeReaderSize = world.source.size;
  return world.routeReader;
}

function lockedApplicationError(message = 'WurstKey required for protected embedded application content') {
  const error = new Error(message);
  error.code = 'WURST_APP_LOCKED';
  return error;
}

async function readImmutable(world, reader, entry, offset = 0, length = null) {
  const total = entry.encryption?.plainLength ?? entry.length;
  const bounded = length == null ? total - offset : Math.min(Number(length), total - offset);
  if (entry.encryption) {
    if (!world.routeApplicationKey) throw lockedApplicationError();
    return decryptProtectedRange(entry, async (cipherOffset, cipherLength) => {
      const loaded = await reader.readRange(entry.path, cipherOffset, cipherLength, { verify: true });
      return loaded.data;
    }, world.routeApplicationKey, offset, bounded);
  }
  const loaded = offset === 0 && bounded === entry.length
    ? await reader.read(entry.path, { verify: true })
    : await reader.readRange(entry.path, offset, bounded, { verify: true });
  return loaded.data;
}

async function sealedApplicationMap(world, reader) {
  if (world.routeSealedMap) return world.routeSealedMap;
  if (!world.routeApplicationKey) throw lockedApplicationError();
  const indexPath = reader.manifest?.application?.sealedIndex || '__wurst/sealed-app/index.json';
  const entry = reader.entry(indexPath);
  if (!entry?.encryption) throw new Error('Sealed embedded application index is missing or not protected');
  const data = await readImmutable(world, reader, entry, 0, entry.encryption.plainLength);
  let parsed;
  try { parsed = JSON.parse(td.decode(data)); } catch { throw new Error('Invalid sealed embedded application map'); }
  if (parsed?.format !== 'wurst/sealed-app-map-1' || !Array.isArray(parsed.files) || !parsed.entry) throw new Error('Invalid sealed embedded application map');
  const files = new Map();
  for (const item of parsed.files) {
    const logical = normalizeWurstPath(item.path), resource = normalizeWurstPath(item.resource);
    if (logical.startsWith('__wurst/') || logical.startsWith('data/')) throw new Error('Invalid path in sealed embedded application map');
    const resourceEntry = reader.entry(resource);
    if (!resourceEntry?.encryption || (resourceEntry.scope ?? 'app') !== 'app') throw new Error(`Invalid protected embedded resource: ${resource}`);
    files.set(logical, { entry: resourceEntry, logicalPath: logical, mime: item.mime || mimeFor(logical) });
  }
  world.routeSealedMap = { entry: normalizeWurstPath(parsed.entry), files };
  return world.routeSealedMap;
}

async function applicationResource(world, reader, logicalPath) {
  const path = normalizeWurstPath(logicalPath);
  if (reader.manifest?.application?.protection === 'sealed') {
    const map = await sealedApplicationMap(world, reader);
    return map.files.get(path) || null;
  }
  const entry = reader.entry(path);
  if (!entry || (entry.scope ?? 'app') !== 'app') return null;
  return { entry, logicalPath: path, mime: entry.mime || mimeFor(path) };
}

async function immutableResponse(world, reader, resource, { method = 'GET', range = null, transformHtml = null } = {}) {
  const head = String(method).toUpperCase() === 'HEAD';
  const total = resource.entry.encryption?.plainLength ?? resource.entry.length;
  const parsed = range ? parseRange(range, total) : null;
  if (range && !parsed) return { status: 416, headers: { 'Content-Range': `bytes */${total}` }, body: null };
  const status = parsed ? 206 : 200;
  const headers = {
    'Content-Type': resource.mime || 'application/octet-stream',
    'Content-Length': String(parsed?.length ?? total),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ...(parsed ? { 'Content-Range': `bytes ${parsed.offset}-${parsed.end}/${total}` } : {})
  };
  if (head) return { status, headers, body: null };
  const loaded = await readImmutable(world, reader, resource.entry, parsed?.offset ?? 0, parsed?.length ?? total);
  let data = Buffer.from(loaded ?? []);
  if (transformHtml && String(resource.mime || '').startsWith('text/html')) {
    data = Buffer.from(transformHtml(td.decode(data)));
    headers['Content-Length'] = String(data.length);
    delete headers['Accept-Ranges'];
    delete headers['Content-Range'];
    return { status: 200, headers, body: data };
  }
  return { status, headers, body: data };
}

export async function unlockDesktopPigletApplication(world, wurstKey) {
  if (!world) throw new Error('Unknown Wurst session');
  const reader = await worldReader(world);
  if (!reader.manifest?.security?.applicationKeyWrap) return { unlocked: true, protection: 'public' };
  const nextKey = Buffer.from(unlockApplicationDataKey(reader.manifest, String(wurstKey ?? '')));
  const previous = world.routeApplicationKey ?? null;
  world.routeApplicationKey = nextKey;
  world.routeSealedMap = null;
  try {
    if (reader.manifest?.application?.protection === 'sealed') await sealedApplicationMap(world, reader);
    else {
      const probe = [...reader.entries.values()].find((entry) => (entry.scope ?? 'app') === 'app' && entry.encryption);
      if (probe) await readImmutable(world, reader, probe, 0, Math.min(1, probe.encryption?.plainLength ?? 1));
    }
    previous?.fill?.(0);
    return { unlocked: true, protection: reader.manifest?.application?.protection ?? 'public' };
  } catch (error) {
    nextKey.fill(0);
    world.routeApplicationKey = previous;
    world.routeSealedMap = null;
    throw error;
  }
}

export async function serveDesktopPigletRoute(world, { sessionId, scope, path = '', method = 'GET', range = null } = {}) {
  if (!world) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('Unknown Wurst session') };
  const reader = await worldReader(world);
  const routePath = String(path ?? '');
  try {
    if (scope === 'machine') {
      const html = injectBootstrap('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>', world, reader, sessionId);
      const body = Buffer.from(html);
      return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-store' }, body: String(method).toUpperCase() === 'HEAD' ? null : body };
    }
    if (scope === 'app') {
      const resource = await applicationResource(world, reader, routePath);
      if (!resource) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('Wurst application resource not found') };
      return immutableResponse(world, reader, resource, { method, range, transformHtml: (html) => injectBootstrap(html, world, reader, sessionId) });
    }
    if (scope === 'piglink') {
      const entryPath = reader.manifest?.piglink?.entry;
      const entry = entryPath ? reader.entry(entryPath) : null;
      if (!entry) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('Wurst PigLink resource not found') };
      return immutableResponse(world, reader, { entry, mime: entry.mime || mimeFor(entryPath) }, { method, range });
    }
    if (scope === 'piglet') {
      const id = routePath.replace(/\.wurst$/i, '');
      const child = (reader.manifest?.piglet?.children ?? []).find((item) => item.id === id);
      const entry = child ? reader.entry(child.entry) : null;
      if (!entry) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('Wurst Piglet resource not found') };
      return immutableResponse(world, reader, { entry, mime: entry.mime || 'application/vnd.wrst.wurst' }, { method, range });
    }
    if (scope === 'pigfs') {
      if (!reader.pigFsRoot) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('PigFS is not initialized') };
      const publicPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
      const stat = await reader.pigFsStat(publicPath);
      if (!stat || stat.type !== 'file') return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('PigFS resource not found') };
      const parsed = range ? parseRange(range, stat.size) : null;
      if (range && !parsed) return { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` }, body: null };
      const head = String(method).toUpperCase() === 'HEAD';
      const result = head ? null : await reader.pigFsReadRange(publicPath, parsed?.offset ?? 0, parsed?.length ?? null);
      const body = result ? Buffer.from(result.data ?? result) : null;
      return {
        status: parsed ? 206 : 200,
        headers: {
          'Content-Type': stat.mime || mimeFor(publicPath),
          'Content-Length': String(parsed?.length ?? stat.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          ...(parsed ? { 'Content-Range': `bytes ${parsed.offset}-${parsed.end}/${stat.size}` } : {})
        },
        body
      };
    }
    return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('Unknown Wurster virtual scope') };
  } catch (error) {
    return { status: error?.code === 'WURST_APP_LOCKED' ? 423 : 500, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from(error?.message || String(error)) };
  }
}

export async function closeDesktopPigletRoute(world) {
  await world?.routeReader?.close?.().catch(() => {});
  if (world) {
    world.routeApplicationKey?.fill?.(0);
    world.routeApplicationKey = null;
    world.routeSealedMap = null;
    world.routeReader = null;
    world.routeReaderSize = null;
  }
}
