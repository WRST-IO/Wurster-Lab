import { app, BrowserWindow, protocol, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWurst } from '../packages/format/src/index.js';
import { serveDesktopPigletRoute, closeDesktopPigletRoute } from '../runtime/desktop/src/piglet-route-runtime.mjs';
import { serveWursterRuntimeRequest } from '../runtime/desktop/src/wurster-runtime-protocol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB_DIST = path.join(ROOT, 'runtime', 'web', 'dist');
const SESSION_ID = 'electron-smoke';

protocol.registerSchemesAsPrivileged([{
  scheme: 'wurst',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    allowServiceWorkers: true,
    corsEnabled: false,
    stream: true
  }
}]);

const childBytes = encodeWurst({
  manifest: {
    format: 'wurst/7',
    id: 'io.wrst.electron-route-smoke',
    name: 'Electron Piglet Route Smoke',
    version: '1.0.0',
    entry: 'index.html',
    application: { protection: 'public' },
    capabilities: []
  },
  files: [
    {
      path: 'index.html',
      scope: 'app',
      mime: 'text/html; charset=utf-8',
      data: Buffer.from('<!doctype html><html><head></head><body><h1 id="child">electron-oink</h1><script src="./child.js"></script></body></html>')
    },
    {
      path: 'child.js',
      scope: 'app',
      mime: 'text/javascript; charset=utf-8',
      data: Buffer.from('globalThis.__wursterElectronPigletSmoke = "rendered";')
    }
  ]
});

const world = {
  parent: { isolated: true },
  source: {
    size: childBytes.length,
    async read(offset, length) { return Buffer.from(childBytes.subarray(offset, offset + length)); }
  }
};

async function run() {
  await app.whenReady();
  const runtimeSession = session.defaultSession;
  if (runtimeSession.protocol.isProtocolHandled('wurst')) runtimeSession.protocol.unhandle('wurst');
  const virtualRequests = [];
  const pigletRuntime = {
    async serveVirtualRoute(sessionId, request) {
      virtualRequests.push({ sessionId, ...request });
      return serveDesktopPigletRoute(world, { ...request, sessionId });
    }
  };
  runtimeSession.protocol.handle('wurst', (request) => serveWursterRuntimeRequest(request, {
    webRuntimeDir: WEB_DIST,
    pigletRuntime
  }));

  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });

  // Load the real Desktop embed host on Electron's real custom protocol. The
  // test records ServiceWorker state but never fakes controller ownership.
  await win.loadURL('wurst://runtime/wurster-embed-host.html');
  const host = await win.webContents.executeJavaScript(`({
    href: location.href,
    hasServiceWorker: Boolean(navigator.serviceWorker),
    controlled: Boolean(navigator.serviceWorker?.controller),
    boot: document.querySelector('#boot')?.textContent || null
  })`);
  if (host.href !== 'wurst://runtime/wurster-embed-host.html') throw new Error(`Unexpected embed host URL: ${host.href}`);

  // Drive the real embed host through its MessagePort source bridge. WursterWeb
  // must mount the child iframe directly on the Desktop protocol route. This
  // covers host -> WursterWeb -> __wurster/session/app/index.html without a
  // mocked navigator.serviceWorker or a top-level shortcut navigation.
  const base64 = childBytes.toString('base64');
  const embedded = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const raw = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const channel = new MessageChannel();
    const port = channel.port1;
    const timer = setTimeout(() => reject(new Error('Timed out waiting for real Desktop embed host')), 8000);
    port.onmessage = (event) => {
      const m = event.data || {};
      if (m.type === 'wurster-source-read') {
        const start = Number(m.position), length = Number(m.length);
        const data = bytes.slice(start, start + length).buffer;
        port.postMessage({ type: 'wurster-source-result', id: m.id, ok: true, data }, [data]);
        return;
      }
      if (m.type === 'wurster-embed-ready') {
        clearTimeout(timer);
        resolve({ ready: true, detail: m.detail || null });
        return;
      }
      if (m.type === 'wurster-embed-error') {
        clearTimeout(timer);
        reject(new Error(m.error || 'Desktop embed host failed'));
      }
    };
    port.start();
    window.postMessage({
      type: 'wurster-embed-init',
      size: bytes.length,
      sourceKind: 'electron-smoke',
      parent: { isolated: true },
      session: { id: ${JSON.stringify(SESSION_ID)}, format: 'wurst/runtime-session-1', revision: 0 }
    }, '*', [channel.port2]);
  })`);
  if (!embedded.ready || embedded.detail?.manifest?.id !== 'io.wrst.electron-route-smoke') {
    throw new Error(`Desktop embed host did not open child Wurst: ${JSON.stringify(embedded)}`);
  }

  const appRequest = virtualRequests.find((item) => item.sessionId === SESSION_ID && item.scope === 'app' && item.path === 'index.html');
  if (!appRequest) throw new Error(`Desktop embed host never requested child app/index.html: ${JSON.stringify(virtualRequests)}`);
  const scriptRequest = virtualRequests.find((item) => item.sessionId === SESSION_ID && item.scope === 'app' && item.path === 'child.js');
  if (!scriptRequest) throw new Error(`Desktop child app never requested child.js: ${JSON.stringify(virtualRequests)}`);

  console.log(`✓ Electron Desktop embed host rendered Piglet through direct protocol routing (serviceWorkerController=${host.controlled})`);
  win.destroy();
  await closeDesktopPigletRoute(world);
  runtimeSession.protocol.unhandle('wurst');
}

let exitCode = 0;
try {
  await run();
} catch (error) {
  exitCode = 1;
  console.error(error?.stack || error);
}
app.exit(exitCode);
