import path from 'node:path';
import {
  createResolvedEdgeWasixPigstyEngine,
  currentEdgeWasixRuntimeTarget,
  probeResolvedEdgeWasixPigstyEngine,
  runPigstyBuild,
  runPigstyEngineBuild,
  runPigstyScript
} from '@wurster/pigsty';

const COMING_SOON_REASON = 'Pigsty is not bundled in this Wurster release yet';

function envFlag(value) {
  return /^(1|true|yes)$/i.test(String(value ?? ''));
}

function workerDevelopmentEnabled() {
  return process.env.WURSTER_PIGSTY_ENGINE === 'worker' || envFlag(process.env.WURSTER_PIGSTY_DEV);
}

function runtimeOptions(app) {
  const target = currentEdgeWasixRuntimeTarget();
  const runtimeName = `wurster-edge-runtime-${target}`;
  const runtimeDirs = [
    process.resourcesPath ? path.join(process.resourcesPath, 'runtimes', runtimeName) : null,
    path.join(app.getAppPath(), 'runtimes', runtimeName),
    path.join(path.dirname(app.getAppPath()), 'runtimes', runtimeName)
  ].filter(Boolean);
  if (process.env.WURSTER_EDGE_CACHE_DIR || process.env.PIGSTY_EDGE_CACHE_DIR) return { runtimeDirs };
  return {
    runtimeDirs,
    cacheDir: path.join(app.getPath('userData'), 'pigsty-cache', 'edge')
  };
}

async function appWorkspace(context) {
  const workspace = {};
  const entries = context.reader.entries()
    .filter((entry) => (entry.scope ?? 'app') === 'app' && !entry.encryption)
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of entries) {
    const loaded = await context.reader.read(entry.path, { verify: true });
    if (loaded) workspace[entry.path] = loaded.data;
  }
  return workspace;
}

export function createDesktopPigstyRuntime({ app, ipcMain, assertWurstSender }) {
  async function status(context) {
    const declared = context.manifest.pigsty ?? null;
    if (!declared) {
      return {
        declared: false,
        policy: null,
        state: 'undeclared',
        runtime: 'desktop',
        defaultEngine: null,
        engines: {
          worker: { available: false, production: false },
          edgeWasix: { available: false, implemented: true, production: false, configured: false, bundled: false }
        },
        builds: [],
        workspaceSources: [],
        reason: 'not-declared'
      };
    }

    const edgeProbe = await probeResolvedEdgeWasixPigstyEngine(runtimeOptions(app));
    const devWorker = workerDevelopmentEnabled();
    const requested = process.env.WURSTER_PIGSTY_ENGINE;
    const defaultEngine = requested === 'edge-wasix'
      ? 'edge-wasix'
      : devWorker
        ? 'worker'
        : edgeProbe.available
          ? 'edge-wasix'
          : null;
    const available = defaultEngine === 'worker' || (defaultEngine === 'edge-wasix' && edgeProbe.available);

    return {
      declared: true,
      policy: structuredClone(declared),
      state: available ? 'available' : 'coming-soon',
      runtime: 'desktop',
      defaultEngine,
      engines: {
        worker: { available: devWorker, production: false, developmentOnly: true },
        edgeWasix: {
          available: edgeProbe.available,
          implemented: true,
          production: false,
          configured: edgeProbe.configured || requested === 'edge-wasix',
          bundled: Boolean(edgeProbe.bundled),
          target: edgeProbe.target,
          runtimeDir: edgeProbe.runtimeDir,
          cacheDir: edgeProbe.cacheDir,
          manifest: edgeProbe.manifest,
          path: edgeProbe.path,
          version: edgeProbe.version,
          safe: Boolean(edgeProbe.safe),
          reason: edgeProbe.available ? null : edgeProbe.reason
        }
      },
      builds: Object.keys(declared.builds ?? {}).sort(),
      workspaceSources: ['app', 'request', 'toolchain'],
      reason: available ? null : COMING_SOON_REASON
    };
  }

  async function selectedEngine(context, request = {}) {
    const edgeProbe = await probeResolvedEdgeWasixPigstyEngine(runtimeOptions(app));
    const requested = request?.engine ?? process.env.WURSTER_PIGSTY_ENGINE;
    if (requested === 'edge-wasix' || (!requested && edgeProbe.available && !workerDevelopmentEnabled())) return 'edge-wasix';
    if (requested === 'worker' || (!requested && workerDevelopmentEnabled())) return 'worker';
    if (requested) throw new Error(`Unknown Pigsty engine: ${requested}`);
    const error = new Error(COMING_SOON_REASON);
    error.code = 'WURST_PIGSTY_UNAVAILABLE';
    throw error;
  }

  ipcMain.handle('wurst:pigsty:status', async (event) => status(assertWurstSender(event)));

  ipcMain.handle('wurst:pigsty:run', async (event, request = {}) => {
    const context = assertWurstSender(event);
    const engine = await selectedEngine(context, request);
    if (engine === 'edge-wasix') {
      throw new Error('Pigsty Edge/WASIX runs declared builds; use wurst.pigsty.build(name)');
    }
    const baseWorkspace = request?.includeApp === false ? {} : await appWorkspace(context);
    return runPigstyScript({
      policy: context.manifest.pigsty,
      script: String(request?.script ?? ''),
      workspace: { ...baseWorkspace, ...(request?.workspace ?? {}) },
      args: request?.args ?? {},
      timeoutMs: request?.timeoutMs
    });
  });

  ipcMain.handle('wurst:pigsty:build', async (event, name = 'default', request = {}) => {
    const context = assertWurstSender(event);
    const baseWorkspace = request?.includeApp === false ? {} : await appWorkspace(context);
    const workspace = { ...baseWorkspace, ...(request?.workspace ?? {}) };
    const engine = await selectedEngine(context, request);
    if (engine === 'edge-wasix') {
      return runPigstyEngineBuild({
        policy: context.manifest.pigsty,
        build: String(name ?? 'default'),
        workspace,
        toolchain: request?.toolchain ?? null,
        tmp: request?.tmp ?? {},
        args: request?.args ?? {},
        network: request?.network === true,
        timeoutMs: request?.timeoutMs,
        engine: await createResolvedEdgeWasixPigstyEngine(runtimeOptions(app))
      });
    }
    return runPigstyBuild({
      policy: context.manifest.pigsty,
      build: String(name ?? 'default'),
      workspace,
      args: request?.args ?? {},
      timeoutMs: request?.timeoutMs
    });
  });

  return { status };
}
