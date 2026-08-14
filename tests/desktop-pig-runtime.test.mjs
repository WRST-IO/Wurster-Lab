import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeWurst, sha256 } from '../packages/format/src/index.js';
import { createDesktopPigLinkRuntime, loadPigLinkEntry } from '../runtime/desktop/src/piglink-runtime.mjs';
import { createDesktopPigletRuntime, loadPigletResource } from '../runtime/desktop/src/piglet-runtime.mjs';
import { createPigletSurfaceManager } from '../runtime/desktop/src/piglet-surface-runtime.mjs';
import { createPigletStorageAdapter } from '../runtime/desktop/src/piglet-storage-runtime.mjs';
import { createDesktopPigstyRuntime } from '../runtime/desktop/src/pigsty-runtime.mjs';

class MockIpc {
  handles = new Map();
  listeners = new Map();
  handle(name, fn) { this.handles.set(name, fn); }
  on(name, fn) { this.listeners.set(name, fn); }
}

const pigletBytes = encodeWurst({
  manifest: { format: 'wurst/7', id: 'io.wrst.child', name: 'Child Wurst', version: '0.32.0', entry: 'index.html' },
  files: [{ path: 'index.html', data: Buffer.from('<h1>Child</h1>'), scope: 'app', mime: 'text/html; charset=utf-8' }]
});
const childDigest = sha256(pigletBytes);
const pigLinkBytes = Buffer.from('PigLink.define({ actions: {} });');
const context = {
  manifest: {
    id: 'io.wrst.parent',
    capabilities: { piglet: true },
    piglet: {
      format: 'wurst/piglet-1',
      children: [{ id: 'child', entry: '__wurst/piglet/child.wurst', sha256: childDigest }]
    },
    piglink: {
      entry: '__wurst/piglink/entry.js',
      actions: { echo: { timeoutMs: 1000, input: { type: 'object' }, output: { type: 'object' } } },
      events: {}
    },
    pigsty: { format: 'wurst/pigsty-1', version: 'node-lts-1', builds: { site: { source: 'build.js', outputs: ['dist'] } } }
  },
  reader: {
    entry(name) {
      if (name === '__wurst/piglet/child.wurst') return { scope: 'piglet', encryption: null, length: pigletBytes.length };
      if (name === '__wurst/piglink/entry.js') return { scope: 'piglink', encryption: null };
      return null;
    },
    async read(name) {
      if (name === '__wurst/piglet/child.wurst') return { data: pigletBytes };
      if (name === '__wurst/piglink/entry.js') return { data: pigLinkBytes };
      return null;
    },
    async readRange(name, offset, length) {
      if (name !== '__wurst/piglet/child.wurst') return null;
      return { data: pigletBytes.subarray(offset, offset + length) };
    },
    entries() { return []; }
  }
};

const assertWurstSender = () => context;
const pigletIpc = new MockIpc();
const installed = [];
const storage = {
  async discover() { return installed; },
  async openSource(_context, storedPath) {
    const item = installed.find((candidate) => candidate.path === storedPath || candidate.ref === `wurstfs:${storedPath}`);
    if (!item) throw new Error('missing stored piglet');
    return { size: pigletBytes.length, async read(offset, length) { return pigletBytes.subarray(offset, offset + length); } };
  },
  async readFile(_context, storedPath) {
    const item = installed.find((candidate) => candidate.path === storedPath || candidate.ref === `wurstfs:${storedPath}`);
    if (!item) throw new Error('missing stored piglet');
    return pigletBytes;
  },
  async install(_context, bytes, options) {
    assert.equal(sha256(bytes), childDigest, 'Piglet installation must receive exact child bytes');
    const descriptor = {
      ref: 'wurstfs:/data/workspace/piglets/Child.wurst',
      id: '/data/workspace/piglets/Child.wurst',
      label: 'Child Wurst',
      source: 'wurstfs',
      path: '/data/workspace/piglets/Child.wurst',
      mutable: true,
      bytes: bytes.length,
      sha256: sha256(bytes),
      application: { id: 'io.wrst.child', name: 'Child Wurst', version: '0.32.0' },
      signature: { status: 'unsigned', publisher: null, error: null },
      installName: options.name
    };
    installed.push(descriptor);
    return descriptor;
  },
  async remove() { installed.length = 0; return true; }
};
const opened = [];
const surfaces = {
  async open(_context, descriptor, source, options) {
    const bytes = await source.read(0, source.size);
    assert.equal(sha256(bytes), childDigest);
    const surface = { handle: `surface-${opened.length + 1}`, ref: descriptor.ref, bounds: options.bounds ?? null };
    opened.push(surface);
    return surface;
  },
  list() { return [...opened]; },
  setBounds(_context, handle, bounds) { return { handle, bounds }; },
  focus(_context, handle) { return { handle, focused: true }; },
  async close() { return true; },
  async closeContext() {},
  async closeChildContext() { return true; },
  layoutFillSurfaces() {}
};
const pigletRuntime = createDesktopPigletRuntime({
  ipcMain: pigletIpc,
  assertWurstSender,
  assertCapability: (_context, name) => assert.equal(name, 'piglet'),
  storage,
  surfaces
});

const builtinChildren = await pigletIpc.handles.get('wurst:piglet:children')({});
assert.deepEqual(builtinChildren.map((item) => item.ref), ['builtin:child']);
assert.equal(builtinChildren[0].application.id, 'io.wrst.child');
assert.equal(builtinChildren[0].signature.status, 'unsigned');
assert.equal(await pigletIpc.handles.get('wurst:piglet:url')({}, 'builtin:child'), 'wurst://piglet/child.wurst');
assert.deepEqual((await loadPigletResource(context, 'child')).data, pigletBytes);

const installedChild = await pigletIpc.handles.get('wurst:piglet:install')({}, 'Child.wurst', pigletBytes, {});
assert.equal(installedChild.source, 'wurstfs');
const allChildren = await pigletRuntime.list(context);
assert.deepEqual(allChildren.map((item) => item.source), ['builtin', 'wurstfs']);
assert.equal(await pigletIpc.handles.get('wurst:piglet:url')({}, installedChild.ref), 'wurst://data/workspace/piglets/Child.wurst');
const openedSurface = await pigletIpc.handles.get('wurst:piglet:open')({}, installedChild.ref, { bounds: { x: 10, y: 20, width: 320, height: 200 } });
assert.equal(openedSurface.handle, 'surface-1');
assert.deepEqual((await pigletIpc.handles.get('wurst:piglet:surfaces')({})).map((item) => item.handle), ['surface-1']);
assert.equal(await pigletIpc.handles.get('wurst:piglet:remove')({}, installedChild.ref), true);

let attachedView = null;
const boundContexts = new Map();
const hostWindow = {
  isDestroyed: () => false,
  getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  contentView: {
    addChildView(view) { attachedView = view; },
    removeChildView(view) { if (attachedView === view) attachedView = null; }
  }
};
function mockView() {
  let bounds = { x: 0, y: 0, width: 1, height: 1 };
  let focused = false;
  let closed = false;
  const webContents = {
    id: 77,
    setWindowOpenHandler() {},
    on() {},
    async loadURL(url) { assert.equal(url, 'wurst://app/index.html'); },
    isDestroyed: () => closed,
    isFocused: () => focused,
    focus() { focused = true; },
    close() { closed = true; }
  };
  return { webContents, setBounds(value) { bounds = { ...value }; }, getBounds: () => ({ ...bounds }) };
}
const surfaceManager = createPigletSurfaceManager({
  getHostWindow: () => hostWindow,
  createView: () => mockView(),
  sessionForChild: (_manifest, key) => ({ key }),
  configureSession: (_session, childContext) => assert.equal(childContext.readOnlyPackage, false),
  authorizePackage: async () => ({ publisherTrust: { kind: 'unsigned' } }),
  bindContext: (webContents, childContext) => boundContexts.set(webContents.id, childContext),
  unbindContext: (webContents) => boundContexts.delete(webContents.id),
  preload: '/mock/wurst-preload.cjs',
  storage: {
    async prepareRuntimeSource(_context, _descriptor, source) { return { source, path: null, expectedSha256: childDigest, materializedFrom: 'builtin:child' }; },
    async fingerprintRuntimeSource() { return childDigest; },
    async persistRuntimeSource() { throw new Error('unexpected persistence'); }
  },
  loadSealedBootstrap: async () => '<html></html>',
  destroyProtectionHandle: async () => false,
  cleanupContextUi: () => {},
  layoutContextUi: () => {}
});
const realSurface = await surfaceManager.open(context, {
  ref: 'builtin:child',
  application: { id: 'io.wrst.child', name: 'Child Wurst', version: '0.32.0' },
  signature: { status: 'unsigned' }
}, { size: pigletBytes.length, async read(offset, length) { return pigletBytes.subarray(offset, offset + length); } }, { bounds: { x: 50, y: 60, width: 400, height: 300 } });
assert.deepEqual(realSurface.bounds, { x: 50, y: 60, width: 400, height: 300 });
assert.ok(attachedView, 'Piglet open must attach a managed child view to the host window');
assert.equal(boundContexts.get(77).manifest.id, 'io.wrst.child');
assert.equal(boundContexts.get(77).parentContext, context);
assert.equal(boundContexts.get(77).filePath, null, 'Piglet open must stay on the range source until a write/protection path needs local backing');
assert.equal(boundContexts.get(77).pigletBacking, null, 'Piglet open must not eagerly materialize the whole child Wurst');
assert.equal((await surfaceManager.focus(context, realSurface.handle)).focused, true);
assert.deepEqual(surfaceManager.setBounds(context, realSurface.handle, { x: 10, y: 15, width: 200, height: 150 }).bounds, { x: 10, y: 15, width: 200, height: 150 });
assert.equal(await surfaceManager.close(context, realSurface.handle), true);
assert.equal(attachedView, null);
assert.equal(boundContexts.size, 0);

const storedContext = {
  manifest: { data: { format: 'wurst/data-realms-1', writable: true, realms: [{ id: 'workspace' }] } },
  reader: {
    wurstFsRoot: { format: 'wurst/fs-2' },
    async fsList(target) {
      if (target === 'data/workspace') return [{ path: 'data/workspace/apps', type: 'directory' }];
      if (target === 'data/workspace/apps') return [{ path: 'data/workspace/apps/Existing.wurst', type: 'file', size: pigletBytes.length }];
      return [];
    },
    async fsStat(target) {
      if (target === 'data/workspace/apps/Existing.wurst') return { path: target, type: 'file', size: pigletBytes.length };
      return null;
    },
    async fsReadRange(target, offset, length) {
      assert.equal(target, 'data/workspace/apps/Existing.wurst');
      return { data: pigletBytes.subarray(offset, offset + length) };
    }
  }
};
const persistedChunks = [];
const store = {
  async mkdir(target) { assert.equal(target, 'data/workspace/piglets'); },
  beginWrite(target, options) { assert.equal(target, 'data/workspace/piglets/Drop.wurst'); assert.equal(options.mime, 'application/vnd.wrst.wurst'); return 'write-1'; },
  async writeChunk(id, chunk) { assert.equal(id, 'write-1'); await Promise.resolve(); persistedChunks.push(Buffer.from(chunk)); },
  async commitWrite(id) { assert.equal(id, 'write-1'); },
  abortWrite() { throw new Error('unexpected abort'); },
  async remove() { return true; }
};
const storageAdapter = createPigletStorageAdapter({
  realmDataMode: () => true,
  realmRuntimeSummary: () => [{ id: 'workspace', governance: 'ordinary', initialized: true, locked: false, capabilities: { read: true, write: true } }],
  readOptions: async () => ({}),
  ensureInitializedStore: async () => store,
  activeActor: () => null,
  refreshContext: async () => {},
  scheduleHygiene: () => {},
  normalizeDataPath: (value) => String(value).replace(/^\/+/, ''),
  waitForMaintenance: async () => {}
});
const discoveredStored = await storageAdapter.discover(storedContext);
assert.equal(discoveredStored.length, 1);
assert.equal(discoveredStored[0].ref, 'wurstfs:/data/workspace/apps/Existing.wurst');
const persisted = await storageAdapter.install(storedContext, pigletBytes, { name: 'Drop.wurst' });
assert.equal(persisted.ref, 'wurstfs:/data/workspace/piglets/Drop.wurst');
assert.equal(sha256(Buffer.concat(persistedChunks)), childDigest, 'WurstFS Piglet install must persist the original package bytes');

const pigLinkIpc = new MockIpc();
let sent = null;
const targetWebContents = { isDestroyed: () => false, send: (channel, message) => { sent = { channel, message }; } };
const pigLinkRuntime = createDesktopPigLinkRuntime({ ipcMain: pigLinkIpc, assertWurstSender, getWebContents: () => targetWebContents });
assert.deepEqual(await loadPigLinkEntry(context, 'entry.js'), pigLinkBytes);
const invocation = pigLinkRuntime.invoke(context, 'echo', { value: 42 });
assert.equal(sent.channel, 'wurst:piglink:invoke-request');
pigLinkIpc.listeners.get('wurst:piglink:invoke-result')({}, { requestId: sent.message.requestId, ok: true, result: { value: 42 } });
assert.deepEqual(await invocation, { value: 42 });

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-desktop-pig-runtime-'));
const savedEnv = { WURSTER_PIGSTY_DEV: process.env.WURSTER_PIGSTY_DEV, WURSTER_PIGSTY_ENGINE: process.env.WURSTER_PIGSTY_ENGINE, WURSTER_EDGE_RUNTIME_DIR: process.env.WURSTER_EDGE_RUNTIME_DIR };
try {
  delete process.env.WURSTER_PIGSTY_DEV;
  delete process.env.WURSTER_PIGSTY_ENGINE;
  delete process.env.WURSTER_EDGE_RUNTIME_DIR;
  const pigstyIpc = new MockIpc();
  const app = { getAppPath: () => temp, getPath: () => temp };
  const pigstyRuntime = createDesktopPigstyRuntime({ app, ipcMain: pigstyIpc, assertWurstSender });
  const status = await pigstyRuntime.status(context);
  assert.equal(status.declared, true);
  assert.equal(status.state, 'coming-soon');
  assert.equal(status.defaultEngine, null);
  assert.equal(status.engines.worker.available, false);

  process.env.WURSTER_PIGSTY_DEV = '1';
  const devStatus = await pigstyRuntime.status(context);
  assert.equal(devStatus.state, 'available');
  assert.equal(devStatus.defaultEngine, 'worker');
  assert.equal(devStatus.engines.worker.developmentOnly, true);
} finally {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(temp, { recursive: true, force: true });
}

console.log('✓ Desktop Piglet discovers immutable + WurstFS children, preserves bytes and exposes managed surface lifecycle');
