import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  desktopEdgeRuntimeTargets,
  parseChecksumFile,
  prepareEdgeRuntimeTargets,
  verifyEdgeRuntimeDirectory
} from '../tools/wurster-edge-runtime.mjs';
import { edgeWasixRuntimeTarget } from '@wurster/pigsty';
import { shouldBundlePigsty } from '../tools/build-desktop-runtime.mjs';

assert.equal(edgeWasixRuntimeTarget('linux', 'x64'), 'linux-amd64');
assert.equal(edgeWasixRuntimeTarget('darwin', 'arm64'), 'darwin-arm64');
assert.equal(edgeWasixRuntimeTarget('darwin', 'x64'), 'darwin-amd64');
assert.equal(edgeWasixRuntimeTarget('win32', 'x64'), 'windows-amd64');

assert.equal(shouldBundlePigsty({}), false);
assert.equal(shouldBundlePigsty({ WURSTER_BUNDLE_PIGSTY: '0' }), false);
assert.equal(shouldBundlePigsty({ WURSTER_BUNDLE_PIGSTY: 'true' }), true);

assert.deepEqual(desktopEdgeRuntimeTargets('windows', 'x64'), ['windows-amd64']);
assert.deepEqual(desktopEdgeRuntimeTargets('linux', 'x64'), ['linux-amd64']);
assert.deepEqual(desktopEdgeRuntimeTargets('mac', 'arm64'), ['darwin-arm64']);
assert.deepEqual(desktopEdgeRuntimeTargets('mac', 'x64'), ['darwin-amd64']);
assert.deepEqual(desktopEdgeRuntimeTargets('mac', 'universal'), ['darwin-arm64', 'darwin-amd64']);
assert.throws(() => desktopEdgeRuntimeTargets('windows', 'arm64'), /Unsupported Windows/);

assert.equal(
  parseChecksumFile(`${'a'.repeat(64)}  wurster-edge-runtime-linux-amd64.tar.gz\n`, 'wurster-edge-runtime-linux-amd64.tar.gz'),
  'a'.repeat(64)
);
assert.throws(() => parseChecksumFile(`${'b'.repeat(64)}  other.tar.gz\n`, 'wanted.tar.gz'), /does not contain/);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-edge-packaging-test-'));
try {
  const sourceRoot = path.join(tempRoot, 'source');
  const stageRoot = path.join(tempRoot, 'runtime', 'desktop', 'runtimes');
  const lockFile = path.join(tempRoot, 'runtime', 'edge-runtime.lock.json');
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  await fs.writeFile(lockFile, JSON.stringify({
    format: 'wurster/edge-runtime-lock-1',
    repository: 'WRST-IO/wurster-edge-runtime',
    tag: 'v0.1.0-test',
    checksumAsset: 'SHA256SUMS',
    targets: {
      'linux-amd64': { asset: 'wurster-edge-runtime-linux-amd64.tar.gz', archiveFormat: 'tar.gz' },
      'darwin-arm64': { asset: 'wurster-edge-runtime-darwin-arm64.tar.gz', archiveFormat: 'tar.gz' },
      'darwin-amd64': { asset: 'wurster-edge-runtime-darwin-amd64.tar.gz', archiveFormat: 'tar.gz' },
      'windows-amd64': { asset: 'wurster-edge-runtime-windows-amd64.zip', archiveFormat: 'zip' }
    }
  }, null, 2));

  for (const target of ['linux-amd64', 'darwin-arm64', 'darwin-amd64', 'windows-amd64']) {
    await createFakeBundle(path.join(sourceRoot, `wurster-edge-runtime-${target}`), target);
  }

  const stale = path.join(stageRoot, 'wurster-edge-runtime-stale-amd64');
  await fs.mkdir(stale, { recursive: true });
  await fs.writeFile(path.join(stale, 'junk'), 'stale');

  const prepared = await prepareEdgeRuntimeTargets({
    targets: ['darwin-arm64', 'darwin-amd64'],
    root: tempRoot,
    lockFile,
    stageRoot,
    env: { WURSTER_EDGE_RUNTIME_SOURCE_DIR: sourceRoot }
  });
  assert.deepEqual(prepared.targets.map((item) => item.target), ['darwin-arm64', 'darwin-amd64']);
  assert.equal(prepared.targets.every((item) => item.source === 'local'), true);
  await assert.rejects(fs.stat(stale), /ENOENT/);
  assert.equal((await verifyEdgeRuntimeDirectory(path.join(stageRoot, 'wurster-edge-runtime-darwin-arm64'), { target: 'darwin-arm64' })).version, '0.1.0-test');
  assert.equal((await verifyEdgeRuntimeDirectory(path.join(stageRoot, 'wurster-edge-runtime-darwin-amd64'), { target: 'darwin-amd64' })).version, '0.1.0-test');

  await prepareEdgeRuntimeTargets({
    targets: ['windows-amd64'],
    root: tempRoot,
    lockFile,
    stageRoot,
    env: { WURSTER_EDGE_RUNTIME_SOURCE_DIR: sourceRoot }
  });
  await assert.rejects(fs.stat(path.join(stageRoot, 'wurster-edge-runtime-darwin-arm64')), /ENOENT/);
  const windowsManifest = await verifyEdgeRuntimeDirectory(path.join(stageRoot, 'wurster-edge-runtime-windows-amd64'), { target: 'windows-amd64' });
  assert.equal(windowsManifest.target, 'windows-amd64');
  assert.equal(await fs.readFile(path.join(stageRoot, 'wurster-edge-runtime-windows-amd64', 'bin', 'edge.exe'), 'utf8'), 'fake edge windows-amd64\n');
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log('✓ Wurster Edge runtime packaging stages verified per-platform bundles without carrying binaries in the repository');

async function createFakeBundle(root, target) {
  const windows = target.startsWith('windows-');
  const files = {
    [`bin/edge${windows ? '.exe' : ''}`]: `fake edge ${target}\n`,
    [`bin/wasmer${windows ? '.exe' : ''}`]: `fake wasmer ${target}\n`,
    'share/edge-wasix/wasmer.toml': '[package]\nname = "edge-wasix"\n',
    'share/edge-wasix/edgejs.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
  };
  const manifestFiles = [];
  for (const [relative, value] of Object.entries(files)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const absolute = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, data);
    manifestFiles.push({
      path: relative,
      sha256: createHash('sha256').update(data).digest('hex')
    });
  }
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    name: 'wurster-edge-runtime',
    version: '0.1.0-test',
    target,
    files: manifestFiles
  }, null, 2));
}
