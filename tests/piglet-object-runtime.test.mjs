import assert from 'node:assert/strict';
import {
  SIGNATURE_PATH,
  createMemoryWurstObjectStore,
  createPackageSignature,
  createPublisherKeyBundle,
  decodeWurst,
  descriptorsFromPackage,
  encodeWurst,
  openWurstRangeSource,
  verifyPackageSignatureFromReader
} from '../packages/format/src/index.js';
import { invokeRootBackedWurstService, closeRootBackedWurstService } from '../runtime/desktop/src/piglet-object-runtime.mjs';
import { createPigletObjectStorageRuntime } from '../runtime/desktop/src/piglet-object-storage-runtime.mjs';

function rangeSource(bytes) {
  const data = Buffer.from(bytes);
  return {
    size: data.length,
    async read(offset, length) { return Buffer.from(data.subarray(offset, offset + length)); }
  };
}

const childManifest = {
  format: 'wurst/7',
  id: 'io.wrst.object-runtime-child',
  name: 'Object Runtime Child',
  version: '1.0.0',
  entry: 'index.html',
  application: { protection: 'public' },
  pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'files', mount: '/files' }] },
  capabilities: [],
  security: { signed: true }
};
const unsigned = decodeWurst(encodeWurst({
  manifest: childManifest,
  files: [{ path: 'index.html', scope: 'app', mime: 'text/html; charset=utf-8', data: Buffer.from('<h1>child</h1>') }]
}));
const phrase = 'smoked-bacon peppered-brisket cured-ham grilled-rib charred-steak mustard-pork hickory-wurst iron-chop maple-salami crispy-roast ember-belly garlic-jerky';
const publisher = createPublisherKeyBundle({ email: 'object-runtime@example.test', meatphrase: phrase });
const signature = createPackageSignature(unsigned, publisher.bundle, phrase);
const childBytes = encodeWurst({
  manifest: childManifest,
  files: [
    ...descriptorsFromPackage(unsigned).filter((file) => file.path !== SIGNATURE_PATH),
    { path: SIGNATURE_PATH, data: Buffer.from(JSON.stringify(signature)), scope: 'signature', mime: 'application/json; charset=utf-8' }
  ]
});

const inspected = await openWurstRangeSource(rangeSource(childBytes));
const originalSignature = await verifyPackageSignatureFromReader(inspected);
assert.equal(originalSignature.status, 'signed');
const memory = await createMemoryWurstObjectStore(Buffer.from('ROOT'));
await memory.store.initializeHostRoot({ objectId: 'ROOT', applicationId: 'io.wrst.root' });
const child = await memory.store.promote({
  parentObjectId: 'ROOT',
  locator: 'builtin:child',
  source: rangeSource(childBytes),
  baseSize: inspected.baseLength,
  applicationId: inspected.manifest.id,
  packageDigest: originalSignature.record.statement.packageDigest,
  publisher: originalSignature.publisher,
  objectId: 'CHILD'
});
await inspected.close();

const objectSource = await memory.store.openObjectSource('CHILD');
const world = {
  runtimeSource: { rootBacked: true, store: memory.store, objectId: 'CHILD', source: objectSource },
  source: objectSource
};

// First access initializes the Child's declared PigFS inside its own object state.
await invokeRootBackedWurstService(world, 'pigfs.capabilities');
const rootBefore = await memory.store.object('ROOT');
const childBefore = await memory.store.object('CHILD');

const written = await invokeRootBackedWurstService(world, 'pigfs.write', ['/files/oink.txt', Buffer.from('nested-object-state')]);
assert.equal(written.committed, true);
assert.equal((await memory.store.object('ROOT')).stateRevision, rootBefore.stateRevision, 'child runtime write must not touch root state revision');
assert.equal((await memory.store.object('CHILD')).stateRevision, childBefore.stateRevision + 1, 'child runtime write must publish only the child object state');

await objectSource.refresh();
const reopened = await openWurstRangeSource(objectSource);
const stat = await reopened.pigFsStat('/files/oink.txt');
assert.equal(stat?.size, Buffer.byteLength('nested-object-state'));
const data = await reopened.pigFsReadRange('/files/oink.txt', 0, stat.size);
assert.equal(Buffer.from(data.data).toString('utf8'), 'nested-object-state');
assert.equal((await memory.store.parentOf('CHILD')).parentObjectId, 'ROOT');
await reopened.close();

// Closure: extracting the live Child produces a standalone Wurst whose mutable
// PigFS head is authoritative and whose immutable publisher signature survives.
let extracted;
await memory.store.materializeSubtree('CHILD', {
  identityMode: 'preserve',
  createFile: async (rootSource, populate) => {
    const rootBytes = await rootSource.read(0, rootSource.size);
    extracted = await createMemoryWurstObjectStore(rootBytes, { baseOffset: inspected.baseLength });
    return populate(extracted.store);
  }
});
const extractedReader = await openWurstRangeSource(extracted.source);
const extractedState = await extractedReader.pigFsStat('/files/oink.txt');
assert.equal(extractedState?.size, Buffer.byteLength('nested-object-state'));
const extractedData = await extractedReader.pigFsReadRange('/files/oink.txt', 0, extractedState.size);
assert.equal(Buffer.from(extractedData.data).toString('utf8'), 'nested-object-state');
const extractedSignature = await verifyPackageSignatureFromReader(extractedReader);
assert.equal(extractedSignature.status, 'signed');
assert.equal(extractedSignature.publisher.fingerprint, originalSignature.publisher.fingerprint);
assert.equal(extractedReader.objectStoreHost?.objectId, 'CHILD');
await extractedReader.close();
await closeRootBackedWurstService(world);

// Parent PigFS file identity is a locator, not the Wurst Object ID. Renaming the
// containing PigFS path therefore reopens the same persistent Wurst instance.
const locatorMemory = await createMemoryWurstObjectStore(Buffer.from('ROOT2'));
await locatorMemory.store.initializeHostRoot({ objectId: 'ROOT2' });
const storageRuntime = createPigletObjectStorageRuntime({
  ensureObjectStore: async () => locatorMemory.store,
  activeActor: () => null,
  writeExact: async () => { throw new Error('legacy whole-Wurst writeback must not be used'); }
});
const descriptorBase = {
  application: { id: childManifest.id },
  packageDigest: originalSignature.record.statement.packageDigest,
  signature: { publisher: originalSignature.publisher },
  baseSize: inspected.baseLength,
  stateRevision: 0,
  stateHash: null,
  stateHead: null,
  data: { writable: true }
};
const firstRuntimeSource = await storageRuntime.prepareRuntimeSource({}, {
  ...descriptorBase,
  ref: 'pigfs:/apps/Before.wurst',
  path: '/apps/Before.wurst',
  storageObjectId: 'parent-pigfs-object-123'
}, rangeSource(childBytes));
const secondRuntimeSource = await storageRuntime.prepareRuntimeSource({}, {
  ...descriptorBase,
  ref: 'pigfs:/renamed/After.wurst',
  path: '/renamed/After.wurst',
  storageObjectId: 'parent-pigfs-object-123'
}, rangeSource(childBytes));
assert.equal(secondRuntimeSource.objectId, firstRuntimeSource.objectId, 'Parent PigFS rename created a second Wurst Object ID');
const locatorChildren = await locatorMemory.store.directChildren('ROOT2');
assert.equal(locatorChildren.length, 1);
assert.equal(locatorChildren[0].locator, 'pigfs-storage:parent-pigfs-object-123');

console.log('✓ Root-backed Piglet runtime commits Child state depth-independently, preserves storage/Object identity separation and extracts a complete signed standalone Closure');
