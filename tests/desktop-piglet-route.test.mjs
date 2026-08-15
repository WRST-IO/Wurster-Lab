import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { encodeWurst, sealApplicationFiles } from '../packages/format/src/index.js';
import { serveDesktopPigletRoute, closeDesktopPigletRoute, unlockDesktopPigletApplication } from '../runtime/desktop/src/piglet-route-runtime.mjs';
import { serveWursterRuntimeRequest } from '../runtime/desktop/src/wurster-runtime-protocol.mjs';
import { WursterWebSession } from '../runtime/web/src/wurster-web.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.MessageChannel) globalThis.MessageChannel = MessageChannel;

const desktopMain = await fs.readFile(new URL('../runtime/desktop/src/main.mjs', import.meta.url), 'utf8');
assert.match(desktopMain, /serveWursterRuntimeRequest/);
assert.doesNotMatch(desktopMain, /virtual route is waiting for Service Worker control/);

Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: { origin: 'wurst://runtime', href: 'wurst://runtime/wurster-embed-host.html' }
});
// Desktop virtual routing must not require ServiceWorker presence at all.
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const timeline = [];
let frameLoad;
const frame = {
  attributes: new Map(),
  style: {},
  contentWindow: {},
  setAttribute(name, value) { this.attributes.set(name, value); },
  addEventListener(name, listener) { if (name === 'load') frameLoad = listener; },
  set src(value) {
    this._src = value;
    timeline.push(`navigate:${value}`);
    queueMicrotask(() => frameLoad?.());
  },
  get src() { return this._src; }
};
globalThis.document = { createElement(tag) { assert.equal(tag, 'iframe'); return frame; } };

const manifest = {
  format: 'wurst/7',
  id: 'io.wrst.desktop-piglet-route',
  name: 'Desktop Piglet Route',
  version: '1.0.0',
  entry: 'index.html',
  application: { protection: 'public' },
  capabilities: []
};
const bytes = encodeWurst({
  manifest,
  files: [
    { path: 'index.html', scope: 'app', mime: 'text/html; charset=utf-8', data: Buffer.from('<!doctype html><html><head></head><body><h1 id="child">flappy-oink</h1><script src="./child.js"></script></body></html>') },
    { path: 'child.js', scope: 'app', mime: 'text/javascript; charset=utf-8', data: Buffer.from('globalThis.__childRendered = true;') }
  ]
});

const session = await WursterWebSession.open(new Blob([bytes]), {
  sessionId: 'desktop-child-session',
  desktopVirtualRoutes: true
});
const target = {
  child: null,
  replaceChildren(node) { this.child = node; timeline.push('mounted'); }
};

await session.mount(target);
assert.equal(target.child, frame);
assert.equal(frame.src, 'wurst://runtime/__wurster/desktop-child-session/app/index.html');
assert.deepEqual(timeline, [
  'navigate:wurst://runtime/__wurster/desktop-child-session/app/index.html',
  'mounted'
]);

// Exercise the actual Desktop resource layer, not WursterWeb's browser-only SW
// responder. This is the deterministic path Electron's custom protocol calls.
const source = {
  size: bytes.length,
  async read(offset, length) { return Buffer.from(bytes.subarray(offset, offset + length)); }
};
const world = { source, parent: { isolated: true } };
const response = await serveWursterRuntimeRequest(new Request(
  'wurst://runtime/__wurster/desktop-child-session/app/index.html'
), {
  webRuntimeDir: '.',
  pigletRuntime: {
    serveVirtualRoute: (_sessionId, request) => serveDesktopPigletRoute(world, { ...request, sessionId: 'desktop-child-session' })
  }
});
assert.equal(response.status, 200);
const html = await response.text();
assert.match(html, /flappy-oink/);
assert.match(html, /__wurster-frame-config/);
assert.match(html, /wurst:\/\/runtime\/wurster-frame-bootstrap\.js/);

const script = await serveDesktopPigletRoute(world, {
  sessionId: 'desktop-child-session',
  scope: 'app',
  path: 'child.js',
  method: 'GET'
});
assert.equal(script.status, 200);
assert.equal(Buffer.from(script.body).toString('utf8'), 'globalThis.__childRendered = true;');

await closeDesktopPigletRoute(world);
await session.fs.dispose();

// Direct Desktop routing must retain the existing WurstKey protection boundary.
// The trusted embed host unlocks the running Child world; the application frame
// still receives only decrypted resources, never the WurstKey itself.
const protectedKey = 'wurstkey-v1-1DPX-T3YW-RW31-7EQA-7VR2-KR78-32SB-Y3ZM-SRV0-C88K-RQV3-F6GH-X3NS';
const sealedMapPath = '__wurst/sealed-app/index.json';
const protectedManifest = {
  format: 'wurst/7', id: 'io.wrst.desktop-protected-child', name: 'Protected Desktop Child', version: '1.0.0', entry: null,
  application: { protection: 'sealed', sealedIndex: sealedMapPath }, security: { signed: false }, capabilities: []
};
const protectedMap = {
  format: 'wurst/sealed-app-map-1', entry: 'index.html', files: [
    { path: 'index.html', resource: '__wurst/sealed-app/r000000.wres', mime: 'text/html; charset=utf-8' },
    { path: 'secret.js', resource: '__wurst/sealed-app/r000001.wres', mime: 'text/javascript; charset=utf-8' }
  ]
};
const protectedBytes = encodeWurst(sealApplicationFiles({ manifest: protectedManifest, wurstKey: protectedKey, files: [
  { path: '__wurst/sealed-app/r000000.wres', data: Buffer.from('<!doctype html><script src="./secret.js"></script><h1>protected-oink</h1>'), mime: 'application/octet-stream', scope: 'app', sealed: true },
  { path: '__wurst/sealed-app/r000001.wres', data: Buffer.from('globalThis.__protectedPiglet = true;'), mime: 'application/octet-stream', scope: 'app', sealed: true },
  { path: sealedMapPath, data: Buffer.from(JSON.stringify(protectedMap)), mime: 'application/octet-stream', scope: 'app', sealed: true }
]}));
const protectedWorld = {
  source: { size: protectedBytes.length, async read(offset, length) { return Buffer.from(protectedBytes.subarray(offset, offset + length)); } },
  parent: { isolated: true }
};
const locked = await serveDesktopPigletRoute(protectedWorld, { sessionId: 'protected-child', scope: 'app', path: 'index.html' });
assert.equal(locked.status, 423);
await assert.rejects(() => unlockDesktopPigletApplication(protectedWorld, 'wurstkey-v1-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000'), /authentication|Wrong WurstKey|protected/i);
await unlockDesktopPigletApplication(protectedWorld, protectedKey);
const protectedHtml = await serveDesktopPigletRoute(protectedWorld, { sessionId: 'protected-child', scope: 'app', path: 'index.html' });
assert.equal(protectedHtml.status, 200);
assert.match(Buffer.from(protectedHtml.body).toString('utf8'), /protected-oink/);
const protectedJs = await serveDesktopPigletRoute(protectedWorld, { sessionId: 'protected-child', scope: 'app', path: 'secret.js' });
assert.equal(protectedJs.status, 200);
assert.match(Buffer.from(protectedJs.body).toString('utf8'), /__protectedPiglet/);
await closeDesktopPigletRoute(protectedWorld);
assert.equal(protectedWorld.routeApplicationKey, null);

console.log('✓ Desktop Piglet virtual routes bypass Service Workers, serve real child resources and preserve WurstKey-protected Child routing');
