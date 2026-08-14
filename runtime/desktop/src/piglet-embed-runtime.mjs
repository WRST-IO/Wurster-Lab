import crypto from 'node:crypto';
import { inspectPigletSource } from './piglet-package.mjs';

function publicDescriptor(descriptor) {
  return {
    ref: descriptor.ref,
    source: descriptor.source,
    path: descriptor.path ?? null,
    application: structuredClone(descriptor.application ?? null),
    signature: structuredClone(descriptor.signature ?? null),
    data: structuredClone(descriptor.data ?? null),
    protection: structuredClone(descriptor.protection ?? null)
  };
}

function parentGrant(options = {}) {
  const access = String(options?.parentPigFs || '').trim().toLowerCase();
  if (!access) return null;
  if (!['read', 'read-write'].includes(access)) throw new TypeError('parentPigFs must be read or read-write');
  return Object.freeze({ pigfs: Object.freeze({ access }) });
}

const READ_METHODS = new Set(['pigfs.capabilities', 'pigfs.realms', 'pigfs.stat', 'pigfs.list', 'pigfs.read']);
const WRITE_METHODS = new Set(['pigfs.write', 'pigfs.beginWrite', 'pigfs.writeChunk', 'pigfs.commitWrite', 'pigfs.abortWrite', 'pigfs.remove', 'pigfs.mkdir', 'pigfs.rename']);

export function createPigletEmbedRuntime({ storage, invokeParent = null }) {
  const sessions = new Map();

  async function open(parentContext, descriptor, source, options = {}) {
    const runtimeSource = await storage.prepareRuntimeSource(parentContext, descriptor, source);
    const parent = parentGrant(options);
    const handle = `embed-${crypto.randomUUID()}`;
    sessions.set(handle, {
      handle,
      parentContext,
      descriptor,
      runtimeSource,
      source: runtimeSource.source,
      parent,
      closed: false
    });
    return {
      handle,
      size: runtimeSource.source.size,
      descriptor: publicDescriptor(descriptor),
      writable: Boolean(runtimeSource.path && descriptor.data?.writable),
      parent
    };
  }

  function requireSession(parentContext, rawHandle) {
    const session = sessions.get(String(rawHandle ?? ''));
    if (!session || session.closed || session.parentContext !== parentContext) throw new Error('Unknown Wurst embed handle');
    return session;
  }

  async function read(parentContext, rawHandle, offset, length) {
    const session = requireSession(parentContext, rawHandle);
    const start = Number(offset), size = Number(length);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > session.source.size) throw new Error('Invalid Wurst embed byte range');
    return session.source.read(start, size);
  }

  async function invoke(parentContext, rawHandle, method, args = []) {
    const session = requireSession(parentContext, rawHandle);
    if (!session.parent?.pigfs || typeof invokeParent !== 'function') throw new Error('Parent PigFS access was not delegated to this Piglet');
    const name = String(method ?? '');
    if (!READ_METHODS.has(name) && !WRITE_METHODS.has(name)) throw new Error(`Unsupported delegated parent operation: ${name}`);
    if (WRITE_METHODS.has(name) && session.parent.pigfs.access !== 'read-write') throw new Error('Parent PigFS grant is read-only');
    return invokeParent(parentContext, name, Array.isArray(args) ? args : []);
  }

  async function persist(parentContext, rawHandle, payload) {
    const session = requireSession(parentContext, rawHandle);
    if (!session.runtimeSource.path || !session.descriptor.data?.writable) throw new Error('This embedded Wurst is not writable');
    const bytes = payload instanceof Uint8Array ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength) : Buffer.from(payload ?? []);
    const inspected = await inspectPigletSource({ size: bytes.length, async read(offset, length) { return bytes.subarray(offset, offset + length); } });
    if (inspected.signature?.status === 'invalid') throw new Error(`Embedded Wurst signature became invalid: ${inspected.signature.error ?? 'verification failed'}`);
    if (inspected.application?.id !== session.descriptor.application?.id) throw new Error('Embedded Wurst identity changed during persistence');
    await storage.persistRuntimeSource(parentContext, session.runtimeSource, bytes);
    session.source = await storage.openSource(parentContext, session.runtimeSource.path);
    session.runtimeSource.source = session.source;
    return { ok: true, size: bytes.length, path: session.runtimeSource.path };
  }

  function close(parentContext, rawHandle) {
    const session = requireSession(parentContext, rawHandle);
    session.closed = true;
    sessions.delete(session.handle);
    return true;
  }

  function closeContext(parentContext) {
    for (const session of [...sessions.values()]) if (session.parentContext === parentContext) {
      session.closed = true;
      sessions.delete(session.handle);
    }
  }

  return { open, read, invoke, persist, close, closeContext };
}
