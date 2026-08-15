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
const context = {
  id: 'parent-runtime',
  manifest: {
    id: 'io.wrst.parent', name: 'Parent Wurst', version: '1.0.0',
    piglink: { format: 'wurst/piglink-1', actions: { ping: { input: { type: 'object' } } }, events: {} }
  }
};
const descriptor = {
  ref: 'builtin:child', source: 'builtin', application: { id: 'io.wrst.child' }, data: { writable: false },
  capabilities: { network: ['https://api.example.com/'] }
};

// PigLink is the cooperative default for a normal embedded child.
const cooperative = await runtime.open(context, descriptor, source);
const cooperativeSecondView = await runtime.open(context, descriptor, source);
assert.equal(cooperative.parent.piglink.access, 'connect');
assert.equal(cooperative.parent.pigfs, null);
assert.equal(cooperative.parent.piglets, null);
assert.equal(cooperative.session.id, cooperativeSecondView.session.id);
assert.equal(runtime.list(context)[0].views, 2);
assert.deepEqual(cooperative.parent.application, { id: 'io.wrst.parent', name: 'Parent Wurst', version: '1.0.0' });
assert.deepEqual(await runtime.invoke(context, cooperative.handle, 'piglink.describe', []), { method: 'piglink.describe', args: [] });
await assert.rejects(() => runtime.invoke(context, cooperative.handle, 'pigfs.list', ['/']), /not delegated/i);
await assert.rejects(() => runtime.open(context, descriptor, source, { parent: { pigfs: 'read' } }), (error) => error?.code === 'WURST_SESSION_RELATIONSHIP_CONFLICT');
runtime.close(context, cooperative.handle);
assert.equal(runtime.list(context)[0].views, 1);
runtime.close(context, cooperativeSecondView.handle);
assert.equal(runtime.list(context).length, 0);

const readOnly = await runtime.open(context, descriptor, source, { parent: { pigfs: 'read' } });
assert.equal(readOnly.parent.pigfs.access, 'read');
assert.equal(readOnly.composition.level, 'notice');
assert.equal(readOnly.composition.hostSecretsDelegated, false);
assert.ok(readOnly.composition.reasons.some((item) => item.code === 'parent-pigfs-to-network'));
assert.deepEqual(await runtime.invoke(context, readOnly.handle, 'pigfs.list', ['/']), { method: 'pigfs.list', args: ['/'] });
await assert.rejects(() => runtime.invoke(context, readOnly.handle, 'pigfs.write', ['/hello.txt', 'OINK']), /read-only/i);
runtime.close(context, readOnly.handle);

const manage = await runtime.open(context, descriptor, source, { parent: { pigfs: 'read-write', piglets: 'manage' } });
assert.equal(manage.parent.piglets.access, 'manage');
assert.deepEqual(await runtime.invoke(context, manage.handle, 'piglet.children', []), { method: 'piglet.children', args: [] });
assert.deepEqual(await runtime.invoke(context, manage.handle, 'piglet.install', ['Tool.wurst', new Uint8Array([1, 2, 3]), {}]), { method: 'piglet.install', args: ['Tool.wurst', new Uint8Array([1, 2, 3]), {}] });
runtime.close(context, manage.handle);

const isolated = await runtime.open(context, descriptor, source, { parent: { isolated: true } });
assert.equal(isolated.parent.isolated, true);
assert.equal(isolated.parent.piglink, null);
await assert.rejects(() => runtime.invoke(context, isolated.handle, 'piglink.describe', []), /unavailable/i);
runtime.close(context, isolated.handle);
await assert.rejects(() => runtime.open(context, descriptor, source, { parent: { isolated: true, pigfs: 'read' } }), /isolated/i);
await assert.rejects(() => runtime.open(context, descriptor, source, { parent: { piglets: 'admin' } }), /read.*manage/i);

assert.deepEqual(calls.map((item) => item.method), ['piglink.describe', 'pigfs.list', 'piglet.children', 'piglet.install']);
assert.equal(runtime.list(context).length, 0);
runtime.closeContext(context);
console.log('✓ Piglet relationships default to PigLink cooperation, delegate data/management explicitly and keep strict isolation opt-in');
