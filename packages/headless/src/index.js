import { Worker } from 'node:worker_threads';
import { openWurstFile, openWurstRangeSource } from '@wurster/format';
import { PIGLINK_FORMAT, validateJsonValue } from '@wurster/piglink';
import { createHeadlessFileRuntime } from './file-runtime.js';

const WORKER = new URL('./worker.mjs', import.meta.url);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function cleanInput(value) {
  if (value == null) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeSource(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    return {
      size: bytes.length,
      async read(offset, length) {
        const start = Number(offset), count = Number(length);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || start + count > bytes.length) throw new Error('Invalid Wurst range');
        return Buffer.from(bytes.subarray(start, start + count));
      }
    };
  }
  if (value && typeof value.read === 'function' && Number.isSafeInteger(value.size)) return value;
  throw new TypeError('Headless Wurst source requires bytes or { size, read(offset, length) }');
}

async function descriptorFromReader(reader) {
  const declaration = reader.manifest.piglink;
  if (!declaration) throw new Error('This Wurst does not expose PigLink');
  if (declaration.format !== PIGLINK_FORMAT) throw new Error(`Unsupported PigLink format: ${declaration.format}`);
  if (!declaration.headless) throw new Error('This PigLink is not declared headless');
  const entry = reader.entry(declaration.entry);
  if (!entry || entry.scope !== 'piglink') throw new Error('PigLink entry is missing');
  if (entry.encryption) throw new Error('Headless PigLink entry must be public');
  if (entry.length > MAX_SOURCE_BYTES) throw new Error('PigLink source is too large');
  const loaded = await reader.read(declaration.entry, { verify: true });
  const appWorkspace = {};
  for (const appEntry of reader.entries().filter((item) => (item.scope ?? 'app') === 'app' && !item.encryption)) {
    const appLoaded = await reader.read(appEntry.path, { verify: true });
    if (appLoaded) appWorkspace[appEntry.path] = appLoaded.data;
  }
  return {
    declaration,
    source: loaded.data.toString('utf8'),
    pigsty: reader.manifest.pigsty ?? null,
    appWorkspace,
    info: {
      id: reader.manifest.id,
      name: reader.manifest.name,
      version: reader.manifest.version,
      format: reader.manifest.format
    }
  };
}

async function loadDescriptor(filePath) {
  const reader = await openWurstFile(filePath);
  try { return await descriptorFromReader(reader); }
  finally { await reader.close(); }
}

async function loadSourceDescriptor(rawSource) {
  const source = normalizeSource(rawSource);
  const reader = await openWurstRangeSource(source);
  try { return await descriptorFromReader(reader); }
  finally { await reader.close(); }
}

async function invokeDescriptor(descriptor, action, input = {}, options = {}) {
  const spec = descriptor.declaration.actions?.[action];
  if (!spec) throw new Error(`Unknown Wurst action: ${action}`);
  const clean = cleanInput(input);
  validateJsonValue(clean, spec.input, '$input');
  const timeoutMs = Math.min(Number(options.timeoutMs ?? spec.timeoutMs ?? 5_000), 60_000);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER, {
      env: { ...process.env, ...(options.env ?? {}) },
      workerData: {
        source: descriptor.source,
        entry: descriptor.declaration.entry,
        declaration: descriptor.declaration,
        info: descriptor.info,
        pigsty: descriptor.pigsty,
        appWorkspace: descriptor.appWorkspace,
        action,
        input: clean,
        timeoutMs,
        services: options.serviceManifest ?? null
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
    worker.on('message', async (message) => {
      if (message?.type === 'service-call') {
        const id = String(message.id ?? '');
        try {
          if (typeof options.services !== 'function') throw new Error(`Headless Wurst service is unavailable: ${message.method}`);
          const result = await options.services(String(message.method ?? ''), Array.isArray(message.args) ? message.args : []);
          worker.postMessage({ type: 'service-result', id, ok: true, result: structuredClone(result == null ? null : result) });
        } catch (error) {
          worker.postMessage({ type: 'service-result', id, ok: false, error: error?.message || String(error), code: error?.code || null });
        }
        return;
      }
      if (message?.type && message.type !== 'result') return;
      if (!message.ok) finish(reject, new Error(message.error));
      else {
        try {
          const result = message.result == null ? null : structuredClone(message.result);
          if (spec.output) validateJsonValue(result, spec.output, '$output');
          finish(resolve, { result, events: message.events ?? [] });
        } catch (error) { finish(reject, error); }
      }
      void worker.terminate();
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (code !== 0 && !settled) finish(reject, new Error(`Wurst headless worker exited with code ${code}`));
    });
  });
}

export async function describePigLink(filePath) {
  const descriptor = await loadDescriptor(filePath);
  return { info: descriptor.info, piglink: descriptor.declaration };
}

export async function describePigLinkSource(source) {
  const descriptor = await loadSourceDescriptor(source);
  return { info: descriptor.info, piglink: descriptor.declaration };
}

export async function invokePigLinkAction(filePath, action, input = {}, options = {}) {
  const descriptor = await loadDescriptor(filePath);
  const runtime = await createHeadlessFileRuntime(filePath, {
    invokeSourceAction: invokePigLinkActionSource,
    describeSource: describePigLinkSource
  });
  const externalServices = options.services;
  try {
    return await invokeDescriptor(descriptor, action, input, {
      ...options,
      serviceManifest: { ...(options.serviceManifest ?? {}), ...runtime.serviceManifest },
      services: async (method, args) => {
        if (typeof externalServices === 'function') {
          try { return await externalServices(method, args); }
          catch (error) { if (error?.code !== 'WURST_SERVICE_UNHANDLED') throw error; }
        }
        return runtime.services(method, args);
      }
    });
  } finally {
    await runtime.close();
  }
}

export async function invokePigLinkActionSource(source, action, input = {}, options = {}) {
  return invokeDescriptor(await loadSourceDescriptor(source), action, input, options);
}

async function runDescriptorTests(descriptor, options = {}) {
  const tests = descriptor.declaration.tests ?? [];
  const results = [];
  for (const test of tests) {
    try {
      const invoked = await invokeDescriptor(descriptor, test.action, test.input, options);
      const pass = !Object.hasOwn(test, 'expect') || JSON.stringify(invoked.result) === JSON.stringify(test.expect);
      results.push({ name: test.name, action: test.action, pass, result: invoked.result, expect: test.expect, events: invoked.events });
    } catch (error) {
      results.push({ name: test.name, action: test.action, pass: false, error: error.message });
    }
  }
  return { info: descriptor.info, tests: results, passed: results.filter((item) => item.pass).length, failed: results.filter((item) => !item.pass).length };
}

export async function runPigLinkTests(filePath, options = {}) {
  const descriptor = await loadDescriptor(filePath);
  const tests = descriptor.declaration.tests ?? [];
  const results = [];
  for (const test of tests) {
    try {
      const invoked = await invokePigLinkAction(filePath, test.action, test.input, options);
      const pass = !Object.hasOwn(test, 'expect') || JSON.stringify(invoked.result) === JSON.stringify(test.expect);
      results.push({ name: test.name, action: test.action, pass, result: invoked.result, expect: test.expect, events: invoked.events });
    } catch (error) {
      results.push({ name: test.name, action: test.action, pass: false, error: error.message });
    }
  }
  return { info: descriptor.info, tests: results, passed: results.filter((item) => item.pass).length, failed: results.filter((item) => !item.pass).length };
}

export async function runPigLinkTestsSource(source, options = {}) {
  return runDescriptorTests(await loadSourceDescriptor(source), options);
}
