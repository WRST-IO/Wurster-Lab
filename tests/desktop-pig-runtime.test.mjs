import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeWurst, openWurstRangeSource, sha256 } from '../packages/format/src/index.js';
import { createDesktopPigLinkRuntime, loadPigLinkEntry } from '../runtime/desktop/src/piglink-runtime.mjs';
import { createDesktopPigletRuntime } from '../runtime/desktop/src/piglet-runtime.mjs';
import { createPigletEmbedRuntime } from '../runtime/desktop/src/piglet-embed-runtime.mjs';
import { createPigletStorageAdapter } from '../runtime/desktop/src/piglet-storage-runtime.mjs';
import { createDesktopPigstyRuntime } from '../runtime/desktop/src/pigsty-runtime.mjs';

class MockIpc {
  handles = new Map();
  listeners = new Map();
  handle(name, fn) { this.handles.set(name, fn); }
  on(name, fn) { this.listeners.set(name, fn); }
}

const pigletBytes = encodeWurst({
  manifest: {
    format: 'wurst/7', id: 'io.wrst.child', name: 'Child Wurst', version: '0.32.0', entry: 'index.html',
    pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'workspace', mount: '/workspace' }] },
    piglink: {
      format: 'wurst/piglink-1', headless: true, entry: '__wurst/piglink/entry.js',
      actions: {
        echo: { input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, output: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        writeShared: { input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, output: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] } }
      },
      events: {}
    }
  },
  files: [
    { path: 'index.html', data: Buffer.from('<h1>Child</h1>'), scope: 'app', mime: 'text/html; charset=utf-8' },
    { path: '__wurst/piglink/entry.js', data: Buffer.from(`PigLink.define({actions:{echo:({text})=>({text}),writeShared:async({text})=>{await wurst.pigfs.write('/workspace/machine.txt',new TextEncoder().encode(text),{mime:'text/plain'});return {saved:true};}}})`), scope: 'piglink', mime: 'text/javascript' }
  ]
});
const childDigest = sha256(pigletBytes);
const pigLinkBytes = Buffer.from('PigLink.define({ actions: {} });');
const context = {
  manifest: {
    id: 'io.wrst.parent',
    capabilities: {},
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
let storedPigletBytes = Buffer.from(pigletBytes);
const storage = {
  async discover() { return installed; },
  async openSource(_context, storedPath) {
    const item = installed.find((candidate) => candidate.path === storedPath || candidate.ref === `pigfs:${storedPath}`);
    if (!item) throw new Error('missing stored piglet');
    return { size: storedPigletBytes.length, async read(offset, length) { return storedPigletBytes.subarray(offset, offset + length); } };
  },
  async readFile(_context, storedPath) {
    const item = installed.find((candidate) => candidate.path === storedPath || candidate.ref === `pigfs:${storedPath}`);
    if (!item) throw new Error('missing stored piglet');
    return pigletBytes;
  },
  async install(_context, bytes, options) {
    assert.equal(sha256(bytes), childDigest, 'Piglet installation must receive exact child bytes');
    const descriptor = {
      ref: 'pigfs:/workspace/piglets/Child.wurst',
      id: '/workspace/piglets/Child.wurst',
      label: 'Child Wurst',
      source: 'pigfs',
      path: '/workspace/piglets/Child.wurst',
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
const persistedSnapshots = [];
storage.prepareRuntimeSource = async (_context, descriptor, source) => ({ source, path: descriptor.source === 'pigfs' ? descriptor.path : null, expectedSha256: null, materializedFrom: descriptor.ref });
storage.persistRuntimeSource = async (_context, runtimeSource, bytes) => { storedPigletBytes = Buffer.from(bytes); persistedSnapshots.push(Buffer.from(bytes)); runtimeSource.expectedSha256 = sha256(bytes); return runtimeSource.expectedSha256; };
storage.fingerprintRuntimeSource = async (source) => sha256(await source.read(0, source.size));
const embeds = createPigletEmbedRuntime({ storage });
const pigletRuntime = createDesktopPigletRuntime({
  ipcMain: pigletIpc,
  assertWurstSender,
  assertCapability: (_context, name) => assert.equal(name, 'piglet'),
  storage,
  embeds
});

const builtinChildren = await pigletIpc.handles.get('wurst:piglet:children')({});
assert.deepEqual(builtinChildren.map((item) => item.ref), ['builtin:child']);
assert.equal(builtinChildren[0].application.id, 'io.wrst.child');
assert.equal(builtinChildren[0].signature.status, 'unsigned');

const installedChild = await pigletIpc.handles.get('wurst:piglet:install')({}, 'Child.wurst', pigletBytes, {});
assert.equal(installedChild.source, 'pigfs');
const allChildren = await pigletRuntime.list(context);
assert.deepEqual(allChildren.map((item) => item.source), ['builtin', 'pigfs']);
const openedEmbed = await pigletIpc.handles.get('wurst:piglet:embed-open')({}, installedChild.ref);
const secondView = await pigletIpc.handles.get('wurst:piglet:embed-open')({}, installedChild.ref);
assert.match(openedEmbed.handle, /^wurst-attachment-/);
assert.equal(openedEmbed.size, pigletBytes.length);
assert.equal(openedEmbed.session.id, secondView.session.id, 'opening the same Wurst twice must attach two views to one session');
assert.deepEqual((await pigletIpc.handles.get('wurst:piglet:running')({})).map(({ views, machines }) => ({ views, machines })), [{ views: 2, machines: 0 }]);
const machine = await pigletIpc.handles.get('wurst:piglet:machine-connect')({}, installedChild.ref);
assert.equal(machine.session.id, openedEmbed.session.id, 'machine client must attach to the same Wurst session as visible views');
assert.deepEqual((await pigletIpc.handles.get('wurst:piglet:running')({})).map(({ views, machines }) => ({ views, machines })), [{ views: 2, machines: 1 }]);
assert.equal((await pigletIpc.handles.get('wurst:piglet:machine-describe')({}, machine.handle)).piglink.headless, true);
assert.deepEqual((await pigletIpc.handles.get('wurst:piglet:machine-invoke')({}, machine.handle, 'echo', { text: 'oink' })).result, { text: 'oink' });
assert.deepEqual((await pigletIpc.handles.get('wurst:piglet:machine-invoke')({}, machine.handle, 'writeShared', { text: 'from machine' })).result, { saved: true });
assert.equal((await pigletIpc.handles.get('wurst:piglet:running')({}))[0].revision, 1, 'machine PigFS write must bump the shared Wurst revision');
{
  const source = { size: storedPigletBytes.length, async read(offset, length) { return storedPigletBytes.subarray(offset, offset + length); } };
  const reader = await openWurstRangeSource(source);
  const written = await reader.pigFsReadRange('/workspace/machine.txt');
  assert.equal(written?.data?.toString(), 'from machine', 'machine PigLink writes must persist into the shared child Wurst PigFS');
  await reader.close();
}
await assert.rejects(() => pigletIpc.handles.get('wurst:piglet:embed-persist')({}, secondView.handle, pigletBytes), (error) => error?.code === 'WURST_SESSION_CONFLICT');
assert.equal((await pigletIpc.handles.get('wurst:piglet:embed-refresh')({}, secondView.handle)).session.revision, 1);
assert.equal(await pigletIpc.handles.get('wurst:piglet:machine-close')({}, machine.handle), true);
assert.deepEqual((await pigletIpc.handles.get('wurst:piglet:running')({})).map(({ views, machines }) => ({ views, machines })), [{ views: 2, machines: 0 }]);
const slice = await pigletIpc.handles.get('wurst:piglet:embed-read')({}, openedEmbed.handle, 0, 24);
assert.equal(slice.length, 24, 'embed source reads must be ranged');
await pigletIpc.handles.get('wurst:piglet:embed-refresh')({}, openedEmbed.handle);
await pigletIpc.handles.get('wurst:piglet:embed-persist')({}, openedEmbed.handle, storedPigletBytes);
assert.equal(persistedSnapshots.length, 2);
await assert.rejects(() => pigletIpc.handles.get('wurst:piglet:embed-persist')({}, secondView.handle, pigletBytes), (error) => error?.code === 'WURST_SESSION_CONFLICT');
assert.equal((await pigletIpc.handles.get('wurst:piglet:embed-refresh')({}, secondView.handle)).session.revision, 2);
assert.equal(await pigletIpc.handles.get('wurst:piglet:embed-close')({}, openedEmbed.handle), true);
assert.equal((await pigletIpc.handles.get('wurst:piglet:running')({}))[0].views, 1);
assert.equal(await pigletIpc.handles.get('wurst:piglet:embed-close')({}, secondView.handle), true);
assert.equal((await pigletIpc.handles.get('wurst:piglet:running')({})).length, 0);
assert.equal(await pigletIpc.handles.get('wurst:piglet:remove')({}, installedChild.ref), true);

const storedContext = {
  manifest: { pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'workspace', mount: '/workspace' }] } },
  reader: {
    pigFsRoot: { format: 'wurst/pigfs-1' },
    async pigFsList(target) {
      if (target === '/workspace') return [{ path: '/workspace/apps', type: 'directory' }];
      if (target === '/workspace/apps') return [{ path: '/workspace/apps/Existing.wurst', type: 'file', size: pigletBytes.length }];
      return [];
    },
    async pigFsStat(target) {
      if (target === '/workspace/apps/Existing.wurst') return { path: target, objectId: 'existing-object', type: 'file', size: pigletBytes.length };
      if (target === '/workspace/piglets/Drop.wurst') return { path: target, objectId: 'drop-object', type: 'file', size: pigletBytes.length };
      return null;
    },
    async pigFsReadRange(target, offset, length) {
      assert.ok(['/workspace/apps/Existing.wurst', '/workspace/piglets/Drop.wurst'].includes(target));
      return { data: pigletBytes.subarray(offset, offset + length) };
    }
  }
};
const persistedChunks = [];
const store = {
  async mkdir(target) { assert.equal(target, '/workspace/piglets'); },
  beginWrite(target, options) { assert.equal(target, '/workspace/piglets/Drop.wurst'); assert.equal(options.mime, 'application/vnd.wrst.wurst'); return 'write-1'; },
  async writeChunk(id, chunk) { assert.equal(id, 'write-1'); persistedChunks.push(Buffer.from(chunk)); },
  async commitWrite(id) { assert.equal(id, 'write-1'); },
  abortWrite() { throw new Error('unexpected abort'); },
  async remove() { return true; }
};
const storageAdapter = createPigletStorageAdapter({
  realmDataMode: () => true,
  realmRuntimeSummary: () => [{ id: 'workspace', mount: '/workspace', governance: 'ordinary', initialized: true, locked: false, capabilities: { read: true, write: true } }],
  readOptions: async () => ({}), ensureInitializedStore: async () => store, activeActor: () => null,
  refreshContext: async () => {}, scheduleHygiene: () => {}, normalizeDataPath: (value) => String(value), waitForMaintenance: async () => {}
});
const discoveredStored = await storageAdapter.discover(storedContext);
assert.equal(discoveredStored.length, 1);
assert.equal(discoveredStored[0].ref, 'pigfs:/workspace/apps/Existing.wurst');
const persisted = await storageAdapter.install(storedContext, pigletBytes, { name: 'Drop.wurst' });
assert.equal(persisted.ref, 'pigfs:/workspace/piglets/Drop.wurst');
assert.equal(persisted.storageObjectId, 'drop-object');
assert.equal(persisted.objectId, undefined, 'Parent PigFS object identity must not masquerade as a persistent Wurst Object ID');
assert.equal(sha256(Buffer.concat(persistedChunks)), childDigest, 'PigFS Piglet install must persist the original package bytes');
let deletedObjectId = null;
storedContext.objectStore = {
  root: { rootObjectId: 'ROOT' },
  async findChild(parentObjectId, locator) {
    assert.equal(parentObjectId, 'ROOT');
    assert.equal(locator, 'pigfs-storage:drop-object');
    return { objectId: 'WURST-CHILD' };
  },
  async deleteSubtree(objectId, options) {
    assert.equal(objectId, 'WURST-CHILD');
    assert.equal(options.actorId, null);
    deletedObjectId = objectId;
  }
};
assert.equal(await storageAdapter.remove(storedContext, persisted.ref), true);
assert.equal(deletedObjectId, 'WURST-CHILD', 'removing a Parent PigFS Child must detach its persistent Wurst Object subtree');

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

console.log('✓ Desktop Piglet discovers immutable + PigFS children, preserves bytes and exposes range-backed universal embed lifecycle');
