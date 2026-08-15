import { loadFsRootAt, loadLatestFsRoot } from './pig-fs-records.js';
import { PIG_FS_FORMAT } from './pig-fs.js';
import { WurstObjectStore, loadLatestWurstObjectRoot } from './wurst-object-store.js';

/** Resolve the system Root Commit first, then the PigFS state head named by it. */
export async function loadAuthoritativeRuntimeRoots(source, baseLength, { physicalLatestPigFs = false } = {}) {
  const loadedObjects = await loadLatestWurstObjectRoot(source, baseLength);
  let hostObject = null;
  if (loadedObjects.root) {
    const readStore = new WurstObjectStore({ source, baseOffset: baseLength, append: async () => { throw new Error('Read-only Wurst Object Store'); } });
    readStore.root = loadedObjects.root;
    readStore.commitOffset = loadedObjects.commitOffset;
    hostObject = await readStore.object(loadedObjects.root.rootObjectId, loadedObjects.root);
    readStore.close();
  }
  const loadedFs = !physicalLatestPigFs && hostObject
    ? (hostObject.stateHead == null
        ? { root: null, commitOffset: null }
        : await loadFsRootAt(source, hostObject.stateHead, PIG_FS_FORMAT))
    : await loadLatestFsRoot(source, baseLength, PIG_FS_FORMAT);
  return { loadedFs, loadedObjects, hostObject };
}
