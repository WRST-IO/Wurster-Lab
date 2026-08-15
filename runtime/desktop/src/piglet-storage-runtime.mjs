import crypto from 'node:crypto';
import path from 'node:path';
import { MAX_PIGLET_BYTES, PIGLET_MIME, inspectPigletBytes, inspectPigletSource, normalizePigletBytes, sha256PigletSource } from './piglet-package.mjs';
import { createPigletObjectStorageRuntime } from './piglet-object-storage-runtime.mjs';

const PIGLET_EXT_RE = /\.(?:wurst|wrst)$/i;
const MAX_DISCOVERY_ENTRIES = 1024;

function publicPath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function safeName(value = 'Piglet.wurst') {
  const base = path.basename(String(value || 'Piglet.wurst')).replace(/[^a-zA-Z0-9._ -]+/g, '-').slice(0, 160) || 'Piglet.wurst';
  return PIGLET_EXT_RE.test(base) ? base : `${base}.wurst`;
}

export function createPigletStorageAdapter({
  realmDataMode,
  realmRuntimeSummary,
  readOptions,
  ensureInitializedStore,
  activeActor,
  refreshContext,
  scheduleHygiene,
  normalizeDataPath,
  waitForMaintenance,
  ensureObjectStore
}) {
  async function openSource(context, rawPath) {
    const target = normalizeDataPath(rawPath);
    const options = await readOptions(context, target);
    const stat = await context.reader.pigFsStat(target, options);
    if (!stat || stat.type !== 'file') throw new Error(`Stored Piglet file not found: /${target}`);
    if (stat.size > MAX_PIGLET_BYTES) throw new Error(`Stored Piglet exceeds ${MAX_PIGLET_BYTES} byte runtime limit`);
    return {
      size: stat.size,
      path: publicPath(target),
      objectId: stat.objectId ?? null,
      async read(offset, length) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > stat.size) throw new Error('Invalid stored Piglet range');
        const result = await context.reader.pigFsReadRange(target, offset, length, options);
        return Buffer.from(result?.data ?? []);
      }
    };
  }

  async function readFile(context, rawPath) {
    const source = await openSource(context, rawPath);
    const chunks = [];
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < source.size; offset += chunkSize) chunks.push(Buffer.from(await source.read(offset, Math.min(chunkSize, source.size - offset))));
    return Buffer.concat(chunks, source.size);
  }

  async function candidates(context) {
    if (!realmDataMode(context.manifest) || !context.reader.pigFsRoot) return [];
    const realms = realmRuntimeSummary(context).filter((realm) => realm.initialized && !realm.locked && realm.capabilities?.read);
    const found = [];
    let visited = 0;
    for (const realm of realms) {
      const queue = [realm.mount || `/${realm.id}`];
      while (queue.length) {
        const directory = queue.shift();
        const entries = await context.reader.pigFsList(directory, await readOptions(context, directory));
        for (const entry of entries) {
          visited += 1;
          if (visited > MAX_DISCOVERY_ENTRIES) return found;
          if (entry.type === 'directory') queue.push(entry.path);
          else if (entry.type === 'file' && PIGLET_EXT_RE.test(entry.path) && entry.size <= MAX_PIGLET_BYTES && !entry.path.includes('/piglets/.runtime/')) found.push(publicPath(entry.path));
        }
      }
    }
    return found;
  }

  async function discover(context) {
    const descriptors = [];
    for (const storedPath of await candidates(context)) {
      try {
        const source = await openSource(context, storedPath);
        descriptors.push(await inspectPigletSource(source, {
          ref: `pigfs:${storedPath}`,
          id: storedPath,
          label: null,
          source: 'pigfs',
          path: storedPath,
          storageObjectId: source.objectId ?? null,
          mutable: true
        }));
      } catch {
        // A file ending in .wurst is still just a file until it verifies as a Wurst.
      }
    }
    return descriptors.map((item) => ({ ...item, label: item.label ?? item.application?.name ?? path.basename(item.path) }));
  }

  function defaultPath(context, requestedName) {
    const realm = realmRuntimeSummary(context).find((item) => item.governance === 'ordinary' && !item.locked && (item.capabilities?.write || !item.initialized));
    if (!realm) throw new Error('Piglet installation needs a writable ordinary PigFS realm or an explicit writable path');
    return `${String(realm.mount || `/${realm.id}`).replace(/\/$/, '')}/piglets/${safeName(requestedName)}`;
  }

  async function install(context, value, options = {}) {
    await waitForMaintenance(context);
    const bytes = normalizePigletBytes(value);
    const inspected = await inspectPigletBytes(bytes);
    if (inspected.signature?.status === 'invalid') throw new Error(`Piglet Wurst signature is invalid: ${inspected.signature.error ?? 'verification failed'}`);
    const destination = publicPath(options.path || defaultPath(context, options.name || `${inspected.application?.name || 'Piglet'}.wurst`));
    if (!PIGLET_EXT_RE.test(destination)) throw new Error('Stored Piglets must use a .wurst or .wrst filename');
    const target = normalizeDataPath(destination);
    const store = await ensureInitializedStore(context);
    const actor = activeActor(context);
    const parent = target.split('/').slice(0, -1).join('/');
    if (parent) await store.mkdir(parent, { actor, recursive: true });
    const id = store.beginWrite(target, { actor, mime: PIGLET_MIME });
    try {
      for (let offset = 0; offset < bytes.length || (bytes.length === 0 && offset === 0); offset += 4 * 1024 * 1024) {
        await store.writeChunk(id, bytes.subarray(offset, Math.min(bytes.length, offset + 4 * 1024 * 1024)));
        if (bytes.length === 0) break;
      }
      await store.commitWrite(id);
    } catch (error) {
      store.abortWrite(id);
      throw error;
    }
    await refreshContext(context);
    scheduleHygiene(context);
    const installed = await openSource(context, destination);
    return {
      ...inspected,
      ref: `pigfs:${destination}`,
      id: destination,
      label: inspected.application?.name ?? path.basename(destination),
      source: 'pigfs',
      path: destination,
      storageObjectId: installed.objectId ?? null,
      mutable: true
    };
  }

  async function writeExact(context, destination, bytes, { expectedSha256 = null } = {}) {
    await waitForMaintenance(context);
    const normalized = normalizePigletBytes(bytes);
    if (expectedSha256) {
      const current = await readFile(context, destination);
      const actual = crypto.createHash('sha256').update(current).digest('hex');
      if (actual !== expectedSha256) {
        const error = new Error(`Piglet changed outside its running instance: ${destination}`);
        error.code = 'WURST_PIGLET_CONFLICT';
        throw error;
      }
    }
    const target = normalizeDataPath(destination);
    const store = await ensureInitializedStore(context);
    const actor = activeActor(context);
    const parent = target.split('/').slice(0, -1).join('/');
    if (parent) await store.mkdir(parent, { actor, recursive: true });
    const id = store.beginWrite(target, { actor, mime: PIGLET_MIME });
    try {
      for (let offset = 0; offset < normalized.length; offset += 4 * 1024 * 1024) {
        await store.writeChunk(id, normalized.subarray(offset, Math.min(normalized.length, offset + 4 * 1024 * 1024)));
      }
      await store.commitWrite(id);
    } catch (error) {
      store.abortWrite(id);
      throw error;
    }
    await refreshContext(context);
    scheduleHygiene(context);
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  const objectStorage = createPigletObjectStorageRuntime({ ensureObjectStore, activeActor, writeExact });
  const { prepareRuntimeSource, persistRuntimeSource } = objectStorage;

  async function fingerprintRuntimeSource(source) {
    return sha256PigletSource(source);
  }

  async function remove(context, rawRef) {
    const raw = String(rawRef ?? '');
    const storedPath = raw.startsWith('pigfs:') ? raw.slice('pigfs:'.length) : raw;
    const target = normalizeDataPath(storedPath);
    let storageObjectId = null;
    try {
      const stat = await context.reader.pigFsStat(target, await readOptions(context, target));
      storageObjectId = stat?.objectId ?? null;
    } catch {}
    const store = await ensureInitializedStore(context);
    const removed = await store.remove(target, { actor: activeActor(context), recursive: false });
    if (removed) {
      if (context.objectStore?.root) {
        const rootId = context.objectStore.root.rootObjectId;
        let child = storageObjectId ? await context.objectStore.findChild(rootId, `pigfs-storage:${storageObjectId}`) : null;
        if (!child) child = await context.objectStore.findChild(rootId, `pigfs:${publicPath(target)}`); // pre-0.33 migration locator
        if (child) await context.objectStore.deleteSubtree(child.objectId, { actorId: activeActor(context)?.publicRecord?.identityId ?? null });
      }
      await refreshContext(context);
      scheduleHygiene(context, 700);
    }
    return Boolean(removed);
  }

  return { openSource, readFile, discover, install, remove, prepareRuntimeSource, persistRuntimeSource, fingerprintRuntimeSource };
}
