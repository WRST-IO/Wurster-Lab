import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SIGNATURE_PATH, createPackageSignature, createPublisherKeyBundle, decodeWurst, descriptorsFromPackage, encodeWurst, openLocalWurstFsStore, openWurstFile, verifyPackageSignature } from '../packages/format/src/index.js';
import { bindPigletWurstFsPersistence } from '../runtime/desktop/src/piglet-wurstfs-runtime.mjs';
import { createTrustedSurfaceRuntime } from '../runtime/desktop/src/trusted-surface-runtime.mjs';

function writableChild() {
  const unsigned = decodeWurst(encodeWurst({
    manifest: {
      format: 'wurst/7', id: 'io.wrst.piglet-operational', name: 'Operational Piglet', version: '0.32.0', entry: 'index.html', type: 'widget',
      application: { protection: 'public' }, capabilities: {}, security: { signed: true },
      data: { format: 'wurst/data-realms-1', writable: true, realms: [{ id: 'files' }] }
    },
    files: [{ path: 'index.html', data: Buffer.from('<h1>Piglet</h1>'), scope: 'app', mime: 'text/html' }]
  }));
  const phrase = 'smoked-bacon peppered-brisket cured-ham grilled-rib charred-steak mustard-pork hickory-wurst iron-chop maple-salami crispy-roast ember-belly garlic-jerky';
  const publisher = createPublisherKeyBundle({ email: 'piglet-child@example.com', meatphrase: phrase });
  const signature = createPackageSignature(unsigned, publisher.bundle, phrase);
  return encodeWurst({
    manifest: unsigned.manifest,
    files: [
      ...descriptorsFromPackage(unsigned).filter((file) => file.path !== SIGNATURE_PATH),
      { path: SIGNATURE_PATH, data: Buffer.from(JSON.stringify(signature)), scope: 'signature', mime: 'application/json; charset=utf-8' }
    ]
  });
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-piglet-operational-'));
try {
  const original = writableChild();
  const originalSignature = verifyPackageSignature(decodeWurst(original));
  assert.equal(originalSignature.status, 'signed');
  assert.equal(originalSignature.publisher.email, 'piglet-child@example.com');
  const running = path.join(temp, 'child.wurst');
  await fs.writeFile(running, original);
  let persisted = null;
  let flushes = 0;
  let reader = await openWurstFile(running);
  const immutableLength = reader.baseLength;
  let store = bindPigletWurstFsPersistence(await openLocalWurstFsStore(running, reader), {
    async flush() { persisted = await fs.readFile(running); flushes += 1; }
  });
  await store.initialize({ realms: [{ id: 'files' }] });
  const write = store.beginWrite('/data/files/state.json', { mime: 'application/json' });
  await store.writeChunk(write, Buffer.from('{"counter":1}'));
  await store.commitWrite(write);
  await store.closeFile();
  await reader.close();

  assert.ok(flushes >= 2, 'initialization and child writes must cross the persistence boundary');
  assert.ok(persisted?.length > original.length, 'child WurstFS must append mutable state to the child Wurst bytes');
  assert.deepEqual(persisted.subarray(0, immutableLength), original.subarray(0, immutableLength), 'Piglet writes must not rewrite immutable application bytes');

  const reopened = path.join(temp, 'reopened.wurst');
  await fs.writeFile(reopened, persisted);
  reader = await openWurstFile(reopened);
  const persistedSignature = await import('../packages/format/src/index.js').then(({ decodeWurst, verifyPackageSignature }) => verifyPackageSignature(decodeWurst(persisted)));
  assert.equal(persistedSignature.status, 'signed', 'mutable child WurstFS writes must preserve the child package signature');
  assert.equal(persistedSignature.publisher.fingerprint, originalSignature.publisher.fingerprint, 'mutable child writes must preserve publisher identity');
  const state = await reader.fsReadRange('/data/files/state.json');
  assert.equal(Buffer.from(state.data).toString('utf8'), '{"counter":1}', 'Piglet state must survive close/reopen as normal WurstFS data');
  await reader.close();
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

class MockIpc {
  listeners = new Map();
  handles = new Map();
  on(name, fn) { this.listeners.set(name, fn); }
  handle(name, fn) { this.handles.set(name, fn); }
}

const ipcMain = new MockIpc();
let nextViewId = 100;
const views = [];
function makeView() {
  let bounds = null;
  const webContents = {
    id: nextViewId++,
    isDestroyed: () => false,
    setWindowOpenHandler() {}, on() {}, close() {},
    async loadFile() {}, send() {}
  };
  const view = { webContents, setBounds(value) { bounds = { ...value }; }, getBounds: () => bounds, setBackgroundColor() {} };
  views.push(view);
  return view;
}
const host = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} } };
const sent = new Map();
const parentRenderer = { id: 1, isDestroyed: () => false, send: (...args) => sent.set('parent', args) };
const childRenderer = { id: 2, isDestroyed: () => false, send: (...args) => sent.set('child', args) };
const parent = { runtimeBinding: 'parent', manifest: { id: 'parent', name: 'Parent', version: '1' } };
const child = { runtimeBinding: 'child', manifest: { id: 'child', name: 'Child', version: '1' } };
const contexts = new Map([[1, parent], [2, child]]);
const trusted = createTrustedSurfaceRuntime({
  ipcMain,
  createView: () => makeView(),
  getHostWindow: () => host,
  getRuntimeRenderer: (context) => context === parent ? parentRenderer : childRenderer,
  getRuntimeViewport: (context) => context === parent ? { x: 0, y: 0, width: 800, height: 600 } : { x: 120, y: 90, width: 420, height: 300 },
  assertWurstSender: (event) => contexts.get(event.sender.id),
  authControlPreload: '/auth-preload', authControlHtml: '/auth.html',
  identityControlPreload: '/identity-preload', identityControlHtml: '/identity.html',
  secureTrustPresentation: () => ({ kind: 'test' }), showIdentityVerificationForContext: async () => true
});
const anchor = [{ id: 'login', visible: true, type: 'identity', purpose: 'identity', x: 10, y: 10, width: 220, height: 60 }];
ipcMain.listeners.get('wurst:auth:anchors')({ sender: parentRenderer }, anchor);
ipcMain.listeners.get('wurst:auth:anchors')({ sender: childRenderer }, anchor);
assert.equal(views.length, 2, 'parent and child may own the same auth anchor id without collision');
const parentSurface = trusted.authSurfaceForEvent({ sender: views[0].webContents });
const childSurface = trusted.authSurfaceForEvent({ sender: views[1].webContents });
assert.equal(parentSurface.context, parent);
assert.equal(childSurface.context, child);
assert.deepEqual(views[1].getBounds(), { x: 130, y: 100, width: 220, height: 60 }, 'trusted child auth UI must be positioned inside the child surface viewport');
trusted.sendAuthResultToWurst(childSurface, true, { identity: { id: 'alice' } });
assert.equal(sent.has('parent'), false, 'child auth results must never be routed through the parent renderer');
assert.equal(sent.get('child')[0], 'wurst:auth:result');
trusted.cleanupContext(child);
assert.throws(() => trusted.authSurfaceForEvent({ sender: views[1].webContents }), /Invalid Wurster Auth surface/);

console.log('✓ Piglet child WurstFS persists across reopen and trusted Auth stays bound to the child runtime surface');
