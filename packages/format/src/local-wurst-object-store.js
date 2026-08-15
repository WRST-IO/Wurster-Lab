import { acquireLocalWurstArena } from './local-wurst-arena.js';
import { WurstObjectStore } from './wurst-object-store.js';

/** Open the system Wurst Object Store that shares the physical Root Wurst arena. */
export async function openLocalWurstObjectStore(filePath, reader, { verifyPublisherTransition = null } = {}) {
  if (!reader?.source || !Number.isSafeInteger(reader.baseLength)) throw new Error('A live Wurst reader is required');
  if (reader.carrier) throw new Error('Wurst Object Store writes are not available for carrier Wursts');
  const arena = await acquireLocalWurstArena(filePath, reader.source);
  let closed = false;
  const store = new WurstObjectStore({
    source: reader.source,
    baseOffset: reader.baseLength,
    appendRecord: arena.appendRecord,
    sync: async () => {
      if (closed) throw new Error('Wurst Object Store writer is closed');
      await arena.sync();
    },
    verifyPublisherTransition
  });
  await store.init();
  store.closeFile = async () => {
    if (closed) return;
    closed = true;
    store.close();
    await arena.release();
  };
  return store;
}
