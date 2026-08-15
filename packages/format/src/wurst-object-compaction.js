import { WurstObjectStore } from './wurst-object-store.js';

/**
 * Copy only the reachable Wurst object graph into a new append arena. Object
 * IDs and immutable Base bytes are preserved; physical extents are rewritten.
 */
export async function copyLiveWurstObjectsForCompaction({ reader, tempSource, append, sync, targetPigFsCommitOffset }) {
  if (!reader.objectStoreRoot) return null;

  const sourceObjects = new WurstObjectStore({
    source: reader.source,
    baseOffset: reader.baseLength,
    append: async () => { throw new Error('Source Wurst Object Store is read-only during compaction'); }
  });
  sourceObjects.root = structuredClone(reader.objectStoreRoot);
  sourceObjects.commitOffset = reader.objectStoreCommitOffset;
  const sourceHost = await sourceObjects.object(sourceObjects.root.rootObjectId);
  if (!sourceHost?.hostRoot) throw new Error('Compaction source Wurst Object Store has no host root object');

  const targetObjects = new WurstObjectStore({ source: tempSource, baseOffset: reader.baseLength, append, sync });
  await targetObjects.init();
  await targetObjects.initializeHostRoot({
    objectId: sourceHost.objectId,
    applicationId: sourceHost.applicationId,
    packageDigest: sourceHost.packageDigest,
    baseBlobHash: sourceHost.baseBlobHash,
    baseSize: sourceHost.baseSize,
    virtualSize: tempSource.size,
    stateRevision: sourceHost.stateRevision,
    relationshipRevision: sourceHost.relationshipRevision,
    stateHash: sourceHost.stateHash,
    stateHead: targetPigFsCommitOffset,
    publisher: sourceHost.publisher,
    governance: sourceHost.governance
  });

  const queue = [sourceHost.objectId];
  while (queue.length) {
    const parentId = queue.shift();
    for (const relation of await sourceObjects.directChildren(parentId)) {
      const child = await sourceObjects.object(relation.childObjectId);
      const childSource = await sourceObjects.openObjectSource(child.objectId);
      await targetObjects.importObjectSnapshot({ parentObjectId: parentId, relation, source: childSource, object: child });
      queue.push(child.objectId);
    }
  }
  await targetObjects.verifyGraph({ deep: true });
  sourceObjects.close();
  targetObjects.close();
  return sourceHost.objectId;
}
