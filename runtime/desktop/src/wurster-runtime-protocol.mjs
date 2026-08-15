import fs from 'node:fs/promises';
import path from 'node:path';

const RUNTIME_ASSETS = new Map([
  ['wurster-embed.mjs', ['wurster-embed.mjs', 'text/javascript; charset=utf-8']],
  ['wurster-embed.js', ['wurster-embed.js', 'text/javascript; charset=utf-8']],
  ['wurster-embed-host.html', ['wurster-embed-host.html', 'text/html; charset=utf-8']],
  ['wurster-web.mjs', ['wurster.js', 'text/javascript; charset=utf-8']],
  ['wurster.js', ['wurster.js', 'text/javascript; charset=utf-8']],
  ['wurster.min.js', ['wurster.min.js', 'text/javascript; charset=utf-8']],
  ['wurster-sw.js', ['wurster-sw.js', 'text/javascript; charset=utf-8']],
  ['wurster-frame-bootstrap.js', ['wurster-frame-bootstrap.js', 'text/javascript; charset=utf-8']],
  ['trust-data.mjs', ['trust-data.mjs', 'text/javascript; charset=utf-8']]
]);

export function parseWursterVirtualRoute(pathname) {
  const routePath = decodeURIComponent(String(pathname ?? ''));
  const match = routePath.match(/^\/__wurster\/([^/]+)\/(app|pigfs|piglink|piglet|machine)(?:\/(.*))?$/);
  if (!match) return null;
  return { sessionId: match[1], scope: match[2], path: match[3] ?? '' };
}

export async function serveWursterRuntimeRequest(request, { webRuntimeDir, pigletRuntime } = {}) {
  const parsedUrl = new URL(request.url);
  if (parsedUrl.hostname !== 'runtime') return new Response('Unknown Wurster runtime origin', { status: 404 });

  const virtual = parseWursterVirtualRoute(parsedUrl.pathname);
  if (virtual) {
    if (!pigletRuntime) return new Response('Wurster Piglet runtime is not ready', { status: 503 });
    const result = await pigletRuntime.serveVirtualRoute(virtual.sessionId, {
      scope: virtual.scope,
      path: virtual.path,
      method: request.method,
      range: request.headers.get('range')
    });
    return new Response(result.body ?? null, { status: result.status, headers: result.headers });
  }

  const routePath = decodeURIComponent(parsedUrl.pathname);
  if (routePath.startsWith('/__wurster/')) return new Response('Unknown Wurster virtual route', { status: 404 });
  const requested = routePath.replace(/^\/+/, '');
  const asset = RUNTIME_ASSETS.get(requested);
  if (!asset) return new Response('Wurster runtime asset not found', { status: 404 });
  const data = await fs.readFile(path.join(webRuntimeDir, asset[0]));
  return new Response(data, {
    status: 200,
    headers: { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}
