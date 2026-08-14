import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { generateMeatphrase, generateWurstKey } from '@wurster/format';
import { createActionRegistry } from '@wurster/piglink';
import { createResolvedEdgeWasixPigstyEngine, probeResolvedEdgeWasixPigstyEngine, runPigstyBuild, runPigstyEngineBuild, runPigstyScript } from '@wurster/pigsty';

const events = [];
const registry = createActionRegistry(workerData.declaration, {
  emit: (name, payload) => events.push({ name, payload })
});

const safeConsole = Object.freeze({
  log: (...args) => events.push({ name: 'console.log', payload: args.map(String) }),
  warn: (...args) => events.push({ name: 'console.warn', payload: args.map(String) }),
  error: (...args) => events.push({ name: 'console.error', payload: args.map(String) })
});

const wurst = Object.freeze({
  info: () => JSON.parse(JSON.stringify(workerData.info)),
  crypto: Object.freeze({
    generateMeatphrase: (count = 12) => generateMeatphrase(Number(count)),
    generateWurstKey: () => generateWurstKey()
  }),
  pigsty: Object.freeze({
    status: async () => {
      const declared = Boolean(workerData.pigsty);
      const edgeProbe = await probeResolvedEdgeWasixPigstyEngine();
      const defaultEngine = process.env.WURSTER_PIGSTY_ENGINE === 'edge-wasix' ? 'edge-wasix' : 'worker';
      return {
        declared,
        policy: workerData.pigsty ? JSON.parse(JSON.stringify(workerData.pigsty)) : null,
        state: declared ? (defaultEngine === 'edge-wasix' && !edgeProbe.available ? 'unavailable' : 'available') : 'undeclared',
        runtime: 'headless',
        defaultEngine,
        engines: {
          worker: { available: declared, production: false },
          edgeWasix: {
            available: declared && edgeProbe.available,
            implemented: true,
            production: false,
            configured: edgeProbe.configured || Boolean(process.env.WURSTER_PIGSTY_ENGINE === 'edge-wasix'),
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
        builds: workerData.pigsty ? Object.keys(workerData.pigsty.builds ?? {}).sort() : [],
        workspaceSources: workerData.pigsty ? ['app', 'request', 'toolchain'] : [],
        reason: declared ? (defaultEngine === 'edge-wasix' && !edgeProbe.available ? edgeProbe.reason : null) : 'not-declared'
      };
    },
    run: (request = {}) => {
      const engine = request?.engine ?? process.env.WURSTER_PIGSTY_ENGINE;
      if (engine === 'edge-wasix') {
        throw new Error('Pigsty Edge/WASIX currently runs declared builds; use wurst.pigsty.build(name, { engine: "edge-wasix" })');
      }
      if (engine && engine !== 'worker') throw new Error(`Unknown Pigsty engine: ${engine}`);
      const includeApp = request?.includeApp !== false;
      return runPigstyScript({
        policy: workerData.pigsty,
        script: String(request?.script ?? ''),
        workspace: { ...(includeApp ? workerData.appWorkspace ?? {} : {}), ...(request?.workspace ?? {}) },
        args: request?.args ?? {},
        timeoutMs: request?.timeoutMs
      });
    },
    build: async (name = 'default', request = {}) => {
      const includeApp = request?.includeApp !== false;
      const workspace = { ...(includeApp ? workerData.appWorkspace ?? {} : {}), ...(request?.workspace ?? {}) };
      const engine = request?.engine ?? process.env.WURSTER_PIGSTY_ENGINE;
      if (engine === 'edge-wasix') {
        return runPigstyEngineBuild({
          policy: workerData.pigsty,
          build: String(name ?? 'default'),
          workspace,
          toolchain: request?.toolchain ?? null,
          tmp: request?.tmp ?? {},
          args: request?.args ?? {},
          network: request?.network === true,
          timeoutMs: request?.timeoutMs,
          engine: await createResolvedEdgeWasixPigstyEngine()
        });
      }
      if (engine && engine !== 'worker') throw new Error(`Unknown Pigsty engine: ${engine}`);
      return runPigstyBuild({
        policy: workerData.pigsty,
        build: String(name ?? 'default'),
        workspace,
        args: request?.args ?? {},
        timeoutMs: request?.timeoutMs
      });
    }
  }),
  piglink: Object.freeze({
    emit: (name, payload) => registry.emit(name, payload)
  })
});

const context = vm.createContext({
  PigLink: Object.freeze({
    define(definition) {
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('PigLink.define expects an object');
      for (const [name, handler] of Object.entries(definition.actions ?? {})) registry.register(name, handler);
    }
  }),
  wurst,
  console: safeConsole,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  structuredClone,
  setTimeout,
  clearTimeout
}, {
  name: `PigLink: ${workerData.info?.name ?? 'unnamed'}`,
  codeGeneration: { strings: false, wasm: false }
});

try {
  const script = new vm.Script(workerData.source, { filename: workerData.entry, displayErrors: true });
  script.runInContext(context, { timeout: Math.min(workerData.timeoutMs, 5_000) });
  const result = await registry.invoke(workerData.action, workerData.input, { wurst });
  parentPort.postMessage({ ok: true, result, events });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.stack || error?.message || String(error), events });
}
