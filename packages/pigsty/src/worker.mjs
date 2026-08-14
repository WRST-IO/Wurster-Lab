import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

const MAX_RESULT_BYTES = 1024 * 1024;
const events = [];
const writes = new Set();
const files = new Map();

try {
  for (const entry of workerData.workspace ?? []) {
    files.set(entry.path, { encoding: entry.encoding, data: entry.data });
  }

  let handler = null;
  const Pigsty = Object.freeze({
    define(definition) {
      if (typeof definition === 'function') {
        handler = definition;
        return true;
      }
      if (!definition || typeof definition.run !== 'function') throw new Error('Pigsty.define requires a run(ctx) function');
      handler = definition.run;
      return true;
    }
  });

  const context = vm.createContext({
    Pigsty,
    console: Object.freeze({
      log: (...args) => events.push({ type: 'log', message: args.map(stringify).join(' ') }),
      warn: (...args) => events.push({ type: 'warn', message: args.map(stringify).join(' ') }),
      error: (...args) => events.push({ type: 'error', message: args.map(stringify).join(' ') })
    }),
    TextDecoder,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    structuredClone
  }, {
    name: 'pigsty-worker',
    codeGeneration: { strings: false, wasm: false }
  });

  new vm.Script(workerData.script, { filename: 'pigsty://worker.js' }).runInContext(context, { timeout: 1000 });
  if (!handler) throw new Error('Pigsty script did not call Pigsty.define(...)');
  const result = await handler(createApi());
  const payload = {
    ok: true,
    result: sanitizeResult(result),
    events,
    writes: [...writes].sort(),
    workspace: [...files.entries()]
      .map(([path, entry]) => ({ path, ...entry }))
      .sort((a, b) => a.path.localeCompare(b.path))
  };
  parentPort.postMessage(payload);
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || String(error), events });
}

function createApi() {
  const api = {
    args: structuredClone(workerData.args ?? {}),
    policy: structuredClone(workerData.policy ?? {}),
    list(prefix = '') {
      const root = prefix ? normalizePath(prefix).replace(/\/+$/, '') + '/' : '';
      return [...files.keys()].filter((path) => path.startsWith(root)).sort();
    },
    readText(path) {
      const entry = readEntry(path);
      return entry.encoding === 'base64'
        ? new TextDecoder().decode(Uint8Array.from(atobBytes(entry.data)))
        : String(entry.data ?? '');
    },
    readBytes(path) {
      const entry = readEntry(path);
      return entry.encoding === 'base64'
        ? Uint8Array.from(atobBytes(entry.data))
        : new TextEncoder().encode(String(entry.data ?? ''));
    },
    writeText(path, data) {
      const normalized = normalizePath(path);
      const text = String(data ?? '');
      files.set(normalized, { encoding: 'utf8', data: text });
      writes.add(normalized);
      enforceWorkspaceBudget();
      return true;
    },
    writeBytes(path, data) {
      const normalized = normalizePath(path);
      if (!(data instanceof Uint8Array)) throw new Error('writeBytes expects Uint8Array');
      files.set(normalized, { encoding: 'base64', data: btoaBytes(data) });
      writes.add(normalized);
      enforceWorkspaceBudget();
      return true;
    },
    remove(path) {
      const normalized = normalizePath(path);
      const removed = files.delete(normalized);
      if (removed) writes.add(normalized);
      return removed;
    }
  };
  return Object.freeze(api);
}

function readEntry(rawPath) {
  const path = normalizePath(rawPath);
  const entry = files.get(path);
  if (!entry) throw new Error(`Pigsty file not found: ${path}`);
  return entry;
}

function normalizePath(rawPath) {
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

function enforceWorkspaceBudget() {
  let total = 0;
  for (const entry of files.values()) {
    total += entry.encoding === 'base64'
      ? Math.ceil(String(entry.data ?? '').length * 3 / 4)
      : new TextEncoder().encode(String(entry.data ?? '')).byteLength;
  }
  if (files.size > 2048) throw new Error('Pigsty workspace has too many files');
  if (total > 32 * 1024 * 1024) throw new Error('Pigsty workspace is too large');
}

function sanitizeResult(value) {
  const json = JSON.stringify(value ?? null);
  if (new TextEncoder().encode(json).byteLength > MAX_RESULT_BYTES) throw new Error('Pigsty result is too large');
  return JSON.parse(json);
}

function stringify(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function atobBytes(base64) {
  return Buffer.from(String(base64 ?? ''), 'base64');
}

function btoaBytes(bytes) {
  return Buffer.from(bytes).toString('base64');
}
