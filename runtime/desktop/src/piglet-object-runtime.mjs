import { PigFsStore, measurePigFsStorage, mimeFor, openWurstRangeSource } from '@wurster/format';
import { pigletActorId, pigletRealmSummary, pigletRealmTemplates } from './piglet-object-pigfs-policy.mjs';

const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_READ = 2 * 1024 * 1024;

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(typeof value === 'string' ? value : value ?? []);
}

/**
 * Bind one logical Wurst object's virtual tail to PigFS without ever writing a
 * complete child snapshot back into an ancestor. Prepared PigFS records are
 * visible through a small in-memory overlay until the Wurst Object transaction
 * publishes them in one Root Commit.
 */
async function openObjectPigFs(world, actor) {
  if (world.objectPigFs) return world.objectPigFs;
  const runtime = world.runtimeSource;
  if (!runtime?.rootBacked || !runtime.store || !runtime.objectId) throw new Error('This Wurst session is not backed by the Root Object Store');
  const committed = runtime.source;
  let staged = [];
  let stagedBytes = 0;
  let objectAppend = null;

  const source = {
    get size() { return committed.size + stagedBytes; },
    set size(value) {
      const expected = committed.size + stagedBytes;
      if (Number(value) !== expected) throw new Error(`Root-backed Wurst virtual size diverged: expected ${expected}, got ${value}`);
    },
    async read(offset, length) {
      const start = Number(offset), wanted = Number(length);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(wanted) || start < 0 || wanted < 0 || start + wanted > this.size) throw new Error('Invalid logical Wurst range');
      if (!wanted) return Buffer.alloc(0);
      const boundary = committed.size;
      const chunks = [];
      let cursor = start;
      if (cursor < boundary) {
        const take = Math.min(wanted, boundary - cursor);
        chunks.push(Buffer.from(await committed.read(cursor, take)));
        cursor += take;
      }
      if (cursor < start + wanted) {
        let local = cursor - boundary;
        let remaining = start + wanted - cursor;
        for (const chunk of staged) {
          if (local >= chunk.length) { local -= chunk.length; continue; }
          const take = Math.min(remaining, chunk.length - local);
          chunks.push(chunk.subarray(local, local + take));
          remaining -= take; local = 0;
          if (!remaining) break;
        }
        if (remaining) throw new Error('Prepared Wurst state is truncated');
      }
      return Buffer.concat(chunks, wanted);
    }
  };

  const ensureAppend = async () => {
    if (!objectAppend) objectAppend = await runtime.store.beginObjectAppend(runtime.objectId, { actorId: pigletActorId(actor) });
    return objectAppend;
  };
  const append = async (record) => {
    const bytes = Buffer.from(record);
    const tx = await ensureAppend();
    await tx.append(bytes);
    staged.push(bytes);
    stagedBytes += bytes.length;
  };
  const sync = async () => {
    if (!objectAppend) return;
    const tx = objectAppend;
    objectAppend = null;
    try {
      await tx.commit();
      await committed.refresh?.();
      staged = [];
      stagedBytes = 0;
    } catch (error) {
      tx.abort?.();
      objectAppend = null;
      // The prepared physical arena bytes intentionally remain unreachable
      // garbage. Root publication did not happen, so the old state is authoritative.
      staged = [];
      stagedBytes = 0;
      throw error;
    }
  };

  const reader = await openWurstRangeSource(source);
  const store = new PigFsStore({ source, baseOffset: reader.baseLength, append, sync });
  await store.init();
  if (!store.root && reader.manifest?.pigfs?.format === 'wurst/pigfs-policy-1' && reader.manifest.pigfs.writable === true) {
    const realms = pigletRealmTemplates(reader.manifest, actor);
    await store.initialize({ actor, rootAdmins: pigletActorId(actor) ? [pigletActorId(actor)] : [], realms });
  }
  world.objectPigFs = { store, source, reader, committed, abortPrepared: () => objectAppend?.abort?.() };
  return world.objectPigFs;
}

export async function invokeRootBackedWurstService(world, method, args = [], { actor = null } = {}) {
  const runtime = await openObjectPigFs(world, actor);
  const store = runtime.store;
  const manifest = runtime.reader.manifest;
  const name = String(method ?? '');
  const writable = manifest?.pigfs?.writable === true;

  if (name === 'pigfs.capabilities') return {
    read: manifest?.pigfs?.format === 'wurst/pigfs-policy-1',
    write: writable,
    persistent: true,
    snapshot: true,
    mediaUrls: false,
    compact: false,
    protection: 'realms',
    format: store.root?.format ?? 'wurst/pigfs-1',
    realms: true,
    objectStorage: true,
    root: '/'
  };
  if (name === 'pigfs.realms') return pigletRealmSummary(store, manifest, actor);
  if (name === 'pigfs.usage') {
    if (!store.root) return { physicalBytes: Math.max(0, runtime.source.size - runtime.reader.baseLength), liveBytes: 0, reclaimableBytes: 0, logicalBytes: 0, files: 0, directories: 0, historyMode: 'none' };
    return measurePigFsStorage(runtime.source, store.root, { baseOffset: runtime.reader.baseLength, commitOffset: store.commitOffset, realmKeys: store.realmKeys });
  }
  if (name === 'pigfs.compact') return { compacted: false, reason: 'Root Wurst object arena is reclaimed by Root compaction' };
  if (!store.root) {
    if (['pigfs.stat', 'pigfs.read'].includes(name)) return null;
    if (name === 'pigfs.list') return [];
    if (!writable) throw new Error('This Wurst PigFS is not writable');
  }

  if (name === 'pigfs.stat') return store.stat(args[0] ?? '/');
  if (name === 'pigfs.list') return store.list(args[0] ?? '/');
  if (name === 'pigfs.read') {
    const options = args[1] || {};
    const offset = Number(options.offset ?? 0);
    const length = options.length == null ? MAX_READ : Math.min(Number(options.length), MAX_READ);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error('Invalid PigFS read range');
    const stat = await store.stat(args[0]);
    if (!stat || stat.type !== 'file') return null;
    const data = await store.read(args[0], { offset, length });
    const bytes = Buffer.from(data?.data ?? data ?? []);
    return { path: stat.path, mime: stat.mime, size: stat.size, offset, length: bytes.length, eof: offset + bytes.length >= stat.size, data: bytes };
  }
  if (!writable) throw new Error('This Wurst PigFS is not writable');

  if (name === 'pigfs.write') {
    const data = asBuffer(args[1]);
    const options = args[2] || {};
    const id = store.beginWrite(args[0], { actor, mime: typeof options.mime === 'string' ? options.mime : mimeFor(args[0]) });
    try {
      for (let offset = 0; offset < data.length || (data.length === 0 && offset === 0); offset += MAX_CHUNK) {
        await store.writeChunk(id, data.subarray(offset, Math.min(data.length, offset + MAX_CHUNK)));
        if (data.length === 0) break;
      }
      const result = await store.commitWrite(id);
      await runtime.committed.refresh?.();
      return { result: result.entry, committed: true };
    } catch (error) { store.abortWrite(id); throw error; }
  }
  if (name === 'pigfs.beginWrite') {
    const options = args[1] || {};
    const id = store.beginWrite(args[0], { actor, mime: typeof options.mime === 'string' ? options.mime : mimeFor(args[0]) });
    return { id, path: args[0], chunkSize: MAX_CHUNK };
  }
  if (name === 'pigfs.writeChunk') {
    const bytes = asBuffer(args[1]);
    if (bytes.length > MAX_CHUNK) throw new Error('PigFS chunks may not exceed 4 MiB');
    return store.writeChunk(String(args[0] ?? ''), bytes);
  }
  if (name === 'pigfs.commitWrite') {
    const result = await store.commitWrite(String(args[0] ?? ''));
    await runtime.committed.refresh?.();
    return { result: result.entry, committed: true };
  }
  if (name === 'pigfs.abortWrite') return store.abortWrite(String(args[0] ?? ''));
  if (name === 'pigfs.remove') {
    const result = await store.remove(args[0], { actor, recursive: Boolean(args[1]?.recursive) });
    await runtime.committed.refresh?.();
    return { result, committed: Boolean(result) };
  }
  if (name === 'pigfs.mkdir') {
    const result = await store.mkdir(args[0], { actor, recursive: args[1]?.recursive !== false });
    await runtime.committed.refresh?.();
    return { result, committed: true };
  }
  if (name === 'pigfs.rename') {
    const result = await store.rename(args[0], args[1], { actor });
    await runtime.committed.refresh?.();
    return { result, committed: Boolean(result) };
  }
  throw new Error(`Unsupported Root-backed Wurst service: ${name}`);
}

export async function closeRootBackedWurstService(world) {
  if (!world?.objectPigFs) return;
  try { world.objectPigFs.abortPrepared?.(); } catch {}
  try { world.objectPigFs.store?.close?.(); } catch {}
  try { await world.objectPigFs.reader?.close?.(); } catch {}
  world.objectPigFs = null;
}
