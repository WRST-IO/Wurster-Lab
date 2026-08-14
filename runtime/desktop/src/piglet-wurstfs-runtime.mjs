export function bindPigletWurstFsPersistence(store, persistence) {
  if (!persistence?.flush) return store;
  const baseSync = store.sync.bind(store);
  store.sync = async () => {
    await baseSync();
    await persistence.flush();
  };
  return store;
}
