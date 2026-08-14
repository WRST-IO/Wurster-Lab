import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PIGSTY_EDGE_WASIX_ENGINE = 'edge-wasix';
export const PIGSTY_EDGE_WASIX_ADAPTER_FORMAT = 'wurst/pigsty-edge-wasix-adapter-1';
export const WURSTER_EDGE_RUNTIME_NAME = 'wurster-edge-runtime';

const FS_VIEW_FORMAT = 'wurst/pigsty-fs-view-1';
const ENGINE_CONTRACT_FORMAT = 'wurst/pigsty-engine-contract-1';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export async function resolveEdgeWasixRuntime({
  runtimeDir = process.env.WURSTER_EDGE_RUNTIME_DIR || process.env.PIGSTY_EDGE_RUNTIME_DIR || null,
  runtimeDirs = [],
  cacheDir = process.env.WURSTER_EDGE_CACHE_DIR || process.env.PIGSTY_EDGE_CACHE_DIR || null,
  target = currentRuntimeTarget(),
  verifyHashes = false
} = {}) {
  runtimeDir = runtimeDir || await findEdgeRuntimeDir(runtimeDirs);
  if (!runtimeDir) {
    const env = {};
    for (const name of ['WASMER_BIN', 'WASMER_DIR', 'EDGE_WASMER_PACKAGE']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    return {
      configured: Boolean(process.env.WURSTER_EDGE_BIN || process.env.PIGSTY_EDGE_BIN || process.env.WASMER_BIN || process.env.EDGE_WASMER_PACKAGE),
      bundled: false,
      target,
      runtimeDir: null,
      manifest: null,
      edgePath: process.env.WURSTER_EDGE_BIN || process.env.PIGSTY_EDGE_BIN || 'edge',
      env,
      cacheDir: null
    };
  }
  const root = path.resolve(String(runtimeDir));
  const manifest = await readEdgeRuntimeManifest(root);
  validateEdgeRuntimeManifest(manifest, { target });
  const edgePath = path.join(root, 'bin', process.platform === 'win32' ? 'edge.exe' : 'edge');
  const wasmerPath = path.join(root, 'bin', process.platform === 'win32' ? 'wasmer.exe' : 'wasmer');
  const packagePath = path.join(root, 'share', 'edge-wasix');
  for (const required of requiredRuntimeFiles()) {
    await assertFileExists(path.join(root, normalizeRuntimeManifestPath(required)), `Wurster Edge runtime is missing required file: ${required}`);
  }
  if (verifyHashes) await verifyEdgeRuntimeManifestFiles(root, manifest);
  const resolvedCacheDir = path.resolve(cacheDir || path.join(os.tmpdir(), 'wurster-pigsty-cache', `${manifest.version || 'edge'}-${manifest.target || target}`));
  return {
    configured: true,
    bundled: true,
    target,
    runtimeDir: root,
    manifest,
    edgePath,
    env: {
      WASMER_BIN: wasmerPath,
      EDGE_WASMER_PACKAGE: packagePath,
      WASMER_DIR: resolvedCacheDir
    },
    cacheDir: resolvedCacheDir
  };
}

export function edgeWasixRuntimeTarget(platform = process.platform, arch = process.arch) {
  const osName = {
    linux: 'linux',
    darwin: 'darwin',
    win32: 'windows'
  }[platform] || platform;
  const archName = {
    x64: 'amd64',
    arm64: 'arm64'
  }[arch] || arch;
  return `${osName}-${archName}`;
}

export function currentEdgeWasixRuntimeTarget() {
  return edgeWasixRuntimeTarget();
}

export async function createResolvedEdgeWasixPigstyEngine(options = {}) {
  const runtime = await resolveEdgeWasixRuntime(options);
  return createEdgeWasixPigstyEngine({
    edgePath: runtime.edgePath,
    env: runtime.env,
    ...options.engine
  });
}

export async function probeResolvedEdgeWasixPigstyEngine({
  runCommand = runEdgeCommand,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ...runtimeOptions
} = {}) {
  try {
    const runtime = await resolveEdgeWasixRuntime(runtimeOptions);
    const probe = await probeEdgeWasixPigstyEngine({
      edgePath: runtime.edgePath,
      env: runtime.env,
      runCommand,
      timeoutMs
    });
    return {
      ...probe,
      configured: runtime.configured,
      bundled: runtime.bundled,
      target: runtime.target,
      runtimeDir: runtime.runtimeDir,
      cacheDir: runtime.cacheDir,
      manifest: runtime.manifest ? summarizeEdgeRuntimeManifest(runtime.manifest) : null
    };
  } catch (error) {
    const runtimeDir = runtimeOptions.runtimeDir
      ?? process.env.WURSTER_EDGE_RUNTIME_DIR
      ?? process.env.PIGSTY_EDGE_RUNTIME_DIR
      ?? await findEdgeRuntimeDir(runtimeOptions.runtimeDirs ?? []).catch(() => null);
    return {
      format: PIGSTY_EDGE_WASIX_ADAPTER_FORMAT,
      engine: PIGSTY_EDGE_WASIX_ENGINE,
      available: false,
      configured: Boolean(runtimeDir),
      bundled: false,
      target: runtimeOptions.target ?? currentRuntimeTarget(),
      runtimeDir,
      cacheDir: null,
      manifest: null,
      path: null,
      version: null,
      safe: false,
      reason: error?.message || String(error)
    };
  }
}

export function createEdgeWasixPigstyEngine({
  edgePath = process.env.WURSTER_EDGE_BIN || process.env.PIGSTY_EDGE_BIN || 'edge',
  safeFlag = '--safe',
  runCommand = runEdgeCommand,
  tempRoot = os.tmpdir(),
  keepTemp = false,
  env = {}
} = {}) {
  return {
    name: PIGSTY_EDGE_WASIX_ENGINE,
    format: PIGSTY_EDGE_WASIX_ADAPTER_FORMAT,
    async run(fsView) {
      const view = normalizeFsView(fsView);
      const entry = normalizeWorkspaceRelativePath(view.contract?.args?.entry ?? view.contract?.args?.source ?? view.contract?.args?.script);
      const scriptArgs = Array.isArray(view.contract?.args?.argv) ? view.contract.args.argv.map((item) => String(item)) : [];
      await fs.mkdir(tempRoot, { recursive: true });
      const stage = await fs.mkdtemp(path.join(tempRoot, 'wurster-pigsty-edge-'));
      const roots = {
        '/wurst': path.join(stage, 'wurst'),
        '/toolchain': path.join(stage, 'toolchain'),
        '/tmp': path.join(stage, 'tmp')
      };
      try {
        await materializeView(view, roots);
        const projectedToolchain = await projectToolchainNodeModules(roots);
        const runnerEntry = await writePigstyRunner(roots, entry);
        const entryPath = path.join(roots['/wurst'], entry);
        await assertFileExists(entryPath, `Pigsty Edge/WASIX entry not found: ${entry}`);
        const edgeArgs = [safeFlag, runnerEntry, ...scriptArgs].filter(Boolean);
        const commandEnv = {
          PIGSTY: '1',
          PIGSTY_CWD: '/wurst',
          PIGSTY_ENTRY: entry,
          PIGSTY_ARGS_JSON: JSON.stringify(view.contract?.args ?? {}),
          PIGSTY_TOOLCHAIN: '/toolchain',
          PIGSTY_TMP: '/tmp',
          ...env
        };
        let executed;
        try {
          executed = await runCommand({
            command: edgePath,
            args: edgeArgs,
            cwd: roots['/wurst'],
            env: commandEnv,
            timeoutMs: Number(view.contract?.args?.timeoutMs) || DEFAULT_TIMEOUT_MS,
            mounts: view.mounts.map((mount) => ({
              path: mount.path,
              source: mount.source,
              writable: mount.writable,
              persistent: mount.persistent,
              hostPath: roots[mount.path] ?? null
            }))
          });
        } catch (error) {
          if (error?.code === 'ENOENT') throw new Error(`Pigsty Edge/WASIX binary not found: ${edgePath}`);
          throw error;
        }
        if (executed.status !== 0) {
          const reason = String(executed.stderr || executed.stdout || `exit ${executed.status}`).trim();
          throw new Error(`Pigsty Edge/WASIX engine failed: ${reason}`);
        }
        await removePigstyRunner(roots, runnerEntry);
        await removeProjectedToolchainNodeModules(roots, projectedToolchain);
        return {
          workspace: await collectWorkspace(roots['/wurst']),
          tmp: await collectWorkspace(roots['/tmp']),
          result: {
            engine: PIGSTY_EDGE_WASIX_ENGINE,
            command: path.basename(edgePath),
            status: executed.status
          },
          events: [
            ...streamEvents('stdout', executed.stdout),
            ...streamEvents('stderr', executed.stderr)
          ]
        };
      } finally {
        if (!keepTemp) await fs.rm(stage, { recursive: true, force: true });
      }
    }
  };
}

export async function probeEdgeWasixPigstyEngine({
  edgePath = process.env.WURSTER_EDGE_BIN || process.env.PIGSTY_EDGE_BIN || 'edge',
  runCommand = runEdgeCommand,
  env = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  try {
    const versionResult = await runCommand({
      command: edgePath,
      args: ['--version'],
      cwd: process.cwd(),
      env,
      timeoutMs
    });
    const version = String(versionResult.stdout || versionResult.stderr || '').trim() || null;
    if (versionResult.status !== 0) {
      return {
        format: PIGSTY_EDGE_WASIX_ADAPTER_FORMAT,
        engine: PIGSTY_EDGE_WASIX_ENGINE,
        available: false,
        path: edgePath,
        version,
        safe: false,
        reason: `edge --version exited with ${versionResult.status}`
      };
    }
    const safeResult = await runCommand({
      command: edgePath,
      args: ['--safe', '-e', 'console.log("pigsty-edge-safe-probe")'],
      cwd: process.cwd(),
      env,
      timeoutMs
    });
    const safeOutput = String(safeResult.stdout || safeResult.stderr || '').trim();
    return {
      format: PIGSTY_EDGE_WASIX_ADAPTER_FORMAT,
      engine: PIGSTY_EDGE_WASIX_ENGINE,
      available: safeResult.status === 0,
      path: edgePath,
      version,
      safe: safeResult.status === 0,
      reason: safeResult.status === 0 ? null : safeOutput || `edge --safe probe exited with ${safeResult.status}`
    };
  } catch (error) {
    return {
      format: PIGSTY_EDGE_WASIX_ADAPTER_FORMAT,
      engine: PIGSTY_EDGE_WASIX_ENGINE,
      available: false,
      path: edgePath,
      version: null,
      safe: false,
      reason: error?.code === 'ENOENT' ? 'edge-binary-not-found' : error?.message || String(error)
    };
  }
}

async function runEdgeCommand({
  command,
  args,
  cwd,
  env,
  timeoutMs
}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error(`Pigsty Edge/WASIX engine exceeded ${timeoutMs} ms`));
      }
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ status: status ?? 1, stdout, stderr });
      }
    });
  });
}

async function projectToolchainNodeModules(roots) {
  const source = path.join(roots['/toolchain'], 'node_modules');
  const target = path.join(roots['/wurst'], 'node_modules');
  try {
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isDirectory()) return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  try {
    await fs.lstat(target);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.cp(source, target, {
    recursive: true,
    errorOnExist: false,
    force: false,
    preserveTimestamps: true
  });
  return true;
}

async function removeProjectedToolchainNodeModules(roots, projected) {
  if (!projected) return false;
  await fs.rm(path.join(roots['/wurst'], 'node_modules'), { recursive: true, force: true });
  return true;
}

async function writePigstyRunner(roots, entry) {
  const runnerEntry = '.pigsty-runner.mjs';
  await fs.writeFile(path.join(roots['/wurst'], runnerEntry), `
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const require = createRequire(import.meta.url);
const entry = String(process.env.PIGSTY_ENTRY || ${JSON.stringify(entry)});
let args = {};
try { args = JSON.parse(process.env.PIGSTY_ARGS_JSON || '{}'); } catch {}
args = { ...args, entry };
let handler = null;

function safePath(raw = '') {
  const resolved = path.resolve(root, String(raw || '.'));
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Pigsty path escapes /wurst: ' + raw);
  return resolved;
}

function list(raw = '.') {
  const base = safePath(raw);
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) out.push(relative);
    }
  }
  if (fs.existsSync(base)) walk(base);
  return out.sort();
}

globalThis.Pigsty = Object.freeze({
  define(definition) {
    handler = typeof definition === 'function' ? definition : definition?.run;
    if (typeof handler !== 'function') throw new Error('Pigsty.define expects a function or { run() }');
  }
});

const entryPath = safePath(entry);
process.argv[1] = entryPath;
if (entry.endsWith('.mjs')) await import(pathToFileURL(entryPath).href);
else require(entryPath);

if (handler) {
  const ctx = Object.freeze({
    args,
    policy: null,
    readText: (file) => fs.readFileSync(safePath(file), 'utf8'),
    readBytes: (file) => new Uint8Array(fs.readFileSync(safePath(file))),
    writeText: (file, data) => {
      const target = safePath(file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(data));
    },
    writeBytes: (file, data) => {
      const target = safePath(file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(data));
    },
    list,
    remove: (file) => fs.rmSync(safePath(file), { recursive: true, force: true })
  });
  await handler(ctx);
}
`, 'utf8');
  return runnerEntry;
}

async function removePigstyRunner(roots, runnerEntry) {
  await fs.rm(path.join(roots['/wurst'], runnerEntry), { force: true });
}

function normalizeFsView(view) {
  if (!view || view.format !== FS_VIEW_FORMAT) throw new Error('Edge/WASIX Pigsty engine requires wurst/pigsty-fs-view-1');
  if (!view.contract || view.contract.format !== ENGINE_CONTRACT_FORMAT) throw new Error('Edge/WASIX Pigsty engine requires wurst/pigsty-engine-contract-1');
  if (view.contract.runtime !== 'node-compatible') throw new Error(`Unsupported Pigsty engine runtime: ${view.contract.runtime}`);
  if (view.contract.capabilities?.hostFilesystem !== false || view.contract.capabilities?.hostProcesses !== false || view.contract.capabilities?.hostShell !== false) {
    throw new Error('Edge/WASIX Pigsty engine refuses contracts with host authority');
  }
  const mounts = Array.isArray(view.mounts) ? view.mounts : [];
  if (!mounts.some((mount) => mount.path === '/wurst' && mount.writable === true)) throw new Error('Edge/WASIX Pigsty engine requires writable /wurst mount');
  for (const mount of mounts) {
    if (!['/wurst', '/toolchain', '/tmp'].includes(mount.path)) throw new Error(`Unsupported Pigsty Edge/WASIX mount: ${mount.path}`);
    if (mount.path === '/toolchain' && mount.writable) throw new Error('Pigsty toolchain mount must be immutable');
    assertNoNativeAddons(mount.files ?? []);
  }
  return view;
}

async function materializeView(view, roots) {
  for (const mount of view.mounts) {
    const root = roots[mount.path];
    if (!root) continue;
    await fs.mkdir(root, { recursive: true });
    for (const entry of mount.files ?? []) {
      const relative = normalizeWorkspaceRelativePath(entry.path);
      const target = path.join(root, relative);
      assertInside(root, target, entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const data = entry.encoding === 'base64'
        ? Buffer.from(String(entry.data ?? ''), 'base64')
        : Buffer.from(String(entry.data ?? ''), 'utf8');
      if (data.byteLength > MAX_FILE_BYTES) throw new Error(`Pigsty Edge/WASIX file is too large: ${entry.path}`);
      await fs.writeFile(target, data);
    }
  }
}

async function collectWorkspace(root) {
  const out = {};
  await walk(root, async (absolute) => {
    const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
    const data = await fs.readFile(absolute);
    out[relative] = looksText(data) ? data.toString('utf8') : Uint8Array.from(data);
  });
  return out;
}

async function walk(dir, visit) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await walk(absolute, visit);
    else if (stat.isFile()) await visit(absolute);
  }
}

async function assertFileExists(file, message) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(message);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(message);
    throw error;
  }
}

async function readEdgeRuntimeManifest(root) {
  const manifestPath = path.join(root, 'manifest.json');
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Wurster Edge runtime manifest not found: ${manifestPath}`);
    throw new Error(`Invalid Wurster Edge runtime manifest: ${error?.message || error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Wurster Edge runtime manifest must be an object');
  return parsed;
}

async function findEdgeRuntimeDir(candidates) {
  const values = Array.isArray(candidates) ? candidates : [candidates];
  for (const raw of values) {
    if (!raw) continue;
    const root = path.resolve(String(raw));
    try {
      const stat = await fs.stat(path.join(root, 'manifest.json'));
      if (stat.isFile()) return root;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return null;
}

function validateEdgeRuntimeManifest(manifest, { target }) {
  if (manifest.name !== WURSTER_EDGE_RUNTIME_NAME) throw new Error(`Unsupported Wurster Edge runtime name: ${manifest.name ?? 'missing'}`);
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('Wurster Edge runtime manifest requires version');
  if (manifest.target !== target) throw new Error(`Wurster Edge runtime target mismatch: expected ${target}, got ${manifest.target ?? 'missing'}`);
  if (!Array.isArray(manifest.files)) throw new Error('Wurster Edge runtime manifest requires files');
  const paths = new Set(manifest.files.map((file) => file?.path));
  for (const required of requiredRuntimeFiles()) {
    if (!paths.has(required)) throw new Error(`Wurster Edge runtime manifest is missing ${required}`);
  }
}

async function verifyEdgeRuntimeManifestFiles(root, manifest) {
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string') throw new Error('Invalid Wurster Edge runtime file manifest entry');
    const absolute = path.join(root, normalizeRuntimeManifestPath(file.path));
    const data = await fs.readFile(absolute);
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== file.sha256) throw new Error(`Wurster Edge runtime hash mismatch: ${file.path}`);
  }
}

function summarizeEdgeRuntimeManifest(manifest) {
  return {
    name: manifest.name,
    version: manifest.version,
    target: manifest.target,
    files: Array.isArray(manifest.files) ? manifest.files.length : 0
  };
}

function normalizeRuntimeManifestPath(raw) {
  const relative = String(raw ?? '').replaceAll('\\', '/');
  if (!relative || relative.startsWith('/') || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid Wurster Edge runtime file path: ${raw}`);
  return relative.split('/').join(path.sep);
}

function requiredRuntimeFiles() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  return [
    `bin/edge${exe}`,
    `bin/wasmer${exe}`,
    'share/edge-wasix/wasmer.toml',
    'share/edge-wasix/edgejs.wasm'
  ];
}

function currentRuntimeTarget() {
  return edgeWasixRuntimeTarget();
}

function normalizeWorkspaceRelativePath(rawPath) {
  const value = String(rawPath ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Pigsty Edge/WASIX path escapes the Wurst: ${rawPath}`);
    if (part.includes('\0')) throw new Error(`Pigsty Edge/WASIX path contains an invalid segment: ${rawPath}`);
    parts.push(part);
  }
  const normalized = parts.join('/');
  if (!normalized) throw new Error('Pigsty Edge/WASIX path may not be empty');
  if (normalized.startsWith('__wurst/')) throw new Error(`Pigsty Edge/WASIX may not access Wurster internals: ${rawPath}`);
  return normalized;
}

function assertInside(root, target, rawPath) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Pigsty Edge/WASIX path escapes the mount: ${rawPath}`);
}

function assertNoNativeAddons(entries) {
  for (const entry of entries) {
    const path = String(entry.path ?? '').toLowerCase();
    if (path.endsWith('.node')) throw new Error(`Pigsty Edge/WASIX v1 rejects native Node addons: ${entry.path}`);
  }
}

function looksText(data) {
  if (!data.byteLength) return true;
  const sample = data.subarray(0, Math.min(data.byteLength, 4096));
  return !sample.includes(0);
}

function streamEvents(type, value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((message) => ({ type, message }));
}
