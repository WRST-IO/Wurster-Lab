import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { generateMeatphrase, generateWurstKey } from '@wurster/format';
import { createActionRegistry } from '@wurster/interface';

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
  interface: Object.freeze({
    emit: (name, payload) => registry.emit(name, payload)
  })
});

const context = vm.createContext({
  WurstInterface: Object.freeze({
    define(definition) {
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('WurstInterface.define expects an object');
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
  name: `Wurst Interface: ${workerData.info?.name ?? 'unnamed'}`,
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
