import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { utilityProcess } from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(HERE, 'protection-worker.mjs');

export class ProtectionClient {
  constructor() {
    this.pending = new Map();
    this.child = null;
  }

  ensureChild() {
    if (this.child) return this.child;
    const child = utilityProcess.fork(WORKER_PATH, [], { stdio: 'ignore', serviceName: 'Wurster Protection' });
    child.on('message', (message) => {
      const pending = this.pending.get(message?.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'Protection worker failed'));
    });
    child.on('exit', (code) => {
      const error = new Error(`Wurster Protection process exited (${code})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (this.child === child) this.child = null;
    });
    this.child = child;
    return child;
  }

  call(type, payload = {}) {
    const child = this.ensureChild();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.postMessage({ id, type, payload });
    });
  }

  unlockApplication(payload) { return this.call('unlock-application', payload); }
  attach(handle, filePath) { return this.call('attach', { handle, filePath }); }
  read(payload) { return this.call('read', payload); }
  encrypt(payload) { return this.call('encrypt', payload); }
  destroy(handle) { return handle ? this.call('destroy', { handle }).catch(() => false) : Promise.resolve(false); }

  async shutdown() {
    if (!this.child) return false;
    const child = this.child;
    try { await this.call('shutdown'); } catch {}
    try { child.kill(); } catch {}
    if (this.child === child) this.child = null;
    return true;
  }
}
