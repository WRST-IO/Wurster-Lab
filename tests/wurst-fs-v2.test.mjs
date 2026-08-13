import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WURST_FS_RECORD,
  WURST_FS_V2_COMMIT_CONTEXT,
  WURST_FS_V2_FORMAT,
  WURST_FS_V2_MUTATION_FORMAT,
  compareWurstFs2Histories,
  computeWurstFs2CommitHash,
  computeWurstFs2StateHash,
  createMemoryWurstFs2Store,
  createWursterIdentityRecord,
  deriveWursterIdentityMaterial,
  encodeWurst,
  generateMeatphrase,
  makeFsRecord,
  openLocalWurstFsStore,
  openWurstFile,
  signWursterIdentityPayload,
  verifyWurstFs2History,
  verifyWursterIdentityRecord,
  wurstFsRealmCapabilities
} from '../packages/format/src/index.js';

const alicePhrase = generateMeatphrase(12).meatphrase;
const bobPhrase = generateMeatphrase(12).meatphrase;
const charliePhrase = generateMeatphrase(12).meatphrase;
const alice = deriveWursterIdentityMaterial(alicePhrase, { name: 'Alice', emoji: '🐷' });
const bob = deriveWursterIdentityMaterial(bobPhrase, { name: 'Bauer Humpe', emoji: '🚜' });
const charlie = deriveWursterIdentityMaterial(charliePhrase, { name: 'Charlie', emoji: '🥩' });

// Meatphrase recovery deterministically restores the cryptographic persona while
// display metadata remains self-declared and self-signed.
const aliceRecovered = deriveWursterIdentityMaterial(alicePhrase, { name: 'Alice on a new machine', emoji: '🧪' });
assert.equal(aliceRecovered.publicRecord.identityId, alice.publicRecord.identityId);
assert.equal(verifyWursterIdentityRecord(alice.publicRecord).valid, true);
const relabelled = structuredClone(alice.publicRecord);
relabelled.name = 'Definitely Elon';
assert.equal(verifyWursterIdentityRecord(relabelled).valid, false);
assert.equal(createWursterIdentityRecord(alicePhrase).identityId, alice.publicRecord.identityId);

const base = Buffer.from('IMMUTABLE-WURST-BASE');
const { store, source, bytes } = await createMemoryWurstFs2Store(base);
await store.initialize({
  actor: alice,
  identities: [bob.publicRecord, charlie.publicRecord],
  realms: [
    {
      id: 'shared',
      label: 'Shared Club Files',
      governance: 'shared',
      audit: 'signed',
      protection: 'public',
      access: {
        read: { mode: 'public' },
        write: { mode: 'members', identities: [alice.publicRecord.identityId, bob.publicRecord.identityId] },
        admins: [alice.publicRecord.identityId]
      }
    },
    {
      id: 'alice-private',
      label: 'Alice Private',
      governance: 'shared',
      audit: 'none',
      protection: 'sealed',
      access: {
        read: { mode: 'members', identities: [alice.publicRecord.identityId] },
        write: { mode: 'members', identities: [alice.publicRecord.identityId] },
        admins: [alice.publicRecord.identityId]
      }
    }
  ]
});

assert.deepEqual(wurstFsRealmCapabilities(store.realm('shared'), bob.publicRecord.identityId), { read: true, write: true, admin: false });
assert.deepEqual(wurstFsRealmCapabilities(store.realm('shared'), charlie.publicRecord.identityId), { read: true, write: false, admin: false });

let tx = store.beginWrite('/data/shared/grill/votes/humpe.json', { actor: bob, mime: 'application/json' });
await store.writeChunk(tx, Buffer.from('{"friday":"wurst"}'));
const bobWrite = await store.commitWrite(tx);
assert.equal(bobWrite.entry.modifiedBy, bob.publicRecord.identityId);
assert.equal((await store.read('/data/shared/grill/votes/humpe.json')).data.toString(), '{"friday":"wurst"}');
await store.rename('/data/shared/grill/votes/humpe.json', '/data/shared/grill/votes/bauer-humpe.json', { actor: bob });
assert.equal((await store.read('/data/shared/grill/votes/bauer-humpe.json')).data.toString(), '{"friday":"wurst"}');

assert.throws(() => store.beginWrite('/data/shared/grill/votes/charlie.json', { actor: charlie }), (error) => error.code === 'WURST_FS_FORBIDDEN');

// Private bytes and filenames are unavailable without a matching recipient key.
tx = store.beginWrite('/data/alice-private/dreams/secret.txt', { actor: alice, mime: 'text/plain' });
await store.writeChunk(tx, Buffer.from('flying pigs'));
await store.commitWrite(tx);
store.lockRealm('alice-private');
await assert.rejects(() => store.list('/data/alice-private'), (error) => error.code === 'WURST_FS_LOCKED');
assert.throws(() => store.unlockRealm('alice-private', bob), (error) => error.code === 'WURST_FS_FORBIDDEN');
store.unlockRealm('alice-private', alice);
assert.equal((await store.read('/data/alice-private/dreams/secret.txt')).data.toString(), 'flying pigs');
assert.equal(JSON.stringify(store.root).includes('dreams/secret.txt'), false, 'sealed filenames must not leak through the public commit root');
assert.equal(bytes().includes(Buffer.from('dreams/secret.txt')), false, 'sealed filenames must not leak anywhere in the Wurst bytes');
assert.equal(bytes().includes(Buffer.from('flying pigs')), false, 'sealed content must not leak anywhere in the Wurst bytes');

// Sharing a sealed realm only adds a recipient key-wrap. Bob can open the same
// data after Alice grants him read/write; no server and no previous Wurst use.
await store.grant('alice-private', bob.publicRecord, { read: true, write: true }, { actor: alice });
store.lockRealm('alice-private');
store.unlockRealm('alice-private', bob);
assert.equal((await store.read('/data/alice-private/dreams/secret.txt')).data.toString(), 'flying pigs');
tx = store.beginWrite('/data/alice-private/dreams/humpe.txt', { actor: bob, mime: 'text/plain' });
await store.writeChunk(tx, Buffer.from('tractor dream'));
await store.commitWrite(tx);

// Write revocation becomes effective in the next signed policy state. Read
// revocation on sealed data is deliberately refused until a rekey operation can
// re-encrypt the current snapshot.
await store.revoke('alice-private', bob.publicRecord.identityId, { write: true }, { actor: alice });
assert.throws(() => store.beginWrite('/data/alice-private/dreams/nope.txt', { actor: bob }), (error) => error.code === 'WURST_FS_FORBIDDEN');
await assert.rejects(() => store.revoke('alice-private', bob.publicRecord.identityId, { read: true }, { actor: alice }), (error) => error.code === 'WURST_FS_REKEY_REQUIRED');
store.unlockRealm('alice-private', alice);
await store.rekeyRealm('alice-private', { actor: alice, removeReaders: [bob.publicRecord.identityId] });
store.lockRealm('alice-private');
assert.throws(() => store.unlockRealm('alice-private', bob), (error) => error.code === 'WURST_FS_FORBIDDEN');
store.unlockRealm('alice-private', alice);
assert.equal((await store.read('/data/alice-private/dreams/secret.txt')).data.toString(), 'flying pigs');

const validHistory = await store.history();
assert.equal(validHistory.valid, true);
assert.equal(validHistory.root.format, WURST_FS_V2_FORMAT);
assert.ok(validHistory.commits.length >= 6);
const bobCommit = validHistory.commits.find((commit) => commit.actor === bob.publicRecord.identityId);
assert.ok(bobCommit, 'history should contain Bob\'s signed mutation');
assert.equal(bobCommit.actorIdentity?.name, 'Bauer Humpe', 'unknown signers carry a public Identity record for human-readable offline presentation');
assert.equal(verifyWursterIdentityRecord(bobCommit.actorIdentity).valid, true);

// Reader-side authorization is not merely a writer convenience. Append a
// perfectly valid Charlie signature over a state he was NOT allowed to mutate.
// The physical WRST record is well-formed and the signature is real, but the
// history validator rejects it because Charlie lacked write capability in the
// parent state.
const parent = structuredClone(store.root);
const forged = structuredClone(parent);
forged.generation = parent.generation + 1;
forged.previousCommitOffset = store.commitOffset;
forged.previousCommitHash = parent.commitHash;
forged.committedAt = Date.now();
forged.realms.shared.stats.logicalBytes = Number(forged.realms.shared.stats.logicalBytes ?? 0) + 1;
forged.mutation = {
  format: WURST_FS_V2_MUTATION_FORMAT,
  actor: charlie.publicRecord.identityId,
  changes: [{ realm: 'shared', created: false, deleted: false, policy: false, content: true }],
  operations: [{ type: 'forged-write', realm: 'shared', path: 'grill/votes/humpe.json' }]
};
forged.authorization = null;
forged.stateHash = computeWurstFs2StateHash(forged);
forged.authorization = signWursterIdentityPayload(charlie, {
  format: WURST_FS_V2_FORMAT,
  historyMode: forged.historyMode,
  generation: forged.generation,
  previousCommitHash: forged.previousCommitHash,
  stateHash: forged.stateHash
}, { context: WURST_FS_V2_COMMIT_CONTEXT });
forged.commitHash = computeWurstFs2CommitHash(forged);
const beforeForgery = bytes();
const forgedRecord = makeFsRecord(WURST_FS_RECORD.COMMIT, Buffer.from(JSON.stringify(forged)), {
  recordStart: beforeForgery.length,
  previousCommitOffset: store.commitOffset,
  sequence: 999
});
const forgedBytes = Buffer.concat([beforeForgery, forgedRecord]);
const forgedSource = {
  size: forgedBytes.length,
  async read(offset, length) { return Buffer.from(forgedBytes.subarray(offset, offset + length)); }
};
await assert.rejects(() => verifyWurstFs2History(forgedSource, base.length), /not authorized/);

// Two valid USB-stick copies can diverge. Both branches remain cryptographically
// valid and Wurster can identify the relationship as a fork rather than silently
// pretending one is the canonical truth.
const commonBytes = bytes();
async function branchFromCommon(actor, file, text) {
  let backing = Buffer.from(commonBytes);
  const branchSource = { size: backing.length, async read(offset, length) { return Buffer.from(backing.subarray(offset, offset + length)); } };
  const { WurstFs2Store } = await import('../packages/format/src/index.js');
  const branch = new WurstFs2Store({
    source: branchSource,
    baseOffset: base.length,
    append: async (chunk) => { backing = Buffer.concat([backing, Buffer.from(chunk)]); branchSource.size = backing.length; },
    sync: async () => {}
  });
  await branch.init();
  const write = branch.beginWrite(`/data/shared/${file}`, { actor, mime: 'text/plain' });
  await branch.writeChunk(write, Buffer.from(text));
  await branch.commitWrite(write);
  return branch.history();
}
const left = await branchFromCommon(alice, 'alice.txt', 'left branch');
const right = await branchFromCommon(bob, 'bob.txt', 'right branch');
assert.equal(compareWurstFs2Histories(left, right).relation, 'fork');

// WursterLab-style handoff: the operator can keep a sealed realm in the same
// binary while an unrelated tool/agent mutates only an explicitly open public
// workspace realm without possessing any identity secret.
const handoffBase = Buffer.from('WURSTER-LAB-BASE');
const { store: handoff } = await createMemoryWurstFs2Store(handoffBase);
await handoff.initialize({
  actor: alice,
  realms: [
    { id: 'workspace' },
    { id: 'operator', governance: 'personal' }
  ]
});
let operatorTx = handoff.beginWrite('/data/operator/authority/issuer.wurstissuer', { actor: alice, mime: 'application/octet-stream' });
await handoff.writeChunk(operatorTx, Buffer.from('encrypted-operator-material'));
await handoff.commitWrite(operatorTx);
handoff.lockRealm('operator');
const workspaceTx = handoff.beginWrite('/data/workspace/package.json', { actor: null, mime: 'application/json' });
await handoff.writeChunk(workspaceTx, Buffer.from('{"version":"0.20.0"}'));
await handoff.commitWrite(workspaceTx);
assert.equal((await handoff.read('/data/workspace/package.json')).data.toString(), '{"version":"0.20.0"}');
await assert.rejects(() => handoff.list('/data/operator'), (error) => error.code === 'WURST_FS_LOCKED');
handoff.unlockRealm('operator', alice);
assert.equal((await handoff.read('/data/operator/authority/issuer.wurstissuer')).data.toString(), 'encrypted-operator-material');
assert.equal((await handoff.history()).valid, true);
handoff.close();

// WRST v7 can carry the new realm tail without changing the immutable container
// version. The manifest opts in with data-realms-1 and the normal reader exposes
// realm-aware stat/list/read plus signed history verification.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurst-fs2-'));
try {
  const file = path.join(temp, 'realms.wurst');
  const wrst = encodeWurst({
    manifest: {
      format: 'wurst/7', id: 'io.wrst.realms-test', name: 'Realms Test', version: '0.20.0', entry: 'index.html', type: 'widget',
      application: { protection: 'public' }, protection: { storedIdentity: true }, capabilities: {},
      data: { format: 'wurst/data-realms-1', writable: true }, security: { signed: false }
    },
    files: [{ path: 'index.html', data: Buffer.from('<h1>Realms</h1>'), scope: 'app', mime: 'text/html' }]
  });
  await fs.writeFile(file, wrst);
  let reader = await openWurstFile(file);
  const diskStore = await openLocalWurstFsStore(file, reader);
  await diskStore.initialize({
    actor: alice,
    realms: [{ id: 'club', governance: 'shared', audit: 'signed', protection: 'public', access: { read: { mode: 'public' }, write: { mode: 'members', identities: [alice.publicRecord.identityId] }, admins: [alice.publicRecord.identityId] } }]
  });
  const diskTx = diskStore.beginWrite('/data/club/hello.txt', { actor: alice, mime: 'text/plain' });
  await diskStore.writeChunk(diskTx, Buffer.from('portable pork'));
  await diskStore.commitWrite(diskTx);
  await diskStore.closeFile();
  await reader.close();
  reader = await openWurstFile(file);
  assert.equal(reader.wurstFsRoot.format, WURST_FS_V2_FORMAT);
  assert.equal((await reader.fsReadRange('/data/club/hello.txt')).data.toString(), 'portable pork');
  assert.equal((await reader.fsHistory()).valid, true);
  await reader.close();
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

store.close();
console.log('✓ Wurster Identity derives separate Ed25519 signing and X25519 encryption keys from a portable Meatphrase');
console.log('✓ WurstFS v2 realms support public, identity-private and shared encrypted data in one Wurst');
console.log('✓ WurstFS v2 write/admin capabilities are enforced by signed parent-state transitions');
console.log('✓ Unauthorized but cryptographically genuine mutations are detected as forged filesystem history');
console.log('✓ Sealed realm readers receive portable X25519 key-wraps and read revocation rekeys the current snapshot');
console.log('✓ Offline divergent Wurst copies are detected as valid forks instead of silently overwriting provenance');
console.log('✓ One Wurst can carry an opaque owner-only operator realm while an anonymous/open workspace realm is safely updated by another party');
