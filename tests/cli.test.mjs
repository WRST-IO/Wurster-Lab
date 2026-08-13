import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SEALED_APP_INDEX_PATH, createAuthorityIssuer, createAuthorityRoot, createPublisherCertificateFromIssuer, createPublisherCertificateRequest, createPublisherKeyBundle, decodeWurst, openLocalWurstFsStore, openWurstFile, unlockApplication, verifyPackageSignature } from '../packages/format/src/index.js';
import { buildWurst } from '../packages/meatgrinder/src/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'packages', 'meatgrinder', 'src', 'cli.js');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'meatgrinder-cli-'));

function run(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`CLI failed: ${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout;
}

function runFail(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0, `Expected CLI failure: ${args.join(' ')}`);
  return `${result.stdout}\n${result.stderr}`;
}

try {
  const sellerMeatphrase = path.join(tmp, 'seller.meatphrase');
  await fs.writeFile(sellerMeatphrase, 'smoked-bacon peppered-brisket cured-ham grilled-rib charred-steak mustard-pork hickory-wurst iron-chop maple-salami crispy-roast ember-belly garlic-jerky\n');

  const sellerKey = path.join(tmp, 'seller.wurstkey');
  const request = path.join(tmp, 'seller.wurstreq');
  const authorityRoot = path.join(tmp, 'root.json');
  const certificate = path.join(tmp, 'seller.wurstcert');

  run('publisher', 'create', '--email', 'wurstman@example.com', '--out', sellerKey, '--meatphrase-file', sellerMeatphrase);
  run('publisher', 'request', sellerKey, '--key-meatphrase-file', sellerMeatphrase, '--out', request);

  const rootPhrase = 'roasted-bacon grilled-brisket smoked-ham cured-rib charred-steak mustard-pork oak-wurst ember-chop maple-salami crispy-roast iron-belly garlic-jerky root-meatphrase authority-test production-fixture safe-paper-only';
  const issuerPhrase = 'smoked-kettle authority issuer cli test phrase separate from root';
  const root = createAuthorityRoot({ authority: 'cli-test.invalid', name: 'CLI Test Root', meatphrase: rootPhrase, createdAt: '2026-01-01T00:00:00.000Z' });
  const issuer = createAuthorityIssuer({ rootMeatphrase: rootPhrase, rootPublic: root.publicRecord, authority: 'cli-test.invalid', issuerId: 'cli-test-issuer-1', name: 'CLI Test Issuer', issuerMeatphrase: issuerPhrase, issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2031-01-01T00:00:00.000Z' });
  const sellerBundle = JSON.parse(await fs.readFile(sellerKey, 'utf8'));
  const requestRecord = createPublisherCertificateRequest(sellerBundle, (await fs.readFile(sellerMeatphrase, 'utf8')).trim());
  const certRecord = createPublisherCertificateFromIssuer({ request: requestRecord, issuerBundle: issuer.bundle, issuerMeatphrase: issuerPhrase, issuerCertificate: issuer.certificate, claims: [{ type: 'email', value: 'wurstman@example.com', verification: { method: 'test-fixture' } }], issuedAt: '2026-01-02T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' });
  await fs.writeFile(authorityRoot, JSON.stringify(root.publicRecord, null, 2));
  await fs.writeFile(certificate, JSON.stringify(certRecord, null, 2));

  const certOutput = run('certificate', 'inspect', certificate, '--root', authorityRoot);
  assert.match(certOutput, /status: verified/);
  assert.match(certOutput, /publisher: wurstman@example\.com/);

  const project = path.join(tmp, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'wurst.json'), JSON.stringify({
    id: 'io.wrst.cli-test',
    name: 'CLI Test Wurst',
    type: 'widget',
    entry: 'index.html',
    capabilities: { 'storage.local': true }
  }, null, 2));
  await fs.writeFile(path.join(project, 'src', 'index.html'), '<!doctype html><title>Wurst</title><h1>Wurst</h1>');

  const output = path.join(tmp, 'signed.wurst');
  run('build', project, output, '--sign', sellerKey, '--certificate', certificate, '--key-meatphrase-file', sellerMeatphrase);

  const wrstOutput = path.join(tmp, 'alias.wrst');
  run('build', project, wrstOutput);
  const wrstInspect = run('inspect', wrstOutput);
  assert.match(wrstInspect, /CLI Test Wurst/);
  assert.equal((await fs.stat(wrstOutput)).isFile(), true);

  const directKey = path.join(tmp, 'direct.wurstkey');
  const directPhrase = 'smoked-bacon direct-grinder key-meatphrase for gui signing';
  run('publisher', 'create', '--domain', 'yourwurstdomain.tld', '--label', 'Direct CLI Signer', '--out', directKey, '--meatphrase', directPhrase);
  const directOutput = path.join(tmp, 'direct-signed.wurst');
  run('build', project, directOutput, '--sign', directKey, '--key-meatphrase', directPhrase);
  const directPkg = decodeWurst(await fs.readFile(directOutput));
  const directSig = verifyPackageSignature(directPkg);
  assert.equal(directSig.valid, true);
  assert.equal(directSig.publisher.domain, 'yourwurstdomain.tld');

  const memorySigner = createPublisherKeyBundle({ domain: 'memory.example', label: 'GUI-style signer', meatphrase: 'peppered-bacon gui protected signing identity' });
  const memoryOutput = path.join(tmp, 'memory-signed.wurst');
  await buildWurst(project, memoryOutput, { publisherKeyBundle: memorySigner.bundle, publisherMeatphrase: memorySigner.meatphrase });
  const memorySig = verifyPackageSignature(decodeWurst(await fs.readFile(memoryOutput)));
  assert.equal(memorySig.valid, true);
  assert.equal(memorySig.publisher.domain, 'memory.example');
  const verifyOutput = run('verify', output, '--root', authorityRoot);
  assert.match(verifyOutput, /signature: SIGNED/);
  assert.match(verifyOutput, /publisher certificate: verified/);
  assert.match(verifyOutput, /risk: YELLOW/);

  const carrier = path.join(tmp, 'carrier.png');
  await fs.writeFile(carrier, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB8sAAAAASUVORK5CYII=', 'base64'));
  const undercover = path.join(tmp, 'undercover.png');
  const undercoverBuild = run('build', project, undercover, '--carrier', carrier);
  assert.match(undercoverBuild, /undercover carrier: PNG/);
  const undercoverBytes = await fs.readFile(undercover);
  assert.deepEqual([...undercoverBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const undercoverInspect = run('inspect', undercover);
  assert.match(undercoverInspect, /carrier: PNG/);
  assert.match(undercoverInspect, /CLI Test Wurst/);

  const zeroConfigProject = path.join(tmp, 'zero-config-pig');
  await fs.mkdir(zeroConfigProject, { recursive: true });
  await fs.writeFile(path.join(zeroConfigProject, 'index.html'), '<!doctype html><title>Zero Config</title><h1>OINK</h1>');
  await fs.writeFile(path.join(zeroConfigProject, 'app.js'), 'document.body.dataset.wurst = "ready";');
  const zeroConfigOutput = path.join(tmp, 'zero-config-pig.wurst');
  const zeroConfigBuild = run('build', zeroConfigProject, zeroConfigOutput);
  assert.match(zeroConfigBuild, /Wurst ready/);
  const zeroConfigPkg = decodeWurst(await fs.readFile(zeroConfigOutput));
  assert.equal(zeroConfigPkg.manifest.name, 'zero-config-pig');
  assert.equal(zeroConfigPkg.manifest.entry, 'index.html');
  assert.equal(zeroConfigPkg.manifest.build.generatedManifest, true);
  assert.equal(zeroConfigPkg.has('app.js'), true);

  const fsProject = path.join(tmp, 'wurst-fs-project');
  await fs.mkdir(path.join(fsProject, 'src'), { recursive: true });
  await fs.writeFile(path.join(fsProject, 'src', 'index.html'), '<h1>WurstFS</h1>');
  await fs.writeFile(path.join(fsProject, 'wurst.json'), JSON.stringify({
    id: 'io.wrst.fs-project', name: 'WurstFS Project', entry: 'index.html',
    data: { format: 'wurst/data-realms-1', writable: true, realms: [{ id: 'files' }] }
  }, null, 2));
  const fsOutput = path.join(tmp, 'fs-project.wurst');
  const fsBuild = run('build', fsProject, fsOutput);
  assert.match(fsBuild, /WurstFS: realms \/ ordinary \/ 1 genesis template/);
  const fsReader = await openWurstFile(fsOutput);
  assert.equal(fsReader.manifest.data.realms[0].id, 'files');
  assert.equal(Object.hasOwn(fsReader.manifest.data.realms[0], 'governance'), false);
  assert.equal(fsReader.wurstFsRoot, null, 'mutable runtime data starts empty rather than being baked into the immutable package');
  await fsReader.close();

  const mutableReader = await openWurstFile(fsOutput);
  const mutableStore = await openLocalWurstFsStore(fsOutput, mutableReader);
  await mutableStore.initialize({ realms: [{ id: 'files' }, { id: 'private', governance: 'personal' }] });
  const mutableTx = mutableStore.beginWrite('/data/files/hello.txt', { mime: 'text/plain' });
  await mutableStore.writeChunk(mutableTx, Buffer.from('oink'));
  await mutableStore.commitWrite(mutableTx);
  await mutableStore.closeFile();
  await mutableReader.close();
  const mutableInspect = run('inspect', fsOutput);
  assert.match(mutableInspect, /WurstFS generation: \d+ \/ 2 realm\(s\) \/ current snapshot/);

  const seededDataProject = path.join(tmp, 'seeded-data-project');
  await fs.mkdir(path.join(seededDataProject, 'src'), { recursive: true });
  await fs.mkdir(path.join(seededDataProject, 'data'), { recursive: true });
  await fs.writeFile(path.join(seededDataProject, 'src', 'index.html'), '<h1>No baked mutable data</h1>');
  await fs.writeFile(path.join(seededDataProject, 'data', 'old.txt'), 'nope');
  await fs.writeFile(path.join(seededDataProject, 'wurst.json'), JSON.stringify({
    id: 'io.wrst.seeded-data', name: 'Seeded Data', entry: 'index.html',
    data: { format: 'wurst/data-realms-1', writable: true, realms: [{ id: 'files' }] }
  }, null, 2));
  assert.match(runFail('build', seededDataProject), /runtime data starts empty|top-level data\//i);

  const nonUniversalProject = path.join(tmp, 'non-universal-project');
  await fs.mkdir(path.join(nonUniversalProject, 'src'), { recursive: true });
  await fs.writeFile(path.join(nonUniversalProject, 'src', 'index.html'), '<h1>Nope</h1>');
  await fs.writeFile(path.join(nonUniversalProject, 'wurst.json'), JSON.stringify({
    id: 'io.wrst.non-universal', name: 'Non Universal', entry: 'index.html',
    protection: { appleKeychain: true }
  }, null, 2));
  assert.match(runFail('build', nonUniversalProject), /runtime-independent/);

  const styledSecurityProject = path.join(tmp, 'styled-security-project');
  await fs.mkdir(path.join(styledSecurityProject, 'src'), { recursive: true });
  await fs.writeFile(path.join(styledSecurityProject, 'src', 'index.html'), '<h1>Nope</h1>');
  await fs.writeFile(path.join(styledSecurityProject, 'wurst.json'), JSON.stringify({
    id: 'io.wrst.styled-security', name: 'Styled Security', entry: 'index.html',
    secureSurface: { accent: '#ff6600' }
  }, null, 2));
  assert.match(runFail('build', styledSecurityProject), /secureSurface was removed/);

  const sealedProject = path.join(tmp, 'sealed-project');
  await fs.mkdir(path.join(sealedProject, 'src'), { recursive: true });
  await fs.writeFile(path.join(sealedProject, 'wurst.json'), JSON.stringify({
    id: 'io.wrst.full-sealed-test',
    name: 'Full Sealed Test',
    entry: 'index.html',
    application: { protection: 'sealed' }
  }, null, 2));
  await fs.writeFile(path.join(sealedProject, 'src', 'index.html'), '<!doctype html><script src="secret.js"></script>');
  await fs.writeFile(path.join(sealedProject, 'src', 'secret.js'), 'globalThis.TOP_SECRET = 42');
  const appWurstKey = path.join(tmp, 'app.wurstkey.txt');
  await fs.writeFile(appWurstKey, 'wurstkey-v1-055Q-PP0C-VNS5-F4H0-NETB-WGC7-P8HP-KCK0-G3CC-ME6Z-9DDP-TQCQ-HK5Z\n');
  const sealedOutput = path.join(tmp, 'fully-sealed.wurst');
  const sealedBuild = run('build', sealedProject, sealedOutput, '--wurstkey-file', appWurstKey);
  assert.match(sealedBuild, /application: sealed/);
  const sealedPkg = decodeWurst(await fs.readFile(sealedOutput));
  assert.equal(sealedPkg.manifest.entry, null);
  assert.equal(sealedPkg.has('index.html'), false);
  assert.equal(sealedPkg.has('secret.js'), false);
  assert.ok(sealedPkg.has(SEALED_APP_INDEX_PATH));
  assert.ok(sealedPkg.files().filter((file) => file.scope === 'app').every((file) => file.encryption));
  const openedSealed = unlockApplication(sealedPkg, (await fs.readFile(appWurstKey, 'utf8')).trim());
  const privateIndex = JSON.parse(openedSealed.get(SEALED_APP_INDEX_PATH).data.toString('utf8'));
  assert.equal(privateIndex.entry, 'index.html');
  assert.deepEqual(privateIndex.files.map((file) => file.path).sort(), ['index.html', 'secret.js']);
  openedSealed.destroy();

  console.log('✓ Meat Grinder CLI seller → Authority → certificate → signed Wurst → verified chain');
  console.log('✓ Meat Grinder accepts direct Meatphrase input and Wurster-style in-memory publisher signing');
  console.log('✓ Full sealed application uses a developer WurstKey and hides original app paths behind opaque resources');
  console.log('✓ Meat Grinder rejects platform-specific Wurst protection policy');
  console.log('✓ Meat Grinder rejects Wurst-controlled Wurster Auth styling');
  console.log('✓ Meat Grinder PNG carrier build produces a real inspectable Undercover Wurst');
  console.log('✓ Meat Grinder builds a normal web folder with no wurst.json');
  console.log('✓ Meat Grinder keeps runtime WurstFS empty at build time and rejects top-level mutable factory data');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
