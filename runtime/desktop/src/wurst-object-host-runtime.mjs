import crypto from 'node:crypto';
import { openLocalWurstObjectStore, readFsRecord } from '@wurster/format';

async function sha256SourcePrefix(source, length) {
  const hash = crypto.createHash('sha256');
  const total = Number(length);
  for (let offset = 0; offset < total; offset += 4 * 1024 * 1024) {
    hash.update(await source.read(offset, Math.min(4 * 1024 * 1024, total - offset)));
  }
  return `sha256:${hash.digest('hex')}`;
}

async function rootLogicalWurstSize(context) {
  if (context.reader.pigFsCommitOffset == null) return context.reader.baseLength;
  const record = await readFsRecord(context.reader.source, context.reader.pigFsCommitOffset);
  return record.recordEnd;
}

export function createWurstObjectHostRuntime({ activeActor = () => null } = {}) {
  async function ensure(context) {
    if (context.objectStore) return context.objectStore;
    if (context.reader.carrier) throw new Error('Persistent Piglet object storage is unavailable for carrier Wursts');
    if (!context.filePath && context.ensurePigletBacking) await context.ensurePigletBacking();
    if (!context.filePath) throw new Error('Persistent Piglet object storage needs a local Root Wurst');

    const store = await openLocalWurstObjectStore(context.filePath, context.reader);
    if (!store.root) {
      const packageDigest = context.signature?.record?.statement?.packageDigest ?? null;
      const baseBlobHash = await sha256SourcePrefix(context.reader.source, context.reader.baseLength);
      await store.initializeHostRoot({
        applicationId: context.manifest?.id ?? null,
        packageDigest,
        baseBlobHash,
        baseSize: context.reader.baseLength,
        virtualSize: await rootLogicalWurstSize(context),
        stateRevision: context.reader.pigFsRoot?.generation ?? 0,
        stateHash: context.reader.pigFsRoot?.stateHash ?? null,
        stateHead: context.reader.pigFsCommitOffset ?? null,
        publisher: context.signature?.publisher ?? null,
        governance: null,
        actorId: activeActor(context)?.publicRecord?.identityId ?? null
      });
    }
    context.objectStore = store;
    context.reader.objectStoreRoot = structuredClone(store.root);
    context.reader.objectStoreCommitOffset = store.commitOffset;
    context.reader.objectStoreHost = await store.object(store.root.rootObjectId);
    return store;
  }

  async function refresh(context) {
    await context.reader.refreshWurstFs({ physicalLatest: true });
    if (!context.objectStore) return;
    try {
      await context.objectStore.syncHostState({
        stateRevision: context.reader.pigFsRoot?.generation ?? 0,
        stateHash: context.reader.pigFsRoot?.stateHash ?? null,
        stateHead: context.reader.pigFsCommitOffset ?? null,
        virtualSize: await rootLogicalWurstSize(context),
        actorId: activeActor(context)?.publicRecord?.identityId ?? null
      });
      context.reader.objectStoreRoot = structuredClone(context.objectStore.root);
      context.reader.objectStoreCommitOffset = context.objectStore.commitOffset;
      context.reader.objectStoreHost = await context.objectStore.object(context.objectStore.root.rootObjectId);
    } catch (error) {
      await context.reader.refreshWurstFs();
      throw error;
    }
  }

  async function close(context) {
    if (!context?.objectStore) return;
    if (context.objectStore.closeFile) await context.objectStore.closeFile().catch(() => {});
    else context.objectStore.close?.();
    context.objectStore = null;
  }

  return Object.freeze({ ensure, refresh, close });
}
