import crypto from 'node:crypto';
import {
  decryptProtectedRange,
  encryptProtectedBuffer,
  openWurstFile,
  unlockApplicationDataKey
} from '@wurster/format';

export class ProtectionCore {
  constructor() {
    this.handles = new Map();
  }

  newHandle(dataKey, filePath = null, kind = 'generic') {
    const id = crypto.randomUUID();
    this.handles.set(id, { dataKey, filePath, kind });
    return id;
  }

  getHandle(id) {
    const item = this.handles.get(String(id));
    if (!item) throw new Error('Protection handle is not available');
    return item;
  }

  destroyHandle(id) {
    const item = this.handles.get(String(id));
    if (!item) return false;
    item.dataKey?.fill(0);
    this.handles.delete(String(id));
    return true;
  }

  async readProtectedSlice({ handle, path, offset = 0, length = null }) {
    const state = this.getHandle(handle);
    if (!state.filePath) throw new Error('Protection handle is not attached to a Wurst file');
    const reader = await openWurstFile(state.filePath);
    try {
      const entry = reader.entry(path);
      if (!entry || !entry.encryption) throw new Error('Protected resource not found');
      const total = entry.encryption?.plainLength ?? entry.length;
      const start = Number(offset);
      const wanted = length == null ? total - start : Number(length);
      if (!Number.isSafeInteger(start) || start < 0 || start > total) throw new Error('Invalid Protected slice offset');
      if (!Number.isSafeInteger(wanted) || wanted < 0) throw new Error('Invalid Protected slice length');
      const bounded = Math.min(wanted, total - start);

      const data = await decryptProtectedRange(
        entry,
        async (cipherOffset, cipherLength) => (await reader.readRange(path, cipherOffset, cipherLength, { verify: true })).data,
        state.dataKey,
        start,
        bounded
      );
      return { data, mime: entry.mime, offset: start, length: data.length, total, eof: start + data.length >= total };
    } finally {
      await reader.close();
    }
  }

  async dispatch(type, payload = {}) {
    switch (type) {
      case 'unlock-application': {
        const dataKey = unlockApplicationDataKey(payload.manifest, payload.wurstKey);
        return { handle: this.newHandle(dataKey, payload.filePath ?? null, 'application') };
      }
      case 'attach': {
        const item = this.getHandle(payload.handle);
        item.filePath = payload.filePath;
        return true;
      }
      case 'read':
        return this.readProtectedSlice(payload);
      case 'encrypt': {
        const item = this.getHandle(payload.handle);
        return encryptProtectedBuffer(payload.path, payload.data, item.dataKey, {
          scope: payload.scope ?? 'app',
          mime: payload.mime,
          chunkSize: payload.chunkSize
        });
      }
      case 'destroy':
        return this.destroyHandle(payload.handle);
      case 'shutdown': {
        for (const id of [...this.handles.keys()]) this.destroyHandle(id);
        return true;
      }
      default:
        throw new Error(`Unknown protection worker command: ${type}`);
    }
  }
}
