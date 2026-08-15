import { inspectPigletSource, normalizePigletBytes } from './piglet-package.mjs';

function actorId(activeActor, context) { return activeActor(context)?.publicRecord?.identityId ?? null; }
function persistentLocator(descriptor) {
  if (descriptor?.objectId) return `wurst-object:${descriptor.objectId}`;
  if (descriptor?.storageObjectId) return `pigfs-storage:${descriptor.storageObjectId}`;
  return String(descriptor?.ref || descriptor?.path || descriptor?.application?.id || 'child');
}

export function createPigletObjectStorageRuntime({ ensureObjectStore, activeActor, writeExact }) {
  async function prepareRuntimeSource(context, descriptor, source, { parentObjectId = null } = {}) {
    if (typeof ensureObjectStore !== 'function') {
      if (descriptor.data?.writable) throw new Error('Persistent Piglet object storage is unavailable');
      return { source, path: null, objectId: descriptor.objectId ?? null, rootBacked: false, expectedSha256: descriptor.sha256 ?? null, materializedFrom: descriptor.ref };
    }
    let store;
    try { store = await ensureObjectStore(context); }
    catch (error) {
      if (descriptor.data?.writable) throw error;
      return { source, path: null, objectId: descriptor.objectId ?? null, rootBacked: false, expectedSha256: descriptor.sha256 ?? null, materializedFrom: descriptor.ref };
    }

    const parentId = parentObjectId ?? store.root?.rootObjectId;
    if (!parentId) throw new Error('Root Wurst Object ID is unavailable');
    const locator = persistentLocator(descriptor);
    let object = await store.findChild(parentId, locator);
    if (object) {
      if (descriptor.packageDigest && object.packageDigest && descriptor.packageDigest !== object.packageDigest) {
        const error = new Error(`Piglet package changed for persistent Wurst object ${object.objectId}; use an explicit Package Transition`);
        error.code = 'WURST_PACKAGE_TRANSITION_REQUIRED';
        throw error;
      }
      if (descriptor.baseBlobHash && object.baseBlobHash && descriptor.baseBlobHash !== object.baseBlobHash) {
        const error = new Error(`Piglet immutable base changed for persistent Wurst object ${object.objectId}`);
        error.code = 'WURST_PACKAGE_TRANSITION_REQUIRED';
        throw error;
      }
    } else {
      object = await store.promote({
        parentObjectId: parentId,
        locator,
        source,
        baseSize: descriptor.baseSize,
        applicationId: descriptor.application?.id ?? null,
        packageDigest: descriptor.packageDigest ?? null,
        publisher: descriptor.signature?.publisher ?? null,
        stateRevision: descriptor.stateRevision ?? 0,
        stateHash: descriptor.stateHash ?? null,
        stateHead: descriptor.stateHead ?? null,
        governance: descriptor.governance ?? (descriptor.data?.writable ? null : { state: [], upgrade: [], relationship: 'open', delete: 'open' }),
        actorId: actorId(activeActor, context)
      });
    }
    const objectSource = await store.openObjectSource(object.objectId);
    return {
      source: objectSource,
      path: null,
      objectId: object.objectId,
      rootBacked: true,
      baseSize: object.baseSize,
      expectedSha256: null,
      materializedFrom: descriptor.ref,
      store
    };
  }

  async function persistRuntimeSource(context, runtimeSource, bytes) {
    if (!runtimeSource?.rootBacked || !runtimeSource.objectId || !runtimeSource.store) {
      if (!runtimeSource?.path) throw new Error('This Piglet has no persistent Root Wurst backing');
      runtimeSource.expectedSha256 = await writeExact(context, runtimeSource.path, bytes, { expectedSha256: runtimeSource.expectedSha256 });
      return runtimeSource.expectedSha256;
    }
    const normalized = normalizePigletBytes(bytes);
    const current = runtimeSource.source;
    if (normalized.length < current.size) {
      const error = new Error('Persistent Wurst state cannot shrink through append persistence; use compaction/materialization');
      error.code = 'WURST_SESSION_CONFLICT';
      throw error;
    }
    for (let offset = 0; offset < current.size; offset += 4 * 1024 * 1024) {
      const length = Math.min(4 * 1024 * 1024, current.size - offset);
      const expected = Buffer.from(await current.read(offset, length));
      if (!expected.equals(normalized.subarray(offset, offset + length))) {
        const error = new Error('Persistent Wurst changed outside its append-only object state');
        error.code = 'WURST_SESSION_CONFLICT';
        throw error;
      }
    }
    if (normalized.length === current.size) return runtimeSource.objectId;
    const inspected = await inspectPigletSource({
      size: normalized.length,
      async read(offset, length) { return normalized.subarray(offset, offset + length); }
    });
    if (inspected.packageDigest !== (await runtimeSource.store.object(runtimeSource.objectId))?.packageDigest) {
      const error = new Error('Persistent Wurst package identity changed during state persistence');
      error.code = 'WURST_PACKAGE_TRANSITION_REQUIRED';
      throw error;
    }
    const append = await runtimeSource.store.beginObjectAppend(runtimeSource.objectId, { actorId: actorId(activeActor, context) });
    try {
      await append.append(normalized.subarray(current.size));
      await append.commit({ stateHash: inspected.stateHash ?? undefined });
    } catch (error) {
      append.abort();
      throw error;
    }
    await current.refresh?.();
    return runtimeSource.objectId;
  }

  return Object.freeze({ prepareRuntimeSource, persistRuntimeSource });
}
