import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

export {
  PIGSTY_EDGE_WASIX_ADAPTER_FORMAT,
  PIGSTY_EDGE_WASIX_ENGINE,
  WURSTER_EDGE_RUNTIME_NAME,
  createEdgeWasixPigstyEngine,
  createResolvedEdgeWasixPigstyEngine,
  currentEdgeWasixRuntimeTarget,
  edgeWasixRuntimeTarget,
  probeEdgeWasixPigstyEngine,
  probeResolvedEdgeWasixPigstyEngine,
  resolveEdgeWasixRuntime
} from './edge-wasix.mjs';

export const PIGSTY_FORMAT = 'wurst/pigsty-1';
export const PIGSTY_VERSION = 'node-lts-1';
export const PIGSTY_ARTIFACT_STORE_FORMAT = 'wurst/pigsty-artifact-store-1';
export const PIGSTY_PUBLICATION_FORMAT = 'wurst/pigsty-publication-1';
export const PIGSTY_ENGINE_CONTRACT_FORMAT = 'wurst/pigsty-engine-contract-1';
export const PIGSTY_FS_VIEW_FORMAT = 'wurst/pigsty-fs-view-1';
export const PIGSTY_CHANGESET_FORMAT = 'wurst/pigsty-changeset-1';
export const PIGSTY_ENGINE_RESULT_FORMAT = 'wurst/pigsty-engine-result-1';
export const PIGSTY_TOOLCHAIN_FORMAT = 'wurst/pigsty-toolchain-1';
export const PIGSTY_TOOLCHAIN_ROOT = 'pigsty-toolchain';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
const MAX_SCRIPT_BYTES = 512 * 1024;
const MAX_WORKSPACE_FILES = 20000;
const MAX_WORKSPACE_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;

export function normalizePigstyPolicy(raw = null) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('pigsty must be an object');
  const version = raw.version ?? PIGSTY_VERSION;
  if (version !== PIGSTY_VERSION) throw new Error(`pigsty.version currently supports ${PIGSTY_VERSION}`);
  const tools = Array.isArray(raw.tools) ? raw.tools.map((tool) => String(tool)) : [];
  if (tools.length > 64) throw new Error('pigsty.tools may list at most 64 tools');
  for (const tool of tools) {
    if (!TOOL_RE.test(tool)) throw new Error(`Invalid pigsty tool name: ${tool}`);
  }
  const builds = normalizePigstyBuilds(raw.builds ?? {});
  return {
    format: PIGSTY_FORMAT,
    version,
    tools,
    builds,
    toolchain: normalizePigstyToolchainPolicy(raw.toolchain ?? null),
    offline: raw.offline !== false,
    nativeAddons: false
  };
}

export async function runPigstyBuild({
  policy,
  build,
  workspace = {},
  args = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const normalizedPolicy = normalizePigstyPolicy(policy);
  if (!normalizedPolicy) throw new Error('Pigsty is not declared for this Wurst');
  const name = String(build ?? 'default');
  const declaration = normalizedPolicy.builds?.[name];
  if (!declaration) throw new Error(`Unknown Pigsty build: ${name}`);
  const normalizedWorkspace = normalizeWorkspace(workspace);
  const mergedArgs = { ...(declaration.args ?? {}), ...(args ?? {}) };
  const run = await runPigstySandboxEntry({
    policy: normalizedPolicy,
    entry: declaration.source,
    workspace: denormalizeWorkspace(normalizedWorkspace),
    args: mergedArgs,
    timeoutMs: timeoutMs ?? declaration.timeoutMs
  });
  const outside = declaration.outputs.length
    ? run.artifacts.filter((artifact) => !declaration.outputs.some((output) => isWithinOutput(artifact.path, output)))
    : [];
  if (outside.length) throw new Error(`Pigsty build ${name} wrote outside declared outputs: ${outside.map((item) => item.path).join(', ')}`);
  return {
    ...run,
    build: {
      format: 'wurst/pigsty-build-record-1',
      name,
      source: declaration.source,
      description: declaration.description,
      declaredOutputs: [...declaration.outputs],
      provenance: run.provenance,
      artifacts: run.artifacts
    }
  };
}

export async function runPigstyEngineBuild({
  policy,
  build,
  workspace = {},
  toolchain = null,
  tmp = {},
  args = {},
  network = false,
  engine,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const normalizedPolicy = normalizePigstyPolicy(policy);
  if (!normalizedPolicy) throw new Error('Pigsty is not declared for this Wurst');
  const name = String(build ?? 'default');
  const declaration = normalizedPolicy.builds?.[name];
  if (!declaration) throw new Error(`Unknown Pigsty build: ${name}`);
  const normalizedWorkspace = denormalizeWorkspace(normalizeWorkspace(workspace));
  const resolvedToolchain = resolvePigstyToolchainWorkspace(normalizedWorkspace, toolchain, normalizedPolicy);
  const mergedArgs = {
    ...(declaration.args ?? {}),
    ...(args ?? {}),
    entry: declaration.source,
    timeoutMs: timeoutMs ?? declaration.timeoutMs
  };
  const run = await runPigstyEngine({
    policy: normalizedPolicy,
    workspace: normalizedWorkspace,
    toolchain: resolvedToolchain,
    tmp,
    args: mergedArgs,
    network,
    engine,
    timeoutMs: timeoutMs ?? declaration.timeoutMs
  });
  const writes = run.changeSet.changes
    .filter((change) => change.op !== 'delete')
    .map((change) => change.path)
    .sort();
  const outside = declaration.outputs.length
    ? run.changeSet.changes.filter((change) => !declaration.outputs.some((output) => isWithinOutput(change.path, output)))
    : [];
  if (outside.length) throw new Error(`Pigsty engine build ${name} wrote outside declared outputs: ${outside.map((item) => item.path).join(', ')}`);
  const artifacts = summarizeArtifacts(normalizeWorkspace(run.workspace), writes);
  const sourceDigest = digestPigstyWorkspace(normalizedWorkspace);
  const toolchainDigest = digestPigstyWorkspace(resolvedToolchain);
  const outputDigest = digestPigstyWorkspace(run.workspace);
  const provenance = {
    format: 'wurst/pigsty-provenance-1',
    runtime: PIGSTY_VERSION,
    engine: run.adapter,
    toolchain: {
      version: normalizedPolicy.version,
      tools: [...normalizedPolicy.tools],
      offline: normalizedPolicy.offline,
      nativeAddons: false,
      digest: toolchainDigest
    },
    sourceDigest,
    outputDigest,
    createdAt: new Date().toISOString()
  };
  return {
    ...run,
    writes,
    artifacts,
    provenance,
    build: {
      format: 'wurst/pigsty-build-record-1',
      name,
      source: declaration.source,
      description: declaration.description,
      declaredOutputs: [...declaration.outputs],
      provenance,
      artifacts
    }
  };
}

async function runPigstySandboxEntry({
  policy,
  entry,
  workspace,
  args,
  timeoutMs
}) {
  const normalizedWorkspace = normalizeWorkspace(workspace);
  const scriptEntry = normalizedWorkspace.find((item) => item.path === entry);
  if (!scriptEntry) throw new Error(`Pigsty build script not found in Wurst workspace: ${entry}`);
  const script = scriptEntry.encoding === 'base64'
    ? Buffer.from(String(scriptEntry.data ?? ''), 'base64').toString('utf8')
    : String(scriptEntry.data ?? '');
  return runPigstyScript({
    policy,
    script,
    workspace: denormalizeWorkspace(normalizedWorkspace),
    args,
    timeoutMs
  });
}

function isWithinOutput(path, output) {
  return path === output || path.startsWith(`${output}/`);
}

export async function runPigstyScript({
  policy,
  script,
  workspace = {},
  args = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const normalizedPolicy = normalizePigstyPolicy(policy);
  if (!normalizedPolicy) throw new Error('Pigsty is not declared for this Wurst');
  if (typeof script !== 'string' || !script.trim()) throw new Error('Pigsty script must be a non-empty string');
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('Pigsty script is too large');
  const files = normalizeWorkspace(workspace);
  const sourceDigest = digestWorkspaceEntries(files);
  const limitMs = Math.max(50, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const worker = new Worker(WORKER_URL, {
    workerData: {
      policy: normalizedPolicy,
      script,
      workspace: files,
      args: sanitizeJson(args)
    },
    resourceLimits: {
      maxOldGenerationSizeMb: 96,
      maxYoungGenerationSizeMb: 16,
      codeRangeSizeMb: 16,
      stackSizeMb: 4
    }
  });

  let timer = null;
  try {
    const message = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        worker.terminate().catch(() => {});
        reject(new Error(`Pigsty script exceeded ${limitMs} ms`));
      }, limitMs);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`Pigsty worker exited with code ${code}`));
      });
    });
    if (!message?.ok) throw new Error(message?.error || 'Pigsty worker failed');
    const outputEntries = Array.isArray(message.workspace) ? message.workspace : [];
    const outputDigest = digestWorkspaceEntries(outputEntries);
    const writes = Array.isArray(message.writes) ? message.writes.map((item) => String(item)).sort() : [];
    const artifacts = summarizeArtifacts(outputEntries, writes);
    return {
      ok: true,
      policy: normalizedPolicy,
      provenance: {
        format: 'wurst/pigsty-provenance-1',
        runtime: PIGSTY_VERSION,
        toolchain: {
          version: normalizedPolicy.version,
          tools: [...normalizedPolicy.tools],
          offline: normalizedPolicy.offline,
          nativeAddons: false
        },
        sourceDigest,
        outputDigest,
        createdAt: new Date().toISOString()
      },
      result: message.result ?? null,
      events: message.events ?? [],
      writes,
      artifacts,
      workspace: denormalizeWorkspace(outputEntries)
    };
  } finally {
    if (timer) clearTimeout(timer);
    worker.terminate().catch(() => {});
  }
}

export function digestPigstyWorkspace(workspace = {}) {
  return digestWorkspaceEntries(normalizeWorkspace(workspace));
}

export function createPigstyEngineContract({
  policy,
  workspace = {},
  toolchain = null,
  args = {},
  network = false
} = {}) {
  const normalizedPolicy = normalizePigstyPolicy(policy);
  if (!normalizedPolicy) throw new Error('Pigsty is not declared for this Wurst');
  const normalizedWorkspace = denormalizeWorkspace(normalizeWorkspace(workspace));
  const resolvedToolchain = resolvePigstyToolchainWorkspace(normalizedWorkspace, toolchain, normalizedPolicy);
  const files = normalizeWorkspace(normalizedWorkspace);
  const toolchainFiles = normalizeWorkspace(resolvedToolchain);
  const mounts = [
    {
      path: '/wurst',
      source: 'pigfs',
      writable: true,
      persistent: true,
      digest: digestWorkspaceEntries(files)
    },
    {
      path: '/tmp',
      source: 'ephemeral',
      writable: true,
      persistent: false
    }
  ];
  if (toolchainFiles.length) {
    mounts.splice(1, 0, {
      path: '/toolchain',
      source: 'toolchain',
      writable: false,
      persistent: true,
      digest: digestWorkspaceEntries(toolchainFiles)
    });
  }
  return {
    format: PIGSTY_ENGINE_CONTRACT_FORMAT,
    runtime: 'node-compatible',
    isolation: 'engine-sandbox',
    engineHint: 'edge-wasix',
    cwd: '/wurst',
    mounts,
    capabilities: {
      hostFilesystem: false,
      hostProcesses: false,
      hostShell: false,
      hostEnvironment: false,
      network: Boolean(network && normalizedPolicy.offline === false),
      nativeAddons: false
    },
    env: {
      PIGSTY: '1'
    },
    args: sanitizeJson(args),
    policy: normalizedPolicy
  };
}

export function createPigstyFileSystemView({
  policy,
  workspace = {},
  toolchain = null,
  tmp = {},
  args = {},
  network = false
} = {}) {
  const normalizedPolicy = normalizePigstyPolicy(policy);
  const normalizedWorkspace = denormalizeWorkspace(normalizeWorkspace(workspace));
  const resolvedToolchain = resolvePigstyToolchainWorkspace(normalizedWorkspace, toolchain, normalizedPolicy);
  const contract = createPigstyEngineContract({ policy: normalizedPolicy, workspace: normalizedWorkspace, toolchain: resolvedToolchain, args, network });
  const mounts = contract.mounts.map((mount) => {
    if (mount.path === '/wurst') return { ...mount, files: normalizeWorkspace(normalizedWorkspace) };
    if (mount.path === '/toolchain') return { ...mount, files: normalizeWorkspace(resolvedToolchain) };
    if (mount.path === '/tmp') return { ...mount, files: normalizeWorkspace(tmp) };
    return { ...mount, files: [] };
  });
  return {
    format: PIGSTY_FS_VIEW_FORMAT,
    contract,
    cwd: contract.cwd,
    mounts
  };
}

export function resolvePigstyPath(rawPath, {
  cwd = '/wurst',
  mounts = ['/wurst', '/toolchain', '/tmp']
} = {}) {
  const mountPaths = [...mounts].map((item) => normalizeEngineMountPath(item)).sort((a, b) => b.length - a.length);
  const base = normalizeEngineAbsolutePath(cwd);
  const raw = String(rawPath ?? '');
  const absolute = raw.startsWith('/')
    ? normalizeEngineAbsolutePath(raw)
    : normalizeEngineAbsolutePath(`${base}/${raw}`);
  const mount = mountPaths.find((item) => absolute === item || absolute.startsWith(`${item}/`));
  if (!mount) throw new Error(`Pigsty path is outside mounted Pigsty filesystems: ${rawPath}`);
  const relative = absolute === mount ? '' : absolute.slice(mount.length + 1);
  return {
    absolutePath: absolute,
    mountPath: mount,
    source: mount === '/wurst' ? 'pigfs' : mount === '/tmp' ? 'ephemeral' : mount === '/toolchain' ? 'toolchain' : 'unknown',
    path: relative
  };
}

export function createPigstyChangeSet(beforeWorkspace = {}, afterWorkspace = {}) {
  const before = normalizeWorkspace(beforeWorkspace);
  const after = normalizeWorkspace(afterWorkspace);
  const previous = new Map(before.map((entry) => [entry.path, entry]));
  const current = new Map(after.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...previous.keys(), ...current.keys()])].sort();
  const changes = [];
  for (const path of paths) {
    const oldEntry = previous.get(path) ?? null;
    const newEntry = current.get(path) ?? null;
    const oldHash = oldEntry ? workspaceEntrySummary(oldEntry) : null;
    const newHash = newEntry ? workspaceEntrySummary(newEntry) : null;
    if (oldHash?.sha256 === newHash?.sha256 && oldHash?.bytes === newHash?.bytes) continue;
    if (!newEntry) {
      changes.push({ op: 'delete', path, before: oldHash });
    } else if (!oldEntry) {
      changes.push({ op: 'add', path, after: newHash, value: denormalizeWorkspace([newEntry])[path] });
    } else {
      changes.push({ op: 'modify', path, before: oldHash, after: newHash, value: denormalizeWorkspace([newEntry])[path] });
    }
  }
  return {
    format: PIGSTY_CHANGESET_FORMAT,
    sourceDigest: digestWorkspaceEntries(before),
    targetDigest: digestWorkspaceEntries(after),
    changes
  };
}

export function createPigstyEngineResult({
  contract,
  beforeWorkspace = {},
  afterWorkspace = {},
  tmpWorkspace = {},
  result = null,
  events = []
} = {}) {
  if (!contract || contract.format !== PIGSTY_ENGINE_CONTRACT_FORMAT) throw new Error('Pigsty engine result requires wurst/pigsty-engine-contract-1');
  const changeSet = createPigstyChangeSet(beforeWorkspace, afterWorkspace);
  return {
    format: PIGSTY_ENGINE_RESULT_FORMAT,
    contract,
    result: sanitizeJson(result),
    events: Array.isArray(events) ? events.map((event) => sanitizeJson(event)) : [],
    changeSet,
    tmpDigest: digestPigstyWorkspace(tmpWorkspace),
    sourceDigest: changeSet.sourceDigest,
    targetDigest: changeSet.targetDigest
  };
}

export async function runPigstyEngine({
  policy,
  workspace = {},
  toolchain = null,
  tmp = {},
  args = {},
  network = false,
  engine,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const adapter = normalizePigstyEngineAdapter(engine);
  const normalizedPolicy = normalizePigstyPolicy(policy);
  const normalizedWorkspace = denormalizeWorkspace(normalizeWorkspace(workspace));
  const resolvedToolchain = resolvePigstyToolchainWorkspace(normalizedWorkspace, toolchain, normalizedPolicy);
  const fsView = createPigstyFileSystemView({ policy: normalizedPolicy, workspace: normalizedWorkspace, toolchain: resolvedToolchain, tmp, args, network });
  const limitMs = Math.max(50, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const output = await runWithTimeout(
    Promise.resolve().then(() => adapter.run(sanitizeJson(fsView), {
      contract: sanitizeJson(fsView.contract),
      cwd: fsView.cwd,
      mounts: fsView.mounts.map((mount) => ({
        path: mount.path,
        source: mount.source,
        writable: mount.writable,
        persistent: mount.persistent
      }))
    })),
    limitMs,
    `Pigsty engine ${adapter.name} exceeded ${limitMs} ms`
  );
  const normalizedOutput = normalizePigstyEngineOutput(output);
  const afterWorkspace = normalizedOutput.workspace ?? normalizedWorkspace;
  const tmpWorkspace = normalizedOutput.tmp ?? denormalizeWorkspace(normalizeWorkspace(tmp));
  const engineResult = createPigstyEngineResult({
    contract: fsView.contract,
    beforeWorkspace: normalizedWorkspace,
    afterWorkspace,
    tmpWorkspace,
    result: normalizedOutput.result,
    events: normalizedOutput.events
  });
  return {
    ok: true,
    adapter: adapter.name,
    fsView,
    ...engineResult,
    workspace: applyPigstyEngineResult(normalizedWorkspace, engineResult),
    tmpWorkspace
  };
}

export function extractPigstyToolchainWorkspace(workspace = {}, {
  root = PIGSTY_TOOLCHAIN_ROOT
} = {}) {
  const normalizedRoot = normalizeWorkspacePath(root);
  const prefix = `${normalizedRoot}/`;
  const out = {};
  for (const [rawPath, value] of Object.entries(denormalizeWorkspace(normalizeWorkspace(workspace)))) {
    const filePath = normalizeWorkspacePath(rawPath);
    if (!filePath.startsWith(prefix)) continue;
    const toolPath = filePath.slice(prefix.length);
    if (!toolPath) continue;
    out[toolPath] = value;
  }
  return out;
}

export function resolvePigstyToolchainWorkspace(workspace = {}, toolchain = null, policy = null) {
  if (toolchain != null) return denormalizeWorkspace(normalizeWorkspace(toolchain));
  const normalizedPolicy = normalizePigstyPolicy(policy);
  const root = normalizedPolicy?.toolchain?.root ?? PIGSTY_TOOLCHAIN_ROOT;
  return extractPigstyToolchainWorkspace(workspace, { root });
}

export function applyPigstyEngineResult(workspace = {}, engineResult) {
  if (!engineResult || engineResult.format !== PIGSTY_ENGINE_RESULT_FORMAT) throw new Error('Pigsty engine result must use wurst/pigsty-engine-result-1');
  const current = digestPigstyWorkspace(workspace);
  const expected = engineResult.sourceDigest ?? engineResult.changeSet?.sourceDigest;
  if (!expected || expected.sha256 !== current.sha256 || expected.files !== current.files || expected.bytes !== current.bytes) {
    throw new Error('Pigsty engine result source digest does not match the current Wurst workspace');
  }
  return applyPigstyChangeSet(workspace, engineResult.changeSet);
}

export function applyPigstyChangeSet(workspace = {}, changeSet) {
  if (!changeSet || changeSet.format !== PIGSTY_CHANGESET_FORMAT) throw new Error('Pigsty changeset must use wurst/pigsty-changeset-1');
  const out = denormalizeWorkspace(normalizeWorkspace(workspace));
  for (const change of changeSet.changes ?? []) {
    const path = normalizeWorkspacePath(change.path);
    if (change.op === 'delete') {
      delete out[path];
      continue;
    }
    if (!['add', 'modify'].includes(change.op)) throw new Error(`Unsupported Pigsty changeset operation: ${change.op}`);
    if (typeof change.value !== 'string' && !(change.value instanceof Uint8Array) && !Buffer.isBuffer(change.value)) throw new Error(`Pigsty changeset ${change.op} requires a text or byte value: ${path}`);
    out[path] = change.value;
  }
  return out;
}

export function assessPigstyBuildRecord(record, workspace = {}) {
  const provenance = record?.provenance ?? record;
  if (!provenance || provenance.format !== 'wurst/pigsty-provenance-1') {
    return {
      format: 'wurst/pigsty-staleness-1',
      state: 'invalid',
      reason: 'missing-provenance',
      expectedSourceDigest: null,
      currentSourceDigest: digestPigstyWorkspace(workspace)
    };
  }
  const expected = provenance.sourceDigest ?? null;
  const current = digestPigstyWorkspace(workspace);
  if (!expected || expected.format !== 'wurst/pigsty-workspace-digest-1' || typeof expected.sha256 !== 'string') {
    return {
      format: 'wurst/pigsty-staleness-1',
      state: 'invalid',
      reason: 'invalid-source-digest',
      expectedSourceDigest: expected,
      currentSourceDigest: current
    };
  }
  const fresh = expected.sha256 === current.sha256 && expected.files === current.files && expected.bytes === current.bytes;
  return {
    format: 'wurst/pigsty-staleness-1',
    state: fresh ? 'fresh' : 'stale',
    reason: fresh ? null : 'source-digest-mismatch',
    expectedSourceDigest: expected,
    currentSourceDigest: current
  };
}

export function createPigstyArtifactStore(records = []) {
  const store = {
    format: PIGSTY_ARTIFACT_STORE_FORMAT,
    builds: {}
  };
  for (const record of records) upsertPigstyBuildRecord(store, record);
  return store;
}

export function upsertPigstyBuildRecord(store = null, buildResultOrRecord) {
  const target = normalizeArtifactStore(store);
  const record = normalizeBuildRecord(buildResultOrRecord);
  target.builds[record.name] = record;
  return target;
}

export function assessPigstyArtifactStore(store, buildName, {
  sourceWorkspace = {},
  artifactWorkspace = sourceWorkspace
} = {}) {
  const normalized = normalizeArtifactStore(store);
  const name = String(buildName ?? 'default');
  const record = normalized.builds[name] ?? null;
  if (!record) {
    return {
      format: 'wurst/pigsty-build-status-1',
      build: name,
      state: 'missing',
      reason: 'missing-build-record',
      source: null,
      artifacts: []
    };
  }
  const source = assessPigstyBuildRecord(record, sourceWorkspace);
  if (source.state === 'invalid') {
    return {
      format: 'wurst/pigsty-build-status-1',
      build: name,
      state: 'invalid',
      reason: source.reason,
      source,
      artifacts: []
    };
  }
  const artifacts = assessPigstyArtifacts(record, artifactWorkspace);
  const missing = artifacts.filter((item) => item.state === 'missing');
  const changed = artifacts.filter((item) => item.state === 'changed');
  let state = 'fresh';
  let reason = null;
  if (missing.length) {
    state = 'missing';
    reason = 'missing-artifact';
  } else if (changed.length) {
    state = 'invalid';
    reason = 'artifact-digest-mismatch';
  } else if (source.state === 'stale') {
    state = 'stale';
    reason = source.reason;
  }
  return {
    format: 'wurst/pigsty-build-status-1',
    build: name,
    state,
    reason,
    source,
    artifacts
  };
}

export function createPigstyBuildPublication(buildResult, {
  store = null,
  root = 'data/builds'
} = {}) {
  const record = normalizeBuildRecord(buildResult);
  const base = normalizeWorkspacePath(root);
  const nameSegment = encodeURIComponent(record.name);
  const buildRoot = `${base}/${nameSegment}`;
  const artifactRoot = `${buildRoot}/artifacts`;
  const sourceWorkspace = buildResult?.workspace ?? {};
  const files = {};
  const storedArtifacts = [];
  for (const artifact of record.artifacts) {
    const value = sourceWorkspace[artifact.path];
    if (value == null) throw new Error(`Pigsty publication artifact is missing from build workspace: ${artifact.path}`);
    const storedPath = `${artifactRoot}/${artifact.path}`;
    files[storedPath] = value;
    storedArtifacts.push({ ...artifact, storedPath });
  }
  const storedRecord = {
    ...record,
    artifacts: storedArtifacts
  };
  const nextStore = upsertPigstyBuildRecord(store, storedRecord);
  const storePath = `${buildRoot}/current.json`;
  files[storePath] = `${JSON.stringify(nextStore, null, 2)}\n`;
  return {
    format: PIGSTY_PUBLICATION_FORMAT,
    build: record.name,
    root: base,
    storePath,
    artifactRoot,
    files,
    store: nextStore,
    record: storedRecord
  };
}

export function applyPigstyPublication(workspace = {}, publication) {
  if (!publication || publication.format !== PIGSTY_PUBLICATION_FORMAT) throw new Error('Pigsty publication must use wurst/pigsty-publication-1');
  return {
    ...workspace,
    ...publication.files
  };
}

export function assessPigstyArtifacts(record, workspace = {}) {
  const normalized = normalizeBuildRecord(record);
  const entries = new Map(normalizeWorkspace(workspace).map((entry) => [entry.path, entry]));
  return normalized.artifacts.map((artifact) => {
    const lookupPath = artifact.storedPath ?? artifact.path;
    const current = entries.get(lookupPath);
    if (!current) return { ...artifact, state: 'missing', current: null };
    const data = entryBytes(current);
    const currentSummary = {
      bytes: data.byteLength,
      sha256: hashHex(data)
    };
    const fresh = currentSummary.bytes === artifact.bytes && currentSummary.sha256 === artifact.sha256;
    return {
      ...artifact,
      state: fresh ? 'fresh' : 'changed',
      current: currentSummary
    };
  });
}

function normalizeArtifactStore(store) {
  if (store == null) return { format: PIGSTY_ARTIFACT_STORE_FORMAT, builds: {} };
  if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error('Pigsty artifact store must be an object');
  if (store.format !== PIGSTY_ARTIFACT_STORE_FORMAT) throw new Error(`Unsupported Pigsty artifact store format: ${store.format ?? 'missing'}`);
  const builds = {};
  for (const [name, record] of Object.entries(store.builds ?? {})) {
    const normalized = normalizeBuildRecord({ ...record, name: record.name ?? name });
    builds[normalized.name] = normalized;
  }
  return { format: PIGSTY_ARTIFACT_STORE_FORMAT, builds };
}

function normalizeBuildRecord(buildResultOrRecord) {
  const record = buildResultOrRecord?.build ?? buildResultOrRecord;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Pigsty build record must be an object');
  if (record.format !== 'wurst/pigsty-build-record-1') throw new Error(`Unsupported Pigsty build record format: ${record.format ?? 'missing'}`);
  const name = String(record.name ?? '');
  if (!NAME_RE.test(name)) throw new Error(`Invalid Pigsty build record name: ${name}`);
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts.map((artifact) => ({
    path: normalizeWorkspacePath(artifact.path),
    ...(artifact.storedPath == null ? {} : { storedPath: normalizeWorkspacePath(artifact.storedPath) }),
    encoding: artifact.encoding === 'base64' ? 'base64' : 'utf8',
    bytes: Number(artifact.bytes ?? 0),
    sha256: String(artifact.sha256 ?? '')
  })) : [];
  for (const artifact of artifacts) {
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) throw new Error(`Invalid Pigsty artifact byte size: ${artifact.path}`);
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error(`Invalid Pigsty artifact sha256: ${artifact.path}`);
  }
  return {
    format: 'wurst/pigsty-build-record-1',
    name,
    source: normalizeWorkspacePath(record.source),
    description: String(record.description ?? ''),
    declaredOutputs: Array.isArray(record.declaredOutputs) ? record.declaredOutputs.map((item) => normalizeOutputPrefix(item)) : [],
    provenance: record.provenance ?? null,
    artifacts
  };
}

function normalizePigstyEngineAdapter(engine) {
  if (typeof engine === 'function') {
    return {
      name: 'anonymous',
      run: engine
    };
  }
  if (!engine || typeof engine !== 'object' || typeof engine.run !== 'function') {
    throw new Error('Pigsty engine requires an adapter with run(fsView)');
  }
  return {
    name: String(engine.name || 'anonymous'),
    run: engine.run.bind(engine)
  };
}

function normalizePigstyEngineOutput(output = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Pigsty engine output must be an object');
  return {
    workspace: output.workspace == null ? null : denormalizeWorkspace(normalizeWorkspace(output.workspace)),
    tmp: output.tmp == null ? null : denormalizeWorkspace(normalizeWorkspace(output.tmp)),
    result: sanitizeJson(output.result ?? null),
    events: Array.isArray(output.events) ? output.events.map((event) => sanitizeJson(event)) : []
  };
}

async function runWithTimeout(promise, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function workspaceEntrySummary(entry) {
  const data = entryBytes(entry);
  return {
    encoding: entry.encoding,
    bytes: data.byteLength,
    sha256: hashHex(data)
  };
}

function normalizePigstyBuilds(raw) {
  if (raw == null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('pigsty.builds must be an object');
  const out = {};
  for (const [rawName, rawBuild] of Object.entries(raw)) {
    const name = String(rawName ?? '');
    if (!NAME_RE.test(name)) throw new Error(`Invalid pigsty build name: ${name}`);
    if (!rawBuild || typeof rawBuild !== 'object' || Array.isArray(rawBuild)) throw new Error(`pigsty.builds.${name} must be an object`);
    const source = normalizeWorkspacePath(rawBuild.source);
    if (!/\.(?:js|mjs)$/i.test(source)) throw new Error(`pigsty.builds.${name}.source must point to a JavaScript file`);
    if (rawBuild.mode != null) throw new Error(`pigsty.builds.${name}.mode is not supported; Pigsty engine selection is a runtime implementation detail`);
    const outputs = Array.isArray(rawBuild.outputs) ? rawBuild.outputs.map((item) => normalizeOutputPrefix(item)) : [];
    if (outputs.length > 128) throw new Error(`pigsty.builds.${name}.outputs may list at most 128 paths`);
    const timeoutMs = rawBuild.timeoutMs == null ? DEFAULT_TIMEOUT_MS : Math.max(50, Math.min(Number(rawBuild.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    out[name] = {
      source,
      description: String(rawBuild.description ?? '').trim(),
      outputs,
      args: sanitizeJson(rawBuild.args ?? {}),
      timeoutMs
    };
  }
  return out;
}

function normalizePigstyToolchainPolicy(raw) {
  if (raw == null) {
    return {
      format: PIGSTY_TOOLCHAIN_FORMAT,
      root: PIGSTY_TOOLCHAIN_ROOT
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('pigsty.toolchain must be an object');
  const root = normalizeWorkspacePath(raw.root ?? PIGSTY_TOOLCHAIN_ROOT);
  if (root.startsWith('__wurst/')) throw new Error('pigsty.toolchain.root may not target Wurster internals');
  return {
    format: PIGSTY_TOOLCHAIN_FORMAT,
    root
  };
}

function normalizeWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) throw new Error('Pigsty workspace must be an object');
  const out = [];
  let total = 0;
  for (const [rawPath, value] of Object.entries(workspace)) {
    if (out.length >= MAX_WORKSPACE_FILES) throw new Error('Pigsty workspace has too many files');
    const path = normalizeWorkspacePath(rawPath);
    let entry;
    if (typeof value === 'string') {
      total += Buffer.byteLength(value, 'utf8');
      entry = { path, encoding: 'utf8', data: value };
    } else if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      total += value.byteLength;
      entry = { path, encoding: 'base64', data: Buffer.from(value).toString('base64') };
    } else {
      throw new Error(`Pigsty workspace file must be text or bytes: ${rawPath}`);
    }
    if (total > MAX_WORKSPACE_BYTES) throw new Error('Pigsty workspace is too large');
    out.push(entry);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function denormalizeWorkspace(entries) {
  const out = {};
  for (const entry of entries) {
    out[entry.path] = entry.encoding === 'base64'
      ? Uint8Array.from(Buffer.from(entry.data, 'base64'))
      : String(entry.data ?? '');
  }
  return out;
}

function summarizeArtifacts(entries, writes) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return writes.map((path) => {
    const entry = byPath.get(path);
    if (!entry) return { path, missing: true };
    const data = entryBytes(entry);
    return {
      path,
      encoding: entry.encoding,
      bytes: data.byteLength,
      sha256: hashHex(data)
    };
  });
}

function digestWorkspaceEntries(entries) {
  const summary = entries
    .map((entry) => {
      const data = entryBytes(entry);
      return {
        path: entry.path,
        encoding: entry.encoding,
        bytes: data.byteLength,
        sha256: hashHex(data)
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    format: 'wurst/pigsty-workspace-digest-1',
    algorithm: 'sha256',
    files: summary.length,
    bytes: summary.reduce((total, entry) => total + entry.bytes, 0),
    sha256: hashHex(Buffer.from(JSON.stringify(summary)))
  };
}

function entryBytes(entry) {
  return entry.encoding === 'base64'
    ? Buffer.from(String(entry.data ?? ''), 'base64')
    : Buffer.from(String(entry.data ?? ''), 'utf8');
}

function hashHex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function normalizeWorkspacePath(rawPath) {
  const value = String(rawPath ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Pigsty workspace path escapes the Wurst: ${rawPath}`);
    parts.push(part);
  }
  const normalized = parts.join('/');
  if (!normalized) throw new Error('Pigsty workspace path may not be empty');
  if (normalized.startsWith('__wurst/')) throw new Error(`Pigsty workspace may not access Wurster internals: ${rawPath}`);
  return normalized;
}

function normalizeOutputPrefix(rawPath) {
  const path = normalizeWorkspacePath(rawPath);
  if (path.startsWith('__wurst/')) throw new Error(`Pigsty output may not target Wurster internals: ${rawPath}`);
  return path;
}

function normalizeEngineMountPath(rawPath) {
  const path = normalizeEngineAbsolutePath(rawPath);
  if (path === '/') throw new Error('Pigsty engine mount may not be the filesystem root');
  return path.replace(/\/+$/, '');
}

function normalizeEngineAbsolutePath(rawPath) {
  const value = String(rawPath ?? '').replaceAll('\\', '/');
  if (!value.startsWith('/')) throw new Error(`Pigsty engine path must be absolute: ${rawPath}`);
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error(`Pigsty engine path escapes the Pigsty root: ${rawPath}`);
      parts.pop();
      continue;
    }
    if (part.includes('\0')) throw new Error(`Pigsty engine path contains an invalid segment: ${rawPath}`);
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function sanitizeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    throw new Error('Pigsty args must be JSON-serializable');
  }
}
