import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WurstObjectStore,
  createMemoryWurstObjectStore,
  WURST_MAX_PIGLET_DEPTH
} from '../packages/format/src/wurst-object-store.js';
import { encodeWurst, openLocalPigFsStore, openLocalWurstObjectStore, openWurstFile, writeCompactedWurstFile } from '../packages/format/src/index.js';
import { makeFsRecord, PIG_FS_RECORD } from '../packages/format/src/pig-fs-records.js';

function rangeSource(bytes) {
  const data = Buffer.from(bytes);
  return {
    size: data.length,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > data.length) throw new Error('range outside source');
      return Buffer.from(data.subarray(offset, offset + length));
    }
  };
}

async function promote(store, parentObjectId, id, text = `${id}:base|state`, options = {}) {
  const bytes = Buffer.from(text);
  const baseSize = Math.max(1, Math.min(bytes.length, options.baseSize ?? Math.floor(bytes.length / 2)));
  return store.promote({
    parentObjectId,
    locator: options.locator ?? id,
    source: rangeSource(bytes),
    baseSize,
    applicationId: `app.${id}`,
    packageDigest: `pkg:${id}`,
    objectId: id,
    stateHash: `state:${id}:0`,
    publisher: options.publisher ?? { fingerprint: 'publisher-A' },
    governance: options.governance ?? null,
    actorId: options.actorId ?? null
  });
}

// Deep nesting: one byte written in the deepest child must not modify ancestor
// state revisions. The object graph depth itself is irrelevant to the mutation.
{
  const memory = await createMemoryWurstObjectStore(Buffer.from('ROOTBASE'));
  const { store } = memory;
  await store.initializeHostRoot({ objectId: 'ROOT', applicationId: 'app.root', packageDigest: 'pkg:root', baseBlobHash: 'sha256:root' });
  let parent = 'ROOT';
  for (const id of ['A', 'B', 'C', 'X']) { await promote(store, parent, id); parent = id; }
  const before = Object.fromEntries(await Promise.all(['ROOT', 'A', 'B', 'C', 'X'].map(async id => [id, await store.object(id)])));
  const physicalBefore = memory.bytes().length;
  const append = await store.beginObjectAppend('X');
  await append.append(Buffer.from('!'));
  const committed = await append.commit({ stateHash: 'state:X:1' });
  assert.equal(committed.ok, true);
  const after = Object.fromEntries(await Promise.all(['ROOT', 'A', 'B', 'C', 'X'].map(async id => [id, await store.object(id)])));
  for (const id of ['ROOT', 'A', 'B', 'C']) assert.equal(after[id].stateRevision, before[id].stateRevision, `${id} ancestor state revision changed`);
  assert.equal(after.X.stateRevision, before.X.stateRevision + 1);
  assert.equal(after.X.stateHash, 'state:X:1');
  assert.ok(memory.bytes().length - physicalBefore < 128 * 1024, 'small child delta should only add arena/index/root metadata, not ancestor snapshots');
  assert.equal((await store.verifyGraph()).maxDepth, 4);
}

// Read-set and write-set CAS: stale reads and concurrent writes become explicit
// WURST_SESSION_CONFLICT outcomes rather than lost updates.
{
  const { store } = await createMemoryWurstObjectStore(Buffer.from('ROOT'));
  await store.initializeHostRoot({ objectId: 'ROOT' });
  await promote(store, 'ROOT', 'X', 'BASEstate');

  const stale = store.beginTransaction();
  await store.readObject(stale, 'X', { state: true });
  const writer = await store.beginObjectAppend('X');
  await writer.append(Buffer.from('1'));
  assert.equal((await writer.commit()).ok, true);
  const staleResult = await store.commitTransaction(stale);
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.rejected[0].code, 'WURST_SESSION_CONFLICT');

  const left = await store.beginObjectAppend('X');
  const right = await store.beginObjectAppend('X');
  await left.append(Buffer.from('L'));
  await right.append(Buffer.from('R'));
  assert.equal((await left.commit()).ok, true);
  const conflict = await right.commit();
  assert.equal(conflict.ok, false);
  assert.equal(conflict.rejected[0].code, 'WURST_SESSION_CONFLICT');
}

// Group commit: independent prepared writes share one Root Commit + one sync.
{
  const memory = await createMemoryWurstObjectStore(Buffer.from('ROOT'));
  const { store } = memory;
  await store.initializeHostRoot({ objectId: 'ROOT' });
  await promote(store, 'ROOT', 'A', 'AAA-state');
  await promote(store, 'ROOT', 'B', 'BBB-state');
  const a = await store.beginObjectAppend('A');
  const b = await store.beginObjectAppend('B');
  await a.append(Buffer.from('a'));
  await b.append(Buffer.from('b'));
  const txA = a.prepare({ stateHash: 'A1' });
  const txB = b.prepare({ stateHash: 'B1' });
  const syncBefore = memory.syncCount();
  const result = await store.commitTransactions([txA, txB]);
  assert.equal(result.ok, true);
  assert.equal(result.accepted.length, 2);
  assert.equal(memory.syncCount(), syncBefore + 1, 'compatible group must publish through one durable Root Commit');
  assert.equal((await store.object('A')).stateHash, 'A1');
  assert.equal((await store.object('B')).stateHash, 'B1');
}

// Crash recovery ignores both fully prepared but unpublished records and random
// tail garbage. The latest complete Root Commit remains authoritative.
{
  const memory = await createMemoryWurstObjectStore(Buffer.from('ROOT'));
  const { store, source } = memory;
  await store.initializeHostRoot({ objectId: 'ROOT' });
  await promote(store, 'ROOT', 'X', 'BASEstate');
  const stableRootGeneration = store.root.generation;
  const stableX = await store.object('X');
  const prepared = await store.beginObjectAppend('X');
  await prepared.append(Buffer.from('UNPUBLISHED'));

  const reopened = new WurstObjectStore({ source, baseOffset: 4, append: async () => { throw new Error('read only'); } });
  await reopened.init();
  assert.equal(reopened.root.generation, stableRootGeneration);
  assert.equal((await reopened.object('X')).virtualSize, stableX.virtualSize);
  reopened.close();

  const withGarbage = Buffer.concat([memory.bytes(), crypto.randomBytes(97)]);
  const garbageSource = rangeSource(withGarbage);
  const garbageReopen = new WurstObjectStore({ source: garbageSource, baseOffset: 4, append: async () => { throw new Error('read only'); } });
  await garbageReopen.init();
  assert.equal(garbageReopen.root.generation, stableRootGeneration);
  assert.equal((await garbageReopen.object('X')).virtualSize, stableX.virtualSize);
  garbageReopen.close();

  // Even a fully framed but semantically corrupt ROOT_COMMIT at the physical
  // tail is uncommitted garbage. Recovery must walk back to the last valid root.
  const stableBytes = memory.bytes();
  const bogusRoot = makeFsRecord(PIG_FS_RECORD.ROOT_COMMIT, Buffer.from('{"format":"wurst/object-store-1","broken":true}'), {
    recordStart: stableBytes.length,
    previousCommitOffset: store.commitOffset ?? 0,
    sequence: 999999
  });
  const corruptSource = rangeSource(Buffer.concat([stableBytes, bogusRoot]));
  const corruptReopen = new WurstObjectStore({ source: corruptSource, baseOffset: 4, append: async () => { throw new Error('read only'); } });
  await corruptReopen.init();
  assert.equal(corruptReopen.root.generation, stableRootGeneration);
  assert.equal((await corruptReopen.object('X')).virtualSize, stableX.virtualSize);
  corruptReopen.close();
}

// Once object storage exists, a physical PigFS COMMIT is only prepared state.
// Recovery follows the host object's stateHead until a Root Commit publishes it.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-root-publication-'));
  const file = path.join(dir, 'root.wurst');
  const base = encodeWurst({
    manifest: {
      format: 'wurst/7', id: 'io.wrst.root-publication', name: 'Root Publication', version: '1.0.0', entry: 'index.html',
      application: { protection: 'public' },
      pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'files', mount: '/files' }] },
      capabilities: []
    },
    files: [{ path: 'index.html', scope: 'app', mime: 'text/html; charset=utf-8', data: Buffer.from('<h1>root</h1>') }]
  });
  await fs.writeFile(file, base);

  let reader = await openWurstFile(file);
  const objects = await openLocalWurstObjectStore(file, reader);
  await objects.initializeHostRoot({ objectId: 'ROOT', baseSize: reader.baseLength, virtualSize: reader.baseLength });
  reader.objectStoreRoot = structuredClone(objects.root);
  reader.objectStoreCommitOffset = objects.commitOffset;
  reader.objectStoreHost = await objects.object('ROOT');
  const pigfs = await openLocalPigFsStore(file, reader);
  await pigfs.initialize({ realms: [{ id: 'files', mount: '/files' }] });
  const preparedCommit = pigfs.commitOffset;
  assert.ok(Number.isSafeInteger(preparedCommit));

  // Closing one writer must not detach the shared reader source from the arena;
  // the remaining Object Store still advances source.size on later appends.
  await pigfs.closeFile();
  const sizeBeforeObjectAppend = reader.source.size;
  await promote(objects, 'ROOT', 'CHILD', 'child-state');
  assert.ok(reader.source.size > sizeBeforeObjectAppend);
  await objects.closeFile();
  await reader.close();

  // The prepared PigFS root was never named by the host Object's stateHead.
  reader = await openWurstFile(file);
  assert.equal(reader.pigFsRoot, null, 'unpublished logical PigFS state became authoritative after reopen');
  assert.ok(reader.objectStoreRoot);

  // Publication binds the prepared logical commit into one durable Root Commit.
  await reader.refreshWurstFs({ physicalLatest: true });
  assert.equal(reader.pigFsCommitOffset, preparedCommit);
  const publisher = await openLocalWurstObjectStore(file, reader);
  await publisher.syncHostState({
    stateRevision: reader.pigFsRoot.generation,
    stateHash: reader.pigFsRoot.stateHash,
    stateHead: reader.pigFsCommitOffset,
    virtualSize: reader.source.size
  });
  await publisher.closeFile();
  await reader.close();

  reader = await openWurstFile(file);
  assert.equal(reader.pigFsCommitOffset, preparedCommit);
  assert.ok(reader.pigFsRoot);
  await reader.close();
  await fs.rm(dir, { recursive: true, force: true });
}

// Parent→children enumeration uses the paginated relationship prefix rather
// than scanning every relationship page.
{
  const memory = await createMemoryWurstObjectStore(Buffer.from('ROOT'));
  const { store, source } = memory;
  await store.initializeHostRoot({ objectId: 'ROOT' });
  for (let i = 0; i < 40; i += 1) {
    const p = `P${String(i).padStart(2, '0')}`;
    await promote(store, 'ROOT', p, `${p}-state`);
    await promote(store, p, `C${String(i).padStart(2, '0')}`, `C${i}-state`);
  }
  const originalRead = source.read.bind(source);
  let reads = 0;
  source.read = async (...args) => { reads += 1; return originalRead(...args); };
  const children = await store.directChildren('P20');
  source.read = originalRead;
  assert.deepEqual(children.map(r => r.childObjectId), ['C20']);
  assert.ok(reads < 20, `direct child lookup read too many pages (${reads}); relationship index appears to be scanning globally`);
}

// Reparenting is atomic, relationship revisions are separate, and cycles are
// rejected by bounded parent traversal.
{
  const { store } = await createMemoryWurstObjectStore(Buffer.from('ROOT'));
  await store.initializeHostRoot({ objectId: 'ROOT' });
  await promote(store, 'ROOT', 'A');
  await promote(store, 'ROOT', 'B');
  await promote(store, 'A', 'X');
  const beforeA = await store.object('A'), beforeB = await store.object('B'), beforeX = await store.object('X');
  assert.equal((await store.reparent('X', 'B', { locator: 'moved-x' })).ok, true);
  assert.equal((await store.parentOf('X')).parentObjectId, 'B');
  assert.equal((await store.object('A')).stateRevision, beforeA.stateRevision);
  assert.equal((await store.object('B')).stateRevision, beforeB.stateRevision);
  assert.equal((await store.object('X')).stateRevision, beforeX.stateRevision);
  assert.ok((await store.object('A')).relationshipRevision > beforeA.relationshipRevision);
  assert.ok((await store.object('B')).relationshipRevision > beforeB.relationshipRevision);
  assert.ok((await store.object('X')).relationshipRevision > beforeX.relationshipRevision);
  const cycle = await store.reparent('B', 'X');
  assert.equal(cycle.ok, false);
  assert.match(cycle.rejected[0].error, /cycle/);
}

// Reachability is liveness: subtree removal does not rewrite/delete descendants.
{
  const { store } = await createMemoryWurstObjectStore(Buffer.from('ROOT'));
  await store.initializeHostRoot({ objectId: 'ROOT' });
  await promote(store, 'ROOT', 'A');
  await promote(store, 'A', 'X');
  const xBefore = await store.object('X');
  await store.deleteSubtree('A');
  assert.deepEqual(await store.reachableObjectIds(), ['ROOT']);
  assert.equal((await store.object('X')).objectId, xBefore.objectId, 'unreachable descendant should remain until compaction');
  const stats = await store.stats();
  assert.equal(stats.unreachableObjects, 2);
}

// Governance is distinct from integrity and package transitions are explicit.
{
  const { store } = await createMemoryWurstObjectStore(Buffer.from('ROOT'));
  await store.initializeHostRoot({ objectId: 'ROOT' });
  await promote(store, 'ROOT', 'LOCKED', 'LOCKED-state', { governance: { state: ['alice'], relationship: ['alice'], delete: ['alice'], upgrade: ['alice'] }, actorId: null });
  await assert.rejects(() => store.beginObjectAppend('LOCKED', { actorId: 'bob' }), error => error?.code === 'WURST_OBJECT_FORBIDDEN');
  const allowed = await store.beginObjectAppend('LOCKED', { actorId: 'alice' });
  await allowed.append(Buffer.from('!'));
  assert.equal((await allowed.commit()).ok, true);
  const replacement = rangeSource(Buffer.from('NEWBASE'));
  await assert.rejects(() => store.transitionBase('LOCKED', replacement, {
    baseSize: replacement.size,
    packageDigest: 'pkg:new',
    publisher: { fingerprint: 'publisher-B' },
    actorId: 'alice'
  }), error => error?.code === 'WURST_PACKAGE_TRANSITION_APPROVAL_REQUIRED');

  const rotatedMemory = await createMemoryWurstObjectStore(Buffer.from('ROOT'), {
    verifyPublisherTransition: ({ previousPublisher, nextPublisher }) => previousPublisher?.fingerprint === 'publisher-A' && nextPublisher?.fingerprint === 'publisher-B'
  });
  await rotatedMemory.store.initializeHostRoot({ objectId: 'ROOT' });
  await promote(rotatedMemory.store, 'ROOT', 'ROTATED', 'ROTATED-state', { publisher: { fingerprint: 'publisher-A' } });
  const rotatedBase = rangeSource(Buffer.from('ROTATED-v2'));
  const transitioned = await rotatedMemory.store.transitionBase('ROTATED', rotatedBase, {
    baseSize: rotatedBase.size,
    packageDigest: 'pkg:rotated-v2',
    publisher: { fingerprint: 'publisher-B' }
  });
  assert.equal(transitioned.ok, true);
  assert.equal((await rotatedMemory.store.object('ROTATED')).publisher.fingerprint, 'publisher-B');
}

// Subtree materialization shares one relocation core. Move preserves Object IDs;
// Export/Copy creates new Object IDs while immutable Base bytes stay bit exact.
{
  const sourceMemory = await createMemoryWurstObjectStore(Buffer.from('ROOT'));
  const { store } = sourceMemory;
  await store.initializeHostRoot({ objectId: 'ROOT' });
  await promote(store, 'ROOT', 'A', 'ABCDmutable', { baseSize: 4 });
  await promote(store, 'A', 'X', 'WXYZstate', { baseSize: 4 });
  const sourceA = await store.openObjectSource('A');
  const originalBase = await sourceA.read(0, 4);

  let preserveTarget;
  const moved = await store.materializeSubtree('A', {
    identityMode: 'preserve',
    createFile: async (rootSource, populate) => {
      const rootBytes = await rootSource.read(0, rootSource.size);
      preserveTarget = await createMemoryWurstObjectStore(rootBytes, { baseOffset: 4 });
      return populate(preserveTarget.store, { baseSize: 4, virtualSize: rootBytes.length });
    }
  });
  assert.equal(moved.rootObjectId, 'A');
  assert.equal((await preserveTarget.store.object('A')).objectId, 'A');
  assert.equal((await preserveTarget.store.parentOf('X')).parentObjectId, 'A');
  assert.deepEqual((await preserveTarget.source.read(0, 4)), originalBase);
  assert.equal((await preserveTarget.store.object('X')).baseBlobHash, (await store.object('X')).baseBlobHash);

  let copyTarget;
  const copied = await store.materializeSubtree('A', {
    identityMode: 'copy',
    createFile: async (rootSource, populate) => {
      const rootBytes = await rootSource.read(0, rootSource.size);
      copyTarget = await createMemoryWurstObjectStore(rootBytes, { baseOffset: 4 });
      return populate(copyTarget.store, { baseSize: 4, virtualSize: rootBytes.length });
    }
  });
  assert.notEqual(copied.rootObjectId, 'A');
  assert.notEqual(copied.objectIds.X, 'X');
  assert.equal((await copyTarget.store.parentOf(copied.objectIds.X)).parentObjectId, copied.rootObjectId);
  assert.deepEqual((await copyTarget.source.read(0, 4)), originalBase);
}


// Root compaction is the garbage collector for the append arena. It preserves
// live Object IDs and immutable Base bytes, while unreachable subtrees vanish
// from the rewritten physical file without becoming a recovery dependency.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-object-compact-'));
  const originalPath = path.join(dir, 'root.wurst');
  const compactPath = path.join(dir, 'root.compact.wurst');
  const rootBytes = encodeWurst({
    manifest: { format: 'wurst/7', id: 'io.wrst.object-root', name: 'Object Root', version: '1.0.0', entry: 'index.html', application: { protection: 'public' }, capabilities: [] },
    files: [{ path: 'index.html', scope: 'app', mime: 'text/html; charset=utf-8', data: Buffer.from('<h1>root</h1>') }]
  });
  const childBytes = encodeWurst({
    manifest: { format: 'wurst/7', id: 'io.wrst.object-child', name: 'Object Child', version: '1.0.0', entry: 'index.html', application: { protection: 'public' }, capabilities: [] },
    files: [{ path: 'index.html', scope: 'app', mime: 'text/html; charset=utf-8', data: Buffer.from('<h1>child</h1>') }]
  });
  await fs.writeFile(originalPath, rootBytes);
  let reader = await openWurstFile(originalPath);
  const objects = await openLocalWurstObjectStore(originalPath, reader);
  const rootBaseHash = `sha256:${crypto.createHash('sha256').update(rootBytes).digest('hex')}`;
  await objects.initializeHostRoot({ objectId: 'ROOT', applicationId: 'io.wrst.object-root', packageDigest: 'pkg:root', baseBlobHash: rootBaseHash, baseSize: reader.baseLength, virtualSize: reader.baseLength });
  await objects.promote({ parentObjectId: 'ROOT', locator: 'live', source: rangeSource(childBytes), baseSize: childBytes.length, applicationId: 'io.wrst.object-child', packageDigest: 'pkg:child', objectId: 'LIVE' });
  await objects.promote({ parentObjectId: 'ROOT', locator: 'dead', source: rangeSource(Buffer.from(childBytes)), baseSize: childBytes.length, applicationId: 'io.wrst.object-child', packageDigest: 'pkg:child', objectId: 'DEAD' });
  await objects.deleteSubtree('DEAD');
  await objects.closeFile();
  await reader.refreshWurstFs();
  const oldSize = reader.source.size;
  const compacted = await writeCompactedWurstFile(compactPath, reader);
  await reader.close();
  assert.ok(compacted.newSize < oldSize, 'compaction should reclaim unreachable object arena/history');

  reader = await openWurstFile(compactPath);
  assert.equal(reader.objectStoreHost?.objectId, 'ROOT');
  const readStore = new WurstObjectStore({ source: reader.source, baseOffset: reader.baseLength, append: async () => { throw new Error('read only'); } });
  await readStore.init();
  assert.equal((await readStore.object('LIVE')).objectId, 'LIVE');
  assert.equal(await readStore.object('DEAD'), null);
  const liveSource = await readStore.openObjectSource('LIVE');
  assert.deepEqual(await liveSource.read(0, liveSource.size), childBytes);
  await reader.close();
  await fs.rm(dir, { recursive: true, force: true });
}

assert.ok(WURST_MAX_PIGLET_DEPTH >= 16);
console.log('✓ Wurst Object Store: depth-independent writes, COW indexes, CAS/read-sets, group commit, recovery, governance, reachability and subtree materialization');
