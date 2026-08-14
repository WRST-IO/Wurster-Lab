import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { SEALED_APP_INDEX_PATH, SIGNATURE_PATH, createAuthorityIssuer, createAuthorityRoot, createMemoryPigFsStore, createPackageSignature, createPublisherCertificateFromIssuer, createPublisherCertificateRequest, createPublisherKeyBundle, createTrustBundle, decodeWurst, encodeWurst, openWurstFile, sealApplicationFiles } from '../packages/format/src/index.js';
import { MessagePortWurstSource, WurstWebReader, WurstWebPigFsOverlay, WursterWebSession, verifyPublisherCertificateWeb, verifyTrustBundleWeb } from '../runtime/web/src/wurster-web.mjs';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
if (!globalThis.location) globalThis.location = { origin: 'https://wurster.test', href: 'https://wurster.test/player' };

const manifest = {
  format: 'wurst/7', id: 'io.wrst.web-test', name: 'Web Test Pig', version: '0.20.0', entry: 'index.html',
  application: { protection: 'public' }, pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'files', label: 'Files', mount: '/files' }] }, capabilities: []
};
const immutable = encodeWurst({ manifest, files: [
  { path: 'index.html', data: Buffer.from('<!doctype html><script src="./app.js"></script><img src="./assets/pig.png">'), mime: 'text/html; charset=utf-8', scope: 'app' },
  { path: 'app.js', data: Buffer.from('console.log("oink web")'), mime: 'text/javascript; charset=utf-8', scope: 'app' },
  { path: 'assets/pig.png', data: Buffer.from([1,2,3,4]), mime: 'image/png', scope: 'app' }
]});
const memoryFs = await createMemoryPigFsStore(immutable);
await memoryFs.store.initialize({ realms: [{ id: 'files', label: 'Files', mount: '/files' }] });
let seedTx = memoryFs.store.beginWrite('/files/flights/demo.json', { mime: 'application/json' });
await memoryFs.store.writeChunk(seedTx, Buffer.from('{"route":"EDDM-LOWI"}'));
await memoryFs.store.commitWrite(seedTx);
const encoded = memoryFs.bytes();
memoryFs.store.close();

const reader = await WurstWebReader.open(new Blob([encoded]));
assert.equal(reader.manifest.name, 'Web Test Pig');
assert.equal(new TextDecoder().decode((await reader.read('app.js')).data).includes('oink web'), true);
assert.equal((await reader.pigFsStat('/files/flights/demo.json')).size, 21);
assert.equal(new TextDecoder().decode(await reader.pigFsReadRange('/files/flights/demo.json', 10, 9)), 'EDDM-LOWI');

const overlay = new WurstWebPigFsOverlay(reader, { sessionId: 'web-test' });
const tx = await overlay.beginWrite('/files/media/chunky.bin', { mime: 'application/octet-stream' });
const first = new Uint8Array(4 * 1024 * 1024).fill(0x11);
const second = new Uint8Array(4 * 1024 * 1024).fill(0x22);
const third = new Uint8Array(257).fill(0x33);
await overlay.writeChunk(tx.id, first);
await overlay.writeChunk(tx.id, second);
await overlay.writeChunk(tx.id, third);
const liveSession = overlay.sessions.get(tx.id);
assert.deepEqual(Object.keys(liveSession).sort(), ['mime','path','size','sizes']);
assert.equal(liveSession.size, first.length + second.length + third.length);
await overlay.commitWrite(tx.id);
const crossing = await overlay.read('/files/media/chunky.bin', { offset: first.length - 8, length: 24 });
assert.deepEqual([...crossing.subarray(0,8)], Array(8).fill(0x11));
assert.deepEqual([...crossing.subarray(8)], Array(16).fill(0x22));
assert.equal((await overlay.stat('/files/media/chunky.bin')).size, first.length + second.length + third.length);
assert.equal((await overlay.capabilities()).streamingWrite, true);

// Renaming a file from the immutable PigFS base must be metadata-only in the
// overlay; it must not first materialize the complete base file into JS memory.
await overlay.rename('/files/flights/demo.json', '/files/flights/renamed.json');
assert.equal(await overlay.stat('/files/flights/demo.json'), null);
assert.equal(new TextDecoder().decode(await overlay.read('/files/flights/renamed.json')), '{"route":"EDDM-LOWI"}');

await overlay.write('/files/flights/next.json', '{"route":"KJFK-KBOS"}', { mime: 'application/json' });
assert.equal((await overlay.stat('/files/flights/next.json')).mime, 'application/json');
assert.equal(new TextDecoder().decode(await overlay.read('/files/flights/next.json')).includes('KJFK'), true);

const runtimeSession = new WursterWebSession(reader, { sessionId: 'serve-test' });
const htmlResponse = await runtimeSession._serve({ scope: 'app', path: 'index.html', method: 'GET', range: null });
const servedHtml = new TextDecoder().decode(new Uint8Array(htmlResponse.body));
assert.match(servedHtml, /src="\.\/app\.js"/);
assert.match(servedHtml, /src="\.\/assets\/pig\.png"/);
assert.doesNotMatch(servedHtml, /wurst:\/\//i);
const headResponse = await runtimeSession._serve({ scope: 'pigfs', path: 'files/flights/demo.json', method: 'HEAD', range: 'bytes=-4' });
assert.equal(headResponse.status, 206);
assert.equal(headResponse.headers['Content-Length'], '4');
assert.equal(headResponse.body, null);
await runtimeSession.fs.dispose();

const snapshot = await overlay.snapshotBlob();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-web-'));
try {
  const out = path.join(tmp, 'snapshot.wurst');
  await fs.writeFile(out, Buffer.from(await snapshot.arrayBuffer()));
  const reopened = await openWurstFile(out);
  try {
    assert.equal(await reopened.pigFsStat('/files/flights/demo.json'), null);
    assert.equal((await reopened.pigFsStat('/files/flights/renamed.json')).size, 21);
    assert.equal((await reopened.pigFsStat('/files/flights/next.json')).size, 21);
    assert.equal((await reopened.pigFsStat('/files/media/chunky.bin')).size, first.length + second.length + third.length);
    assert.equal((await reopened.pigFsReadRange('/files/flights/next.json', 10, 9)).data.toString(), 'KJFK-KBOS');
  } finally { await reopened.close(); }
} finally { await fs.rm(tmp, { recursive: true, force: true }); }
await overlay.dispose();
console.log('✓ Wurster Web keeps normal relative resources, uses chunk-backed PigFS writes/ranges and exports a valid standalone snapshot');

// Public PigFS paths follow realm mounts, not realm ids.
const mountedManifest = {
  format: 'wurst/7', id: 'io.wrst.web-mounted', name: 'Mounted Web Pig', version: '0.32.1', entry: 'index.html',
  application: { protection: 'public' }, pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'records', label: 'Workspace', mount: '/workspace' }] }, capabilities: []
};
const mountedBase = encodeWurst({ manifest: mountedManifest, files: [{ path: 'index.html', data: Buffer.from('<h1>mounted</h1>'), mime: 'text/html; charset=utf-8', scope: 'app' }] });
const mountedFs = await createMemoryPigFsStore(mountedBase);
await mountedFs.store.initialize({ realms: [{ id: 'records', label: 'Workspace', mount: '/workspace' }] });
let mountedTx = mountedFs.store.beginWrite('/workspace/state.txt', { mime: 'text/plain' });
await mountedFs.store.writeChunk(mountedTx, Buffer.from('mounted-oink'));
await mountedFs.store.commitWrite(mountedTx);
const mountedReader = await WurstWebReader.open(new Blob([mountedFs.bytes()]));
mountedFs.store.close();
assert.equal(new TextDecoder().decode(await mountedReader.pigFsReadRange('/workspace/state.txt')), 'mounted-oink');
assert.equal((await mountedReader.pigFsStat('/workspace/state.txt')).realm, 'records');
await assert.rejects(() => mountedReader.pigFsStat('/records/state.txt'), (error) => error?.code === 'PIG_FS_OUTSIDE_MOUNTS');
const mountedOverlay = new WurstWebPigFsOverlay(mountedReader, { sessionId: 'mounted-overlay' });
await mountedOverlay.write('/workspace/new.txt', 'new-oink', { mime: 'text/plain' });
assert.equal(new TextDecoder().decode(await mountedOverlay.read('/workspace/new.txt')), 'new-oink');
await mountedOverlay.dispose();
console.log('✓ Wurster Web resolves PigFS paths through declared mounts instead of exposing realm ids');

// Embedded writable Wursts persist a standalone child snapshot through the runtime callback.
let persistedSnapshot = null;
const persistentSession = await WursterWebSession.open(new Blob([encoded]), {
  sessionId: 'embed-persistence-test',
  persistSnapshot: async (blob) => { persistedSnapshot = new Uint8Array(await blob.arrayBuffer()); return { persisted: true, size: blob.size }; }
});
await persistentSession._invoke('pigfs.write', ['/files/embed-state.txt', 'persisted-oink', { mime: 'text/plain' }]);
assert.ok(persistedSnapshot?.byteLength > 0, 'PigFS mutation should emit a standalone child snapshot');
const persistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-web-persist-'));
try {
  const persistPath = path.join(persistDir, 'child.wurst');
  await fs.writeFile(persistPath, persistedSnapshot);
  const persisted = await openWurstFile(persistPath);
  try { assert.equal((await persisted.pigFsReadRange('/files/embed-state.txt', 0, 64)).data.toString(), 'persisted-oink'); }
  finally { await persisted.close(); }
} finally { await fs.rm(persistDir, { recursive: true, force: true }); }
await persistentSession.fs.dispose();
console.log('✓ Wurster Web persists writable embedded PigFS state as a reopenable child Wurst snapshot');

const delegatedCalls = [];
const delegatedSession = await WursterWebSession.open(new Blob([encoded]), {
  sessionId: 'parent-grant-test',
  parent: { pigfs: { access: 'read' } },
  parentInvoke: async (method, args) => { delegatedCalls.push({ method, args }); return method === 'pigfs.list' ? [{ path: '/apps', type: 'directory' }] : true; }
});
assert.deepEqual(await delegatedSession._invoke('parent.pigfs.list', ['/']), [{ path: '/apps', type: 'directory' }]);
await assert.rejects(() => delegatedSession._invoke('parent.pigfs.write', ['/oops.txt', 'nope']), /read-only/i);
assert.deepEqual(delegatedCalls.map((item) => item.method), ['pigfs.list']);
await delegatedSession.fs.dispose();
console.log('✓ Wurster Web exposes Parent PigFS only through explicit per-embed read/read-write grants');


const webRootPhrase = 'webroot-one webroot-two webroot-three webroot-four webroot-five webroot-six webroot-seven webroot-eight webroot-nine webroot-ten webroot-eleven webroot-twelve webroot-thirteen webroot-fourteen webroot-fifteen webroot-sixteen webroot-seventeen webroot-eighteen webroot-nineteen webroot-twenty webroot-twentyone webroot-twentytwo webroot-twentythree webroot-twentyfour';
const webIssuerPhrase = 'webissuer-one webissuer-two webissuer-three webissuer-four webissuer-five webissuer-six webissuer-seven webissuer-eight webissuer-nine webissuer-ten webissuer-eleven webissuer-twelve webissuer-thirteen webissuer-fourteen webissuer-fifteen webissuer-sixteen';
const webPublisherPhrase = 'webpublisher-one webpublisher-two webpublisher-three webpublisher-four webpublisher-five webpublisher-six webpublisher-seven webpublisher-eight webpublisher-nine webpublisher-ten webpublisher-eleven webpublisher-twelve';
const webRoot = createAuthorityRoot({ authority: 'web.test', name: 'Web Test Root', meatphrase: webRootPhrase, createdAt: '2026-01-01T00:00:00.000Z' });
const webIssuer = createAuthorityIssuer({ rootMeatphrase: webRootPhrase, rootPublic: webRoot.publicRecord, authority: 'web.test', issuerId: 'web-test-issuer-1', name: 'Web Test Issuer', issuerMeatphrase: webIssuerPhrase, issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' });
const webTrustBundle = createTrustBundle({ rootMeatphrase: webRootPhrase, rootPublic: webRoot.publicRecord, authority: 'web.test', version: 1, issuers: [webIssuer.certificate], generatedAt: '2026-01-01T00:00:00.000Z' });
const webPublisher = createPublisherKeyBundle({ domain: 'publisher.web.test', label: 'Web Test Publisher', meatphrase: webPublisherPhrase });
const webRequest = createPublisherCertificateRequest(webPublisher.bundle, webPublisherPhrase);
const webCertificate = createPublisherCertificateFromIssuer({ request: webRequest, issuerBundle: webIssuer.bundle, issuerMeatphrase: webIssuerPhrase, issuerCertificate: webIssuer.certificate, claims: [{ type: 'domain', value: 'publisher.web.test', verification: { method: 'test-fixture' } }], issuedAt: '2026-01-02T00:00:00.000Z', expiresAt: '2029-01-01T00:00:00.000Z' });
const injectedWebTrust = await verifyPublisherCertificateWeb(webCertificate, new Date('2026-08-12T11:00:00.000Z'), [webRoot.publicRecord], webTrustBundle);
assert.equal(injectedWebTrust.status, 'verified');
assert.equal(injectedWebTrust.root.authority, 'web.test');
const bundledWebTrust = await verifyTrustBundleWeb();
assert.equal(bundledWebTrust.status, 'verified', 'The currently bundled WRST.IO trust data must verify against its currently pinned public root, whether development or production');
assert.equal(bundledWebTrust.root.authority, 'wrst.io');

const trustedManifest = { ...manifest, id: 'io.wrst.web-authority', name: 'Authority Web Pig', version: '0.20.0', security: { signed: true } };
const trustedFiles = [{ path: 'index.html', data: Buffer.from('<h1>trusted pig</h1>'), mime: 'text/html; charset=utf-8', scope: 'app' }];
const unsignedTrusted = decodeWurst(encodeWurst({ manifest: trustedManifest, files: trustedFiles }));
const signatureRecord = createPackageSignature(unsignedTrusted, webPublisher.bundle, webPublisherPhrase, { certificate: webCertificate });
const trustedWurst = encodeWurst({ manifest: trustedManifest, files: [...trustedFiles, { path: SIGNATURE_PATH, data: Buffer.from(JSON.stringify(signatureRecord)), mime: 'application/json', scope: 'signature' }] });
const trustedReader = await WurstWebReader.open(new Blob([trustedWurst]));
const trustedSignature = await trustedReader.verifySignature();
assert.equal(trustedSignature.status, 'signed');
assert.equal(trustedSignature.certificateTrust?.status, 'valid-untrusted', 'A cryptographically valid certificate from an unpinned test root must not be promoted to trusted by the runtime');
console.log('✓ Wurster Web verifies injected Authority chains offline and keeps unpinned roots explicitly untrusted');

// WurstKey application protection is conforming in the browser runtime too.
const demoWurstKey = 'wurstkey-v1-1DPX-T3YW-RW31-7EQA-7VR2-KR78-32SB-Y3ZM-SRV0-C88K-RQV3-F6GH-X3NS';
const partialManifest = {
  format: 'wurst/7', id: 'io.wrst.web-partial', name: 'Partial Web Pig', version: '0.20.0', entry: 'index.html',
  application: { protection: 'partial' }, security: { signed: false }, capabilities: ['storage.local', 'camera']
};
const partialSealed = sealApplicationFiles({ manifest: partialManifest, wurstKey: demoWurstKey, files: [
  { path: 'index.html', data: Buffer.from('<!doctype html><h1>public shell</h1>'), mime: 'text/html; charset=utf-8', scope: 'app' },
  { path: 'classified.js', data: Buffer.from('export const pig = "secret-oink";'), mime: 'text/javascript; charset=utf-8', scope: 'app', sealed: true }
]});
const partialReader = await WurstWebReader.open(new Blob([encodeWurst(partialSealed)]));
const partialSession = new WursterWebSession(partialReader, { sessionId: 'partial-protection-test' });
assert.match(new TextDecoder().decode(new Uint8Array((await partialSession._serve({ scope: 'app', path: 'index.html', method: 'GET', range: null })).body)), /public shell/);
await assert.rejects(() => partialSession._serve({ scope: 'app', path: 'classified.js', method: 'GET', range: null }), /WurstKey required/);
await assert.rejects(() => partialSession.unlockApplication('wurstkey-v1-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000'), /authentication|Wrong WurstKey|protected resource/i);
await partialSession.unlockApplication(demoWurstKey);
const classified = await partialSession._serve({ scope: 'app', path: 'classified.js', method: 'GET', range: null });
assert.match(new TextDecoder().decode(new Uint8Array(classified.body)), /secret-oink/);
assert.equal((await partialSession._invoke('auth.status', ['application'])).state, 'unlocked');
const partialCapabilities = await partialSession._invoke('capabilities.list', []);
assert.deepEqual(partialCapabilities.map((item) => [item.name, item.state]), [['storage.local', 'available'], ['camera', 'unsupported']]);
await partialSession.fs.dispose();

const fullManifest = {
  format: 'wurst/7', id: 'io.wrst.web-full', name: 'Fully Sealed Web Pig', version: '0.20.0', entry: null,
  application: { protection: 'sealed', sealedIndex: SEALED_APP_INDEX_PATH }, security: { signed: false }, capabilities: []
};
const sealedMap = {
  format: 'wurst/sealed-app-map-1', entry: 'index.html',
  files: [
    { path: 'index.html', resource: '__wurst/sealed-app/r000000.wres', mime: 'text/html; charset=utf-8' },
    { path: 'app.js', resource: '__wurst/sealed-app/r000001.wres', mime: 'text/javascript; charset=utf-8' }
  ]
};
const fullSealed = sealApplicationFiles({ manifest: fullManifest, wurstKey: demoWurstKey, files: [
  { path: '__wurst/sealed-app/r000000.wres', data: Buffer.from('<!doctype html><script src="./app.js"></script><h1>sealed shell</h1>'), mime: 'application/octet-stream', scope: 'app', sealed: true },
  { path: '__wurst/sealed-app/r000001.wres', data: Buffer.from('console.log("sealed web oink")'), mime: 'application/octet-stream', scope: 'app', sealed: true },
  { path: SEALED_APP_INDEX_PATH, data: Buffer.from(JSON.stringify(sealedMap)), mime: 'application/octet-stream', scope: 'app', sealed: true }
]});
const fullSession = await WursterWebSession.open(new Blob([encodeWurst(fullSealed)]), { sessionId: 'full-protection-test', wurstKey: demoWurstKey });
assert.equal(await fullSession._entryPath(), 'index.html');
const fullHtml = await fullSession._serve({ scope: 'app', path: 'index.html', method: 'GET', range: null });
assert.match(new TextDecoder().decode(new Uint8Array(fullHtml.body)), /sealed shell/);
const fullJs = await fullSession._serve({ scope: 'app', path: 'app.js', method: 'GET', range: null });
assert.match(new TextDecoder().decode(new Uint8Array(fullJs.body)), /sealed web oink/);
await fullSession.fs.dispose();

console.log('✓ Wurster Web unlocks partial and fully sealed WurstKey application content without exposing the WurstKey to app code');


// The CDN embed host transports only bounded Wurst byte ranges over MessageChannel.
const embeddedBytes = new Uint8Array(encodeWurst(fullSealed));
const { port1: embedParentPort, port2: embedHostPort } = new MessageChannel();
embedParentPort.on('message', (message) => {
  if (message?.type !== 'wurster-source-read') return;
  const start = Number(message.position);
  const end = start + Number(message.length);
  const copy = embeddedBytes.slice(start, end);
  embedParentPort.postMessage({ type: 'wurster-source-result', id: message.id, ok: true, data: copy.buffer }, [copy.buffer]);
});
const embeddedSource = new MessagePortWurstSource(embedHostPort, embeddedBytes.byteLength);
const embeddedSession = await WursterWebSession.open(embeddedSource, { sessionId: 'embed-message-port-test', wurstKey: demoWurstKey });
assert.equal(embeddedSession.reader.manifest.id, 'io.wrst.web-full');
assert.equal(await embeddedSession._entryPath(), 'index.html');
assert.match(new TextDecoder().decode(new Uint8Array((await embeddedSession._serve({ scope: 'app', path: 'app.js', method: 'GET', range: null })).body)), /sealed web oink/);
await embeddedSession.fs.dispose();
embeddedSource.close();
embedParentPort.close();
embedHostPort.close();
console.log('✓ Wurster Web embed byte channel streams a fully sealed Wurst without exposing its WurstKey to the parent protocol');
