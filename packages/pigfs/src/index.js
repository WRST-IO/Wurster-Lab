import {
  PigFsStore,
  normalizePigFsPath,
  pigFsRealmCapabilities,
  pigFsRealmPublicPath,
  resolvePigFsPath
} from '@wurster/format';

export const PIG_FS_API_FORMAT = 'wurst/pigfs-api-1';
export const PIG_FS_SNAPSHOT_FORMAT = 'wurst/pigfs-snapshot-1';
export const PIG_FS_EVENT_FORMAT = 'wurst/pigfs-event-1';

export { PigFsStore, normalizePigFsPath, pigFsRealmCapabilities, pigFsRealmPublicPath, resolvePigFsPath };

export class PigFs {
  constructor(store) {
    if (!(store instanceof PigFsStore)) throw new TypeError('PigFs requires a PigFsStore');
    this.store = store;
  }
  realms() { return this.store.realms(); }
  realm(id) { return this.store.realm(id); }
  stat(path) { return this.store.stat(path); }
  list(path = '/') { return this.store.list(path); }
  read(path, options = {}) { return this.store.read(path, options); }
  mkdir(path, options = {}) { return this.store.mkdir(path, options); }
  remove(path, options = {}) { return this.store.remove(path, options); }
  rename(from, to, options = {}) { return this.store.rename(from, to, options); }
  symlink(target, path, options = {}) { return this.store.symlink(target, path, options); }
  readlink(path) { return this.store.readlink(path); }
  object(id) { return this.store.object(id); }
  snapshot(path = '/') { return this.store.snapshot(path); }
  watch(path, listener) { return this.store.watch(path, listener); }
  beginWrite(path, options = {}) { return this.store.beginWrite(path, options); }
  writeChunk(id, bytes) { return this.store.writeChunk(id, bytes); }
  commitWrite(id) { return this.store.commitWrite(id); }
  abortWrite(id) { return this.store.abortWrite(id); }
  async write(path, bytes, options = {}) {
    const id = this.beginWrite(path, options);
    try { await this.writeChunk(id, bytes); return await this.commitWrite(id); }
    catch (error) { this.abortWrite(id); throw error; }
  }
  beginTransaction(options = {}) { return this.store.beginTransaction(options); }
  transactionWrite(id, path, bytes, options = {}) { return this.store.transactionWrite(id, path, bytes, options); }
  transactionMkdir(id, path) { return this.store.transactionMkdir(id, path); }
  transactionRemove(id, path, options = {}) { return this.store.transactionRemove(id, path, options); }
  transactionRename(id, from, to) { return this.store.transactionRename(id, from, to); }
  commitTransaction(id) { return this.store.commitTransaction(id); }
  abortTransaction(id) { return this.store.abortTransaction(id); }
  async transaction(callback, options = {}) {
    const id = this.beginTransaction(options);
    const tx = {
      write: (path, bytes, writeOptions = {}) => this.transactionWrite(id, path, bytes, writeOptions),
      mkdir: (path) => this.transactionMkdir(id, path),
      remove: (path, removeOptions = {}) => this.transactionRemove(id, path, removeOptions),
      rename: (from, to) => this.transactionRename(id, from, to)
    };
    try { await callback(tx); return await this.commitTransaction(id); }
    catch (error) { this.abortTransaction(id); throw error; }
  }
}
