import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FORMAT_VERSION,
  SIGNATURE_PATH,
  PIG_FS_MAX_RECORD_PAYLOAD,
  classifyRisk,
  createHttpWurstSource,
  createPackageSignature,
  createPublisherKeyBundle,
  decodeWurst,
  descriptorsFromPackage,
  embedWurstInPng,
  encodeWurst,
  extractWurstFromPng,
  generateMeatphrase,
  generateWurstKey,
  normalizeWurstKey,
  openHttpWurst,
  openWurstFile,
  sealApplicationFiles,
  unlockApplication,
  verifyPackageSignature,
  verifyPackageSignatureFromReader
} from '../packages/format/src/index.js';

function makeManifest(extra = {}) {
  return {
    format: 'wurst/7',
    id: 'io.wrst.test',
    name: 'Test Wurst',
    version: '0.20.0',
    entry: 'index.html',
    type: 'widget',
    application: { protection: 'public' },
    protection: { storedIdentity: true },
    presentation: null,
    capabilities: {},
    security: { signed: false },
    ...extra
  };
}

const binary = encodeWurst({
  manifest: makeManifest(),
  files: [
    { path: 'index.html', data: Buffer.from('<h1>Wurst</h1>'), scope: 'app' },
    { path: 'assets/value.bin', data: Buffer.from([1, 2, 3, 4]), scope: 'app' }
  ]
});
assert.equal(binary.subarray(0, 4).toString('ascii'), 'WRST');
const decoded = decodeWurst(binary);
assert.equal(decoded.version, FORMAT_VERSION);
assert.equal(decoded.manifest.format, 'wurst/7');
assert.equal(decoded.get('index.html').data.toString(), '<h1>Wurst</h1>');
const tampered = Buffer.from(binary);
tampered[decoded.baseLength - 1] ^= 0xff;
assert.throws(() => decodeWurst(tampered), /Integrity check failed/);

// Pre-1.0 has one mutable-data contract. Removed schema is rejected rather than
// carried as compatibility baggage.
assert.throws(() => encodeWurst({
  manifest: { ...makeManifest(), vault: { writable: true, protection: 'plain' } },
  files: [{ path: 'index.html', data: Buffer.from('nope'), scope: 'app' }]
}), /no longer supports vault/);
assert.throws(() => encodeWurst({
  manifest: {
    ...makeManifest(),
    pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'files', mode: 'crud' }] }
  },
  files: [{ path: 'index.html', data: Buffer.from('nope'), scope: 'app' }]
}), /mode was removed/);
assert.doesNotThrow(() => encodeWurst({
  manifest: {
    ...makeManifest(),
    pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'files' }, { id: 'private', governance: 'personal' }] }
  },
  files: [{ path: 'index.html', data: Buffer.from('ok'), scope: 'app' }]
}));
assert.throws(() => encodeWurst({
  manifest: {
    ...makeManifest(),
    pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'private', governance: 'personal', protection: 'public' }] }
  },
  files: [{ path: 'index.html', data: Buffer.from('nope'), scope: 'app' }]
}), /sealed owner-only/);
assert.throws(() => encodeWurst({
  manifest: {
    ...makeManifest(),
    pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'workspace', mount: '/workspace' }, { id: 'nested', mount: '/workspace/private' }] }
  },
  files: [{ path: 'index.html', data: Buffer.from('nope'), scope: 'app' }]
}), /overlap/i);
assert.throws(() => encodeWurst({
  manifest: {
    ...makeManifest(),
    pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'workspace', mount: '/workspace', quotaBytes: 0 }] }
  },
  files: [{ path: 'index.html', data: Buffer.from('nope'), scope: 'app' }]
}), /quota/i);
assert.throws(() => encodeWurst({
  manifest: {
    ...makeManifest(),
    pigsty: {
      format: 'wurst/pigsty-1',
      version: 'node-lts-1',
      builds: {
        site: {
          source: 'build.js',
          mode: 'node',
          outputs: ['dist']
        }
      }
    }
  },
  files: [{ path: 'index.html', data: Buffer.from('nope'), scope: 'app' }]
}), /mode is not supported/);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wurst-format-'));
try {
  const randomAccessPath = path.join(tempDir, 'random-access.wurst');
  await fs.writeFile(randomAccessPath, binary);
  const reader = await openWurstFile(randomAccessPath);
  assert.equal(reader.manifest.name, 'Test Wurst');
  assert.equal((await reader.readRange('index.html', 4, 5)).data.toString(), 'Wurst');
  assert.equal(reader.pigFsRoot, null);
  await reader.close();

  // Publisher signatures cover immutable package bytes and reject tampering.
  const publisher = createPublisherKeyBundle({ domain: 'yourwurstdomain.tld', label: 'Your Wurst Studio' });
  const signedManifest = makeManifest({ security: { signed: true } });
  const unsigned = decodeWurst(encodeWurst({ manifest: signedManifest, files: [{ path: 'index.html', data: Buffer.from('signed app'), scope: 'app' }] }));
  const signature = createPackageSignature(unsigned, publisher.bundle, publisher.meatphrase);
  const signedBinary = encodeWurst({
    manifest: signedManifest,
    files: [
      { path: 'index.html', data: Buffer.from('signed app'), scope: 'app' },
      { path: SIGNATURE_PATH, data: Buffer.from(JSON.stringify(signature)), scope: 'signature' }
    ]
  });
  const signedPkg = decodeWurst(signedBinary);
  assert.equal(verifyPackageSignature(signedPkg).status, 'signed');
  const signedPath = path.join(tempDir, 'signed.wurst');
  await fs.writeFile(signedPath, signedBinary);
  const signedReader = await openWurstFile(signedPath);
  assert.equal((await verifyPackageSignatureFromReader(signedReader)).status, 'signed');
  await signedReader.close();
  const badFiles = descriptorsFromPackage(signedPkg).map((file) => file.path === 'index.html' ? { ...file, data: Buffer.from('evil') } : file);
  assert.equal(verifyPackageSignature(decodeWurst(encodeWurst({ manifest: signedManifest, files: badFiles }))).status, 'invalid');

  // HTTP source keeps the representation pinned and uses exact byte ranges.
  const remoteBinary = Buffer.concat([binary, Buffer.alloc(3 * 1024 * 1024, 0x77)]);
  // Only the WRST prefix is meaningful here, so host the real binary for opening.
  const requests = [];
  const etag = '"wurst-v7-test"';
  const fetchImpl = async (_url, options = {}) => {
    const rangeHeader = options.headers?.Range ?? options.headers?.range;
    requests.push(rangeHeader);
    const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader ?? '');
    if (!match) return new Response(binary, { status: 200 });
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = binary.subarray(start, end + 1);
    return new Response(body, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${binary.length}`, 'content-length': String(body.length), etag } });
  };
  const remote = await openHttpWurst('https://foo.baa/example.wurst', { fetchImpl });
  assert.equal((await remote.read('index.html')).data.toString(), '<h1>Wurst</h1>');
  assert.ok(requests.every((item) => item?.startsWith('bytes=')));
  await remote.close();

  let changed = false;
  const changingFetch = async (_url, options = {}) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '');
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = binary.subarray(start, end + 1);
    const currentEtag = changed ? '"changed"' : etag;
    changed = true;
    return new Response(body, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${binary.length}`, etag: currentEtag } });
  };
  const source = await createHttpWurstSource('https://foo.baa/changing.wurst', { fetchImpl: changingFetch });
  await assert.rejects(() => source.read(0, 4), /ETag changed/);

  const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB8sAAAAASUVORK5CYII=', 'base64');
  const undercover = embedWurstInPng(onePixelPng, binary, { chunkSize: 64 * 1024 });
  assert.ok(extractWurstFromPng(undercover).equals(binary));
  assert.equal(decodeWurst(undercover).manifest.format, 'wurst/7');

  // WurstKey protection stays independent from mutable PigFS identity/data policy.
  const meatphrase = generateMeatphrase(12);
  assert.equal(meatphrase.tokens.length, 12);
  const wurstKey = generateWurstKey();
  assert.equal(wurstKey.entropyBits, 256);
  assert.equal(normalizeWurstKey(wurstKey.wurstKey.replace(/^wurstkey-v1-/, '')), wurstKey.wurstKey);
  const partial = sealApplicationFiles({
    manifest: makeManifest({ application: { protection: 'partial' } }),
    files: [
      { path: 'index.html', data: Buffer.from('<h1>Public shell</h1>'), scope: 'app' },
      { path: 'secret.js', data: Buffer.from('window.SECRET=42'), scope: 'app', sealed: true }
    ],
    wurstKey: wurstKey.wurstKey
  });
  const partialPkg = decodeWurst(encodeWurst(partial));
  assert.equal(partialPkg.get('index.html').encryption, undefined);
  assert.ok(partialPkg.get('secret.js').encryption);
  const opened = unlockApplication(partialPkg, wurstKey.wurstKey);
  assert.equal(opened.get('secret.js').data.toString(), 'window.SECRET=42');
  assert.throws(() => unlockApplication(partialPkg, generateWurstKey().wurstKey), /Wrong WurstKey/);
  opened.destroy();

  assert.equal(classifyRisk(makeManifest()).level, 'green');
  assert.equal(classifyRisk(makeManifest({ pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'files' }] } })).level, 'yellow');
  assert.equal(classifyRisk(makeManifest({ capabilities: { 'files.open': true } })).level, 'red');
  assert.equal(PIG_FS_MAX_RECORD_PAYLOAD, 4 * 1024 * 1024);

  console.log('✓ WRST v7 immutable base and random-access integrity');
  console.log('✓ Pre-1.0 removed mutable-data schemas are rejected instead of supported');
  console.log('✓ Publisher package signatures protect immutable code');
  console.log('✓ HTTP Range and Undercover PNG carriers remain valid');
  console.log('✓ WurstKey application protection stays independent from PigFS');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
