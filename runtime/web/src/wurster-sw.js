const owners = new Map();
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'wurster-register-session' || !event.data.sessionId) return;
  const sessionId = String(event.data.sessionId);
  const clientId = event.source?.id ? String(event.source.id) : '';
  if (clientId) owners.set(sessionId, clientId);
  try {
    event.ports?.[0]?.postMessage({
      type: 'wurster-session-registered',
      sessionId,
      ok: Boolean(clientId),
      ...(clientId ? {} : { error: 'Wurster Web session owner is unavailable' })
    });
  } catch {}
});
function route(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const marker = parts.lastIndexOf('__wurster');
  if (marker < 0 || parts.length - marker < 4) return null;
  const [sessionId, scope, ...rest] = parts.slice(marker + 1);
  if (!['app','pigfs','piglink','piglet','machine'].includes(scope)) return null;
  return { sessionId, scope, path: rest.map(decodeURIComponent).join('/') };
}
async function probeClient(client, sessionId) {
  const channel = new MessageChannel();
  const answer = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 350);
    channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(Boolean(event.data?.owns)); };
  });
  try { client.postMessage({ type:'wurster-sw-session-probe', sessionId }, [channel.port2]); } catch { return false; }
  return answer;
}
async function findOwner(sessionId) {
  const remembered = owners.get(sessionId);
  if (remembered) {
    const client = await self.clients.get(remembered);
    if (client) return client;
    owners.delete(sessionId);
  }
  const candidates = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
  for (const client of candidates) {
    if (!await probeClient(client, sessionId)) continue;
    owners.set(sessionId, client.id);
    return client;
  }
  return null;
}
async function askOwner(routeInfo, request) {
  const client = await findOwner(routeInfo.sessionId);
  if (!client) return new Response('Wurster Web session is not connected', { status: 503 });
  const channel = new MessageChannel();
  const answer = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok:false, status:504, error:'Wurster Web source timed out' }), 15000);
    channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data || {}); };
  });
  client.postMessage({ type:'wurster-sw-fetch', ...routeInfo, method:request.method, range:request.headers.get('range') }, [channel.port2]);
  const result = await answer;
  if (!result.ok) return new Response(result.error || 'Wurster Web source error', { status: result.status || 500 });
  return new Response(result.body || null, { status: result.status || 200, headers: result.headers || {} });
}
self.addEventListener('fetch', (event) => {
  const info = route(new URL(event.request.url));
  if (info) event.respondWith(askOwner(info, event.request));
});
