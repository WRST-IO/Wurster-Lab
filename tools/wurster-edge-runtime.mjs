import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCK_FILE = path.join(ROOT, 'runtime', 'edge-runtime.lock.json');
const DEFAULT_STAGE_ROOT = path.join(ROOT, 'runtime', 'desktop', 'runtimes');
const RUNTIME_NAME = 'wurster-edge-runtime';

export function desktopEdgeRuntimeTargets(target, arch = '') {
  const platform = String(target || '').toLowerCase();
  const cpu = String(arch || '').toLowerCase();
  if (platform === 'windows') {
    if (!['', 'x64', 'amd64'].includes(cpu)) throw new Error(`Unsupported Windows desktop architecture for Pigsty: ${arch}`);
    return ['windows-amd64'];
  }
  if (platform === 'linux') {
    if (!['', 'x64', 'amd64'].includes(cpu)) throw new Error(`Unsupported Linux desktop architecture for Pigsty: ${arch}`);
    return ['linux-amd64'];
  }
  if (platform === 'mac' || platform === 'macos') {
    if (!cpu || cpu === 'universal') return ['darwin-arm64', 'darwin-amd64'];
    if (cpu === 'arm64') return ['darwin-arm64'];
    if (cpu === 'x64' || cpu === 'amd64') return ['darwin-amd64'];
    throw new Error(`Unsupported macOS desktop architecture for Pigsty: ${arch}`);
  }
  throw new Error(`Unsupported desktop platform for Pigsty runtime staging: ${target}`);
}

export async function loadEdgeRuntimeLock({ lockFile = DEFAULT_LOCK_FILE } = {}) {
  let lock;
  try {
    lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read Wurster Edge runtime lock ${lockFile}: ${error?.message || error}`);
  }
  if (lock?.format !== 'wurster/edge-runtime-lock-1') throw new Error(`Unsupported Wurster Edge runtime lock format: ${lock?.format ?? 'missing'}`);
  if (typeof lock.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(lock.repository)) throw new Error('Wurster Edge runtime lock requires repository owner/name');
  if (typeof lock.tag !== 'string' || !lock.tag) throw new Error('Wurster Edge runtime lock requires a pinned tag');
  if (typeof lock.checksumAsset !== 'string' || !lock.checksumAsset) throw new Error('Wurster Edge runtime lock requires checksumAsset');
  if (!lock.targets || typeof lock.targets !== 'object' || Array.isArray(lock.targets)) throw new Error('Wurster Edge runtime lock requires targets');
  for (const [target, descriptor] of Object.entries(lock.targets)) {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error(`Wurster Edge runtime target ${target} requires an asset descriptor`);
    if (typeof descriptor.asset !== 'string' || !descriptor.asset) throw new Error(`Wurster Edge runtime target ${target} requires asset`);
    if (!['tar.gz', 'zip'].includes(descriptor.archiveFormat)) throw new Error(`Unsupported Wurster Edge runtime archive format for ${target}: ${descriptor.archiveFormat ?? 'missing'}`);
  }
  return lock;
}

export async function prepareDesktopEdgeRuntimes({
  target,
  arch,
  env = process.env,
  root = ROOT,
  fetchImpl = globalThis.fetch
} = {}) {
  return prepareEdgeRuntimeTargets({
    targets: desktopEdgeRuntimeTargets(target, arch),
    env,
    root,
    fetchImpl
  });
}

export async function prepareEdgeRuntimeTargets({
  targets,
  env = process.env,
  root = ROOT,
  fetchImpl = globalThis.fetch,
  lockFile = path.join(root, 'runtime', 'edge-runtime.lock.json'),
  stageRoot = path.join(root, 'runtime', 'desktop', 'runtimes')
} = {}) {
  const requested = [...new Set((targets || []).map((value) => String(value).trim()).filter(Boolean))];
  if (!requested.length) throw new Error('At least one Wurster Edge runtime target is required');

  const lock = await loadEdgeRuntimeLock({ lockFile });
  const repository = env.WURSTER_EDGE_RUNTIME_REPOSITORY || lock.repository;
  const tag = env.WURSTER_EDGE_RUNTIME_TAG || lock.tag;
  const token = env.WURSTER_EDGE_RUNTIME_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN || '';
  const explicitSource = env.WURSTER_EDGE_RUNTIME_SOURCE_DIR || null;
  const singleRuntimeDir = requested.length === 1 ? (env.WURSTER_EDGE_RUNTIME_DIR || env.PIGSTY_EDGE_RUNTIME_DIR || null) : null;

  for (const target of requested) {
    if (!lock.targets[target]) throw new Error(`Wurster Edge runtime lock has no asset for target ${target}`);
  }

  await fs.mkdir(stageRoot, { recursive: true });
  await cleanStagedEdgeRuntimes(stageRoot);

  const prepared = [];
  for (const target of requested) {
    const bundleName = `${RUNTIME_NAME}-${target}`;
    const destination = path.join(stageRoot, bundleName);
    const localSource = await resolveLocalBundleDir(explicitSource || singleRuntimeDir, target);
    if (localSource) {
      await fs.cp(localSource, destination, { recursive: true, force: true, preserveTimestamps: true });
      const manifest = await verifyEdgeRuntimeDirectory(destination, { target });
      prepared.push({ target, directory: destination, manifest, source: 'local' });
      continue;
    }

    const descriptor = lock.targets[target];
    const archiveName = descriptor.asset;
    const downloaded = await downloadReleaseBundle({
      repository,
      tag,
      archiveName,
      checksumAsset: lock.checksumAsset,
      token,
      fetchImpl
    });
    try {
      await extractReleaseBundle(downloaded.archivePath, {
        target,
        destination,
        bundleName,
        archiveFormat: descriptor.archiveFormat
      });
      const manifest = await verifyEdgeRuntimeDirectory(destination, { target });
      prepared.push({ target, directory: destination, manifest, source: `${repository}@${tag}` });
    } finally {
      await fs.rm(downloaded.tempDir, { recursive: true, force: true });
    }
  }

  return {
    repository,
    tag,
    stageRoot,
    targets: prepared
  };
}

export async function verifyEdgeRuntimeDirectory(runtimeDir, { target } = {}) {
  const root = path.resolve(runtimeDir);
  const manifestPath = path.join(root, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid Wurster Edge runtime manifest at ${manifestPath}: ${error?.message || error}`);
  }
  if (manifest?.name !== RUNTIME_NAME) throw new Error(`Unsupported Wurster Edge runtime name: ${manifest?.name ?? 'missing'}`);
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('Wurster Edge runtime manifest requires version');
  if (typeof manifest.target !== 'string' || !manifest.target) throw new Error('Wurster Edge runtime manifest requires target');
  if (target && manifest.target !== target) throw new Error(`Wurster Edge runtime target mismatch: expected ${target}, got ${manifest.target}`);
  if (!Array.isArray(manifest.files)) throw new Error('Wurster Edge runtime manifest requires files');

  const required = requiredRuntimeFilesForTarget(target || manifest.target);
  const declared = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256 || '')) throw new Error('Invalid Wurster Edge runtime file manifest entry');
    const relative = normalizeBundlePath(entry.path);
    declared.add(relative);
    const absolute = path.join(root, ...relative.split('/'));
    const stat = await fs.lstat(absolute).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error(`Wurster Edge runtime is missing manifest file: ${relative}`);
      throw error;
    });
    if (!stat.isFile()) throw new Error(`Wurster Edge runtime manifest path is not a regular file: ${relative}`);
    const digest = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
    if (digest !== entry.sha256.toLowerCase()) throw new Error(`Wurster Edge runtime hash mismatch: ${relative}`);
  }
  for (const relative of required) {
    if (!declared.has(relative)) throw new Error(`Wurster Edge runtime manifest is missing ${relative}`);
  }
  return manifest;
}

export function parseChecksumFile(text, assetName) {
  const wanted = path.posix.basename(String(assetName));
  for (const raw of String(text || '').split(/\r?\n/)) {
    const match = raw.trim().match(/^([0-9a-fA-F]{64})\s+[*]?(.+)$/);
    if (!match) continue;
    const name = path.posix.basename(match[2].trim().replaceAll('\\', '/'));
    if (name === wanted) return match[1].toLowerCase();
  }
  throw new Error(`Checksum file does not contain ${wanted}`);
}

async function downloadReleaseBundle({ repository, tag, archiveName, checksumAsset, token, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('Global fetch is unavailable; Node 22+ is required to download Wurster Edge runtimes');
  const headers = githubHeaders(token);
  const releaseUrl = `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  const releaseResponse = await fetchImpl(releaseUrl, { headers });
  if (!releaseResponse.ok) {
    const hint = releaseResponse.status === 404
      ? ` Release ${tag} is missing or the token cannot read ${repository}. For a private runtime repository set WURSTER_EDGE_RUNTIME_TOKEN to a token with Contents: read.`
      : '';
    throw new Error(`Unable to resolve Wurster Edge runtime release ${repository}@${tag}: HTTP ${releaseResponse.status}.${hint}`);
  }
  const release = await releaseResponse.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const archiveAsset = assets.find((asset) => asset?.name === archiveName);
  const checksum = assets.find((asset) => asset?.name === checksumAsset);
  if (!archiveAsset) throw new Error(`Wurster Edge runtime release ${tag} is missing asset ${archiveName}`);
  if (!checksum) throw new Error(`Wurster Edge runtime release ${tag} is missing checksum asset ${checksumAsset}`);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-edge-download-'));
  const archivePath = path.join(tempDir, archiveName);
  const checksumPath = path.join(tempDir, checksumAsset);
  try {
    await downloadGithubAsset(archiveAsset, archivePath, { token, fetchImpl });
    await downloadGithubAsset(checksum, checksumPath, { token, fetchImpl });
    const expected = parseChecksumFile(await fs.readFile(checksumPath, 'utf8'), archiveName);
    const actual = createHash('sha256').update(await fs.readFile(archivePath)).digest('hex');
    if (actual !== expected) throw new Error(`Wurster Edge runtime archive checksum mismatch for ${archiveName}`);
    return { tempDir, archivePath };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function downloadGithubAsset(asset, destination, { token, fetchImpl }) {
  const url = asset?.url || asset?.browser_download_url;
  if (!url) throw new Error(`GitHub release asset ${asset?.name ?? '<unknown>'} has no download URL`);
  const headers = githubHeaders(token, { binary: Boolean(asset?.url) });
  const response = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`Unable to download Wurster Edge runtime asset ${asset?.name ?? url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, data);
}

function githubHeaders(token, { binary = false } = {}) {
  const headers = {
    Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
    'User-Agent': 'Wurster-Lab-edge-runtime-fetcher',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function extractReleaseBundle(archivePath, { target, destination, bundleName, archiveFormat }) {
  const listArgs = archiveFormat === 'zip' ? ['-tf', archivePath] : ['-tzf', archivePath];
  const extractArgs = archiveFormat === 'zip' ? ['-xf', archivePath] : ['-xzf', archivePath];
  const entries = (await runTar(listArgs)).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!entries.length) throw new Error(`Wurster Edge runtime archive is empty: ${archivePath}`);
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/').replace(/\/$/, '');
    if (!normalized) continue;
    if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) throw new Error(`Unsafe Wurster Edge runtime archive path: ${entry}`);
    if (normalized !== bundleName && !normalized.startsWith(`${bundleName}/`)) throw new Error(`Wurster Edge runtime archive has unexpected top-level path: ${entry}`);
  }

  const extractRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-edge-extract-'));
  try {
    await runTar([...extractArgs, '-C', extractRoot]);
    const extracted = path.join(extractRoot, bundleName);
    await verifyEdgeRuntimeDirectory(extracted, { target });
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(extracted, destination, { recursive: true, force: true, preserveTimestamps: true });
  } finally {
    await fs.rm(extractRoot, { recursive: true, force: true });
  }
}

async function runTar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`Unable to start tar while preparing Wurster Edge runtime: ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`tar was terminated by ${signal}`));
      if (code !== 0) return reject(new Error(`tar failed with exit code ${code}: ${stderr.trim() || 'no error output'}`));
      resolve({ stdout, stderr });
    });
  });
}

async function cleanStagedEdgeRuntimes(stageRoot) {
  const entries = await fs.readdir(stageRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(entries
    .filter((entry) => entry.name.startsWith(`${RUNTIME_NAME}-`))
    .map((entry) => fs.rm(path.join(stageRoot, entry.name), { recursive: true, force: true })));
}

async function resolveLocalBundleDir(sourceRoot, target) {
  if (!sourceRoot) return null;
  const root = path.resolve(String(sourceRoot));
  const candidates = [root, path.join(root, `${RUNTIME_NAME}-${target}`)];
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'manifest.json'), 'utf8'));
      if (manifest?.name === RUNTIME_NAME && manifest?.target === target) return candidate;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
  }
  throw new Error(`Local Wurster Edge runtime source does not contain target ${target}: ${root}`);
}

function requiredRuntimeFilesForTarget(target) {
  const windows = String(target).startsWith('windows-');
  const exe = windows ? '.exe' : '';
  return [
    `bin/edge${exe}`,
    `bin/wasmer${exe}`,
    'share/edge-wasix/wasmer.toml',
    'share/edge-wasix/edgejs.wasm'
  ];
}

function normalizeBundlePath(raw) {
  const relative = String(raw || '').replaceAll('\\', '/');
  if (!relative || relative.startsWith('/') || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid Wurster Edge runtime file path: ${raw}`);
  return relative;
}

async function cli(argv = process.argv.slice(2)) {
  const [command, first, second] = argv;
  if (command === 'prepare') {
    if (!first) throw new Error('Usage: node tools/wurster-edge-runtime.mjs prepare <windows|mac|linux> [x64|arm64|universal]');
    const result = await prepareDesktopEdgeRuntimes({ target: first, arch: second });
    for (const item of result.targets) console.log(`[Wurster Edge] prepared ${item.target} ${item.manifest.version} from ${item.source}`);
    return;
  }
  if (command === 'prepare-target') {
    if (!first) throw new Error('Usage: node tools/wurster-edge-runtime.mjs prepare-target <runtime-target>');
    const result = await prepareEdgeRuntimeTargets({ targets: [first] });
    for (const item of result.targets) console.log(`[Wurster Edge] prepared ${item.target} ${item.manifest.version} from ${item.source}`);
    return;
  }
  if (command === 'verify') {
    if (!first) throw new Error('Usage: node tools/wurster-edge-runtime.mjs verify <runtime-directory> [target]');
    const manifest = await verifyEdgeRuntimeDirectory(first, { target: second || undefined });
    console.log(`[Wurster Edge] verified ${manifest.name} ${manifest.version} ${manifest.target}`);
    return;
  }
  throw new Error('Usage: node tools/wurster-edge-runtime.mjs <prepare|prepare-target|verify> ...');
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) cli().catch((error) => {
  console.error(`[Wurster Edge] ${error?.message || error}`);
  process.exit(1);
});
