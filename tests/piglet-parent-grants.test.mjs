import assert from 'node:assert/strict';
import { createPigletEmbedRuntime } from '../runtime/desktop/src/piglet-embed-runtime.mjs';

const source = {
  size: 16,
  async read(offset, length) { return Buffer.from('0123456789abcdef').subarray(offset, offset + length); }
};
const storage = {
  async prepareRuntimeSource(_context, _descriptor, childSource) { return { source: childSource, path: null }; },
  async persistRuntimeSource() { throw new Error('not used'); },
  async openSource() { throw new Error('not used'); }
};
const calls = [];
const runtime = createPigletEmbedRuntime({
  storage,
  async invokeParent(context, method, args) {
    calls.push({ context, method, args });
    return { method, args };
  }
});
const context = { id: 'parent-runtime' };
const descriptor = { ref: 'builtin:child', source: 'builtin', application: { id: 'io.wrst.child' }, data: { writable: false } };

const isolated = await runtime.open(context, descriptor, source);
assert.equal(isolated.parent, null);
await assert.rejects(() => runtime.invoke(context, isolated.handle, 'pigfs.list', ['/']), /not delegated/i);

const readOnly = await runtime.open(context, descriptor, source, { parentPigFs: 'read' });
assert.deepEqual(readOnly.parent, { pigfs: { access: 'read' } });
assert.deepEqual(await runtime.invoke(context, readOnly.handle, 'pigfs.list', ['/']), { method: 'pigfs.list', args: ['/'] });
await assert.rejects(() => runtime.invoke(context, readOnly.handle, 'pigfs.write', ['/hello.txt', 'OINK']), /read-only/i);

const readWrite = await runtime.open(context, descriptor, source, { parentPigFs: 'read-write' });
assert.deepEqual(await runtime.invoke(context, readWrite.handle, 'pigfs.write', ['/hello.txt', 'OINK']), { method: 'pigfs.write', args: ['/hello.txt', 'OINK'] });
await assert.rejects(() => runtime.invoke(context, readWrite.handle, 'pigfs.compact', []), /Unsupported delegated parent operation/);
await assert.rejects(() => runtime.open(context, descriptor, source, { parentPigFs: 'admin' }), /read or read-write/);

assert.deepEqual(calls.map((item) => item.method), ['pigfs.list', 'pigfs.write']);
runtime.closeContext(context);
console.log('✓ Piglet parent grants are explicit, read/write scoped and never expose undelegated Parent PigFS access');
