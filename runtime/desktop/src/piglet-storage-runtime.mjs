import crypto from 'node:crypto';
import path from 'node:path';
import { MAX_PIGLET_BYTES, PIGLET_MIME, inspectPigletBytes, normalizePigletBytes } from './piglet-package.mjs';

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
  waitForMaintenance
}) {
  async function readFile(context, rawPath) {
    const target = normalizeDataPath(rawPath);
    const options = await readOptions(context, target);
    const stat = await context.reader.fsStat(target, options);
    if (!stat || stat.type !== 'file') throw new Error(`Stored Piglet file not found: /${target}`);
    if (stat.size > MAX_PIGLET_BYTES) throw new Error(`Stored Piglet exceeds ${MAX_PIGLET_BYTES} byte runtime limit`);
    const chunks = [];
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < stat.size || (stat.size === 0 && offset === 0); offset += chunkSize) {
      const result = await context.reader.fsReadRange(target, offset, Math.min(chunkSize, Math.max(0, stat.size - offset)), options);
      chunks.push(Buffer.from(result.data));
      if (stat.size === 0) break;
    }
    return Buffer.concat(chunks, stat.size);
  }

  async function candidates(context) {
    if (!realmDataMode(context.manifest) || !context.reader.wurstFsRoot) return [];
    const realms = realmRuntimeSummary(context).filter((realm) => realm.initialized && !realm.locked && realm.capabilities?.read);
    const found = [];
    let visited = 0;
    for (const realm of realms) {
      const queue = [`data/${realm.id}`];
      while (queue.length) {
        const directory = queue.shift();
        const entries = await context.reader.fsList(directory, await readOptions(context, directory));
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
        const bytes = await readFile(context, storedPath);
        descriptors.push(await inspectPigletBytes(bytes, {
          ref: `wurstfs:${storedPath}`,
          id: storedPath,
          label: null,
          source: 'wurstfs',
          path: storedPath,
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
    if (!realm) throw new Error('Piglet installation needs a writable ordinary WurstFS realm or an explicit writable path');
    return `/data/${realm.id}/piglets/${safeName(requestedName)}`;
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
    return {
      ...inspected,
      ref: `wurstfs:${destination}`,
      id: destination,
      label: inspected.application?.name ?? path.basename(destination),
      source: 'wurstfs',
      path: destination,
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

  function runtimeCopyPath(context, descriptor) {
    const realm = realmRuntimeSummary(context).find((item) => item.governance === 'ordinary' && !item.locked && (item.capabilities?.write || !item.initialized));
    if (!realm) return null;
    return `/data/${realm.id}/piglets/.runtime/${descriptor.sha256}.wurst`;
  }

  async function prepareRuntimeSource(context, descriptor, bytes) {
    if (descriptor.source === 'wurstfs') {
      return { bytes: normalizePigletBytes(bytes), path: descriptor.path, expectedSha256: descriptor.sha256, materializedFrom: null };
    }
    if (!descriptor.data?.writable) return { bytes: normalizePigletBytes(bytes), path: null, expectedSha256: descriptor.sha256, materializedFrom: descriptor.ref };
    const destination = runtimeCopyPath(context, descriptor);
    if (!destination) throw new Error('Writable built-in Piglets require a writable ordinary parent WurstFS realm');
    try {
      const existing = await readFile(context, destination);
      const inspected = await inspectPigletBytes(existing);
      if (inspected.signature?.status === 'invalid' || inspected.application?.id !== descriptor.application?.id) throw new Error('Invalid materialized Piglet runtime copy');
      return { bytes: existing, path: destination, expectedSha256: crypto.createHash('sha256').update(existing).digest('hex'), materializedFrom: descriptor.ref };
    } catch {
      const installedSha = await writeExact(context, destination, bytes);
      return { bytes: normalizePigletBytes(bytes), path: destination, expectedSha256: installedSha, materializedFrom: descriptor.ref };
    }
  }

  async function persistRuntimeSource(context, source, bytes) {
    if (!source?.path) throw new Error('This Piglet has no persistent parent WurstFS backing');
    source.expectedSha256 = await writeExact(context, source.path, bytes, { expectedSha256: source.expectedSha256 });
    return source.expectedSha256;
  }

  async function remove(context, rawRef) {
    const raw = String(rawRef ?? '');
    const storedPath = raw.startsWith('wurstfs:') ? raw.slice('wurstfs:'.length) : raw;
    const target = normalizeDataPath(storedPath);
    const store = await ensureInitializedStore(context);
    const removed = await store.remove(target, { actor: activeActor(context), recursive: false });
    if (removed) {
      await refreshContext(context);
      scheduleHygiene(context, 700);
    }
    return Boolean(removed);
  }

  return { readFile, discover, install, remove, prepareRuntimeSource, persistRuntimeSource };
}
