import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createMemoryPigFsStore,
  deriveWursterIdentityMaterial,
  encodeWurst,
  generateMeatphrase,
  measurePigFsStorage,
  openLocalPigFsStore,
  openWurstFile,
  writeCompactedWurstFile
} from '../packages/format/src/index.js';

const MiB = 1024 * 1024;
const alice = deriveWursterIdentityMaterial(generateMeatphrase(12).meatphrase, { name: 'Alice' });
const bob = deriveWursterIdentityMaterial(generateMeatphrase(12).meatphrase, { name: 'Bob' });

// Default v2 storage is deliberately ordinary mutable data. It needs no identity,
// mutation signature or audit chain. CRUD describes its operations, not its mode.
const { store: crud, bytes: crudBytes } = await createMemoryPigFsStore(Buffer.from('CRUD-BASE'));
await crud.initialize({ realms: [{ id: 'files' }] });
assert.equal(crud.root.historyMode, 'none');
assert.equal(Object.hasOwn(crud.realm('files'), 'governance'), false);
assert.equal(Object.hasOwn(crud.realm('files'), 'mode'), false);
assert.equal(crud.realm('files').audit, 'none');
assert.equal((await crud.history()).commits.length, 0);

// A long write may remain in flight while later small writes commit first.
const big = crud.beginWrite('/files/big-video.bin');
await crud.writeChunk(big, Buffer.alloc(MiB, 0x41));
const small = crud.beginWrite('/files/tiny-video.bin');
await crud.writeChunk(small, Buffer.from('tiny'));
await crud.commitWrite(small);
const note = crud.beginWrite('/files/note.txt', { mime: 'text/plain' });
await crud.writeChunk(note, Buffer.from('Currywurst')); 
await crud.commitWrite(note);
await crud.writeChunk(big, Buffer.alloc(MiB, 0x42));
await crud.commitWrite(big);
assert.equal((await crud.read('/files/tiny-video.bin')).data.toString(), 'tiny');
assert.equal((await crud.read('/files/note.txt')).data.toString(), 'Currywurst');
assert.equal((await crud.stat('/files/big-video.bin')).size, 2 * MiB);

// Catalog page bounds are acceleration hints, not authority. Path ordering must be
// deterministic and a filename such as tools_export_* must never become a ghost
// merely because '/' and '_' sort differently under locale collation.
const pathOrder = crud.beginWrite('/files/tools/export.txt');
await crud.writeChunk(pathOrder, Buffer.from('nested'));
await crud.commitWrite(pathOrder);
const underscorePath = crud.beginWrite('/files/tools_export_wurster_lab.py');
await crud.writeChunk(underscorePath, Buffer.from('exporter'));
await crud.commitWrite(underscorePath);
assert.equal((await crud.stat('/files/tools_export_wurster_lab.py')).size, 8);
assert.equal((await crud.read('/files/tools_export_wurster_lab.py')).data.toString(), 'exporter');

// Concurrent writes to the same logical object conflict instead of silently
// merging bytes from two transactions.
const sameA = crud.beginWrite('/files/same.txt');
const sameB = crud.beginWrite('/files/same.txt');
await crud.writeChunk(sameA, Buffer.from('A'));
await crud.writeChunk(sameB, Buffer.from('B'));
await crud.commitWrite(sameA);
await assert.rejects(() => crud.commitWrite(sameB), (error) => error.code === 'PIG_FS_CONFLICT');
crud.abortWrite(sameB);
assert.equal((await crud.read('/files/same.txt')).data.toString(), 'A');
assert.ok(crudBytes().length > 2 * MiB, 'append-safe CRUD writes may temporarily leave reclaimable physical bytes');
crud.close();

// Personal storage is a separate first-class governance policy: sealed, single-owner,
// compactable, and intentionally non-shareable.
const { store: personal, bytes: personalBytes } = await createMemoryPigFsStore(Buffer.from('PERSONAL-BASE'));
await personal.initialize({ actor: alice, realms: [{ id: 'mine', governance: 'personal' }] });
assert.equal(personal.root.historyMode, 'none');
assert.equal(personal.realm('mine').governance, 'personal');
let ptx = personal.beginWrite('/mine/secret.txt', { actor: alice, mime: 'text/plain' });
await personal.writeChunk(ptx, Buffer.from('private pig'));
await personal.commitWrite(ptx);
assert.equal(personalBytes().includes(Buffer.from('private pig')), false);
await assert.rejects(() => personal.grant('mine', bob.publicRecord, { read: true }, { actor: alice }), (error) => error.code === 'PIG_FS_NOT_SHAREABLE');
personal.close();

// A Wurst may ship ordinary data next to an empty personal compartment before
// the recipient has ever opened it. The first explicit claim binds only that
// personal realm to the current Wurster Identity; ordinary data stays ordinary.
const { store: mixed, bytes: mixedBytes } = await createMemoryPigFsStore(Buffer.from('MIXED-BASE'));
await mixed.initialize({ realms: [{ id: 'workspace' }, { id: 'operator', governance: 'personal' }] });
assert.equal(Object.hasOwn(mixed.realm('workspace'), 'governance'), false);
assert.equal(mixed.realm('operator').governance, 'personal');
assert.equal(mixed.realm('operator').claimed, false);
let mtx = mixed.beginWrite('/workspace/README.md', { mime: 'text/markdown' });
await mixed.writeChunk(mtx, Buffer.from('# Wurster Lab'));
await mixed.commitWrite(mtx);
assert.throws(() => mixed.unlockRealm('operator', alice), (error) => error.code === 'PIG_FS_UNCLAIMED');
await mixed.claimPersonalRealm('operator', { actor: alice });
assert.equal(mixed.realm('operator').claimed, true);
mtx = mixed.beginWrite('/operator/issuer.wurstissuer', { actor: alice });
await mixed.writeChunk(mtx, Buffer.from('encrypted operator backup'));
await mixed.commitWrite(mtx);
assert.equal(mixedBytes().includes(Buffer.from('encrypted operator backup')), false);
mixed.close();

function makeWurst(version, realms) {
  return encodeWurst({
    manifest: {
      format: 'wurst/7', id: `io.wrst.storage-${version}`, name: 'Storage Test', version, entry: 'index.html', type: 'widget',
      application: { protection: 'public' }, protection: { storedIdentity: true }, capabilities: {},
      pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms }, security: { signed: false }
    },
    files: [{ path: 'index.html', data: Buffer.from('<h1>storage</h1>'), scope: 'app', mime: 'text/html' }]
  });
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurst-fs-storage-'));
try {
  // Ordinary compaction physically removes deleted/replaced payloads. No retained
  // hash/history tail is required for ordinary data.
  const crudFile = path.join(temp, 'crud.wurst');
  await fs.writeFile(crudFile, makeWurst('0.20.0', [{ id: 'files' }]));
  let reader = await openWurstFile(crudFile);
  let disk = await openLocalPigFsStore(crudFile, reader);
  await disk.initialize({ realms: [{ id: 'files' }] });
  let tx = disk.beginWrite('/files/delete-me.bin');
  await disk.writeChunk(tx, Buffer.alloc(2 * MiB, 0x55));
  await disk.commitWrite(tx);
  tx = disk.beginWrite('/files/keep.bin');
  await disk.writeChunk(tx, Buffer.alloc(64 * 1024, 0x33));
  await disk.commitWrite(tx);
  await disk.remove('/files/delete-me.bin');
  await disk.closeFile();
  await reader.close();

  reader = await openWurstFile(crudFile);
  const usage = await measurePigFsStorage(reader.source, reader.pigFsRoot, {
    baseOffset: reader.baseLength,
    commitOffset: reader.pigFsCommitOffset
  });
  assert.equal(usage.historyMode, 'none');
  assert.ok(usage.reclaimableBytes > 2 * MiB, 'deleted CRUD payload should be physically reclaimable');
  const crudCompact = path.join(temp, 'crud-compact.wurst');
  const compacted = await writeCompactedWurstFile(crudCompact, reader);
  assert.ok(compacted.reclaimedBytes > 2 * MiB);
  await reader.close();
  const compactReader = await openWurstFile(crudCompact);
  assert.equal(await compactReader.pigFsStat('/files/delete-me.bin'), null);
  assert.equal((await compactReader.pigFsReadRange('/files/keep.bin')).data.length, 64 * 1024);
  assert.equal(compactReader.pigFsRoot.historyMode, 'none');
  await compactReader.close();

  // Same promise for owner-only encrypted data: deletion followed by compaction
  // really sheds the ciphertext while preserving the owner's remaining data.
  const personalFile = path.join(temp, 'personal.wurst');
  await fs.writeFile(personalFile, makeWurst('0.20.0', [{ id: 'mine', governance: 'personal' }]));
  reader = await openWurstFile(personalFile);
  disk = await openLocalPigFsStore(personalFile, reader);
  await disk.initialize({ actor: alice, rootAdmins: [alice.publicRecord.identityId], realms: [{ id: 'mine', governance: 'personal' }] });
  tx = disk.beginWrite('/mine/delete-me.bin', { actor: alice });
  await disk.writeChunk(tx, Buffer.alloc(2 * MiB, 0x77));
  await disk.commitWrite(tx);
  tx = disk.beginWrite('/mine/keep.txt', { actor: alice, mime: 'text/plain' });
  await disk.writeChunk(tx, Buffer.from('still secret'));
  await disk.commitWrite(tx);
  await disk.remove('/mine/delete-me.bin', { actor: alice });
  const realmKey = Buffer.from(disk.realmKeys.get('mine'));
  await disk.closeFile();
  await reader.close();

  reader = await openWurstFile(personalFile);
  const personalCompact = path.join(temp, 'personal-compact.wurst');
  const personalResult = await writeCompactedWurstFile(personalCompact, reader, { realmKeys: new Map([['mine', realmKey]]) });
  assert.ok(personalResult.reclaimedBytes > 2 * MiB);
  await reader.close();
  const personalReader = await openWurstFile(personalCompact);
  const reopened = await openLocalPigFsStore(personalCompact, personalReader);
  reopened.unlockRealm('mine', alice);
  assert.equal((await reopened.read('/mine/keep.txt')).data.toString(), 'still secret');
  assert.equal(await reopened.stat('/mine/delete-me.bin'), null);
  await reopened.closeFile();
  await personalReader.close();
  realmKey.fill(0);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

console.log('✓ PigFS ordinary storage is the unnamed history-free default without identities or signatures');
console.log('✓ Long streaming writes can be overtaken by unrelated small commits while same-object races conflict');
console.log('✓ Personal sealed storage is owner-only, non-shareable and history-free');
console.log('✓ Empty personal realms can travel unclaimed beside ordinary data and bind to their first local owner later');
console.log('✓ Ordinary and personal Wursts physically shrink again when obsolete payloads are compacted');
