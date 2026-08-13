import { Worker } from 'node:worker_threads';
import { openWurstFile } from '@wurster/format';
import { validateJsonValue, WURST_INTERFACE_FORMAT } from '@wurster/interface';

const WORKER = new URL('./worker.mjs', import.meta.url);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function cleanInput(value) {
  if (value == null) return {};
  return JSON.parse(JSON.stringify(value));
}

async function loadDescriptor(filePath) {
  const reader = await openWurstFile(filePath);
  try {
    const declaration = reader.manifest.interface;
    if (!declaration) throw new Error('This Wurst does not expose a Wurst Interface');
    if (declaration.format !== WURST_INTERFACE_FORMAT) throw new Error(`Unsupported Wurst Interface format: ${declaration.format}`);
    if (!declaration.headless) throw new Error('This Wurst Interface is not declared headless');
    const entry = reader.entry(declaration.entry);
    if (!entry || entry.scope !== 'interface') throw new Error('Wurst Interface entry is missing');
    if (entry.encryption) throw new Error('Headless interface entry must be public in Wurst 0.20.0');
    if (entry.length > MAX_SOURCE_BYTES) throw new Error('Wurst Interface source is too large');
    const loaded = await reader.read(declaration.entry, { verify: true });
    return {
      declaration,
      source: loaded.data.toString('utf8'),
      info: {
        id: reader.manifest.id,
        name: reader.manifest.name,
        version: reader.manifest.version,
        format: reader.manifest.format
      }
    };
  } finally {
    await reader.close();
  }
}

export async function describeWurstInterface(filePath) {
  const descriptor = await loadDescriptor(filePath);
  return { info: descriptor.info, interface: descriptor.declaration };
}

export async function invokeWurstAction(filePath, action, input = {}, options = {}) {
  const descriptor = await loadDescriptor(filePath);
  const spec = descriptor.declaration.actions?.[action];
  if (!spec) throw new Error(`Unknown Wurst action: ${action}`);
  const clean = cleanInput(input);
  validateJsonValue(clean, spec.input, '$input');
  const timeoutMs = Math.min(Number(options.timeoutMs ?? spec.timeoutMs ?? 5_000), 60_000);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER, {
      workerData: {
        source: descriptor.source,
        entry: descriptor.declaration.entry,
        declaration: descriptor.declaration,
        info: descriptor.info,
        action,
        input: clean,
        timeoutMs
      },
      resourceLimits: { maxOldGenerationSizeMb: Number(options.memoryMb ?? 64), stackSizeMb: 4 }
    });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`Wurst action exceeded ${timeoutMs} ms`));
      void worker.terminate();
    }, timeoutMs);
    worker.once('message', (message) => {
      if (!message.ok) finish(reject, new Error(message.error));
      else finish(resolve, { result: message.result, events: message.events ?? [] });
      void worker.terminate();
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (code !== 0 && !settled) finish(reject, new Error(`Wurst headless worker exited with code ${code}`));
    });
  });
}

export async function runWurstInterfaceTests(filePath, options = {}) {
  const descriptor = await loadDescriptor(filePath);
  const tests = descriptor.declaration.tests ?? [];
  const results = [];
  for (const test of tests) {
    try {
      const invoked = await invokeWurstAction(filePath, test.action, test.input, options);
      const pass = !Object.hasOwn(test, 'expect') || JSON.stringify(invoked.result) === JSON.stringify(test.expect);
      results.push({ name: test.name, action: test.action, pass, result: invoked.result, expect: test.expect, events: invoked.events });
    } catch (error) {
      results.push({ name: test.name, action: test.action, pass: false, error: error.message });
    }
  }
  return { info: descriptor.info, tests: results, passed: results.filter((item) => item.pass).length, failed: results.filter((item) => !item.pass).length };
}
