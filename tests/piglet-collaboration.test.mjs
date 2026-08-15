import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { encodeWurst } from '../packages/format/src/index.js';
import { WurstSessionRegistry, analyzePigletAuthorityComposition, assertPigletParentMethod, normalizePigletRelationship } from '@wurster/piglet';
import { WursterWebSession } from '../runtime/web/src/wurster-web.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.location) globalThis.location = { origin: 'https://wurster.test', href: 'https://wurster.test/' };
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
if (!globalThis.removeEventListener) globalThis.removeEventListener = () => {};

const parentManifest = {
  id: 'io.wrst.parent', name: 'Parent', version: '1.0.0',
  piglink: { format: 'wurst/piglink-1', actions: { ping: { input: { type: 'object' } } }, events: { changed: { payload: { type: 'object' } } } }
};

const cooperative = normalizePigletRelationship({}, { parentPigLink: true });
assert.equal(cooperative.isolated, false);
assert.equal(cooperative.piglink.access, 'connect');
assert.equal(cooperative.pigfs, null);
assert.equal(cooperative.piglets, null);

const systemTool = normalizePigletRelationship({ pigfs: 'read-write', piglets: 'manage' }, { parentPigLink: true });
for (const method of ['piglink.describe', 'piglink.invoke', 'pigfs.list', 'pigfs.write', 'piglet.children', 'piglet.install']) {
  assert.doesNotThrow(() => assertPigletParentMethod(systemTool, method));
}
for (const method of ['files.open', 'files.save', 'auth.status', 'identity.session', 'shell.openExternal', 'pigsty.run', 'capabilities.list']) {
  assert.throws(() => assertPigletParentMethod(systemTool, method), /Unsupported delegated parent operation/);
}
const readOnly = normalizePigletRelationship({ pigfs: 'read', piglets: 'read' }, { parentPigLink: true });
assert.throws(() => assertPigletParentMethod(readOnly, 'pigfs.write'), /read-only/);
assert.throws(() => assertPigletParentMethod(readOnly, 'piglet.install'), /read-only/);
assert.throws(() => normalizePigletRelationship({ isolated: true, pigfs: 'read' }, { parentPigLink: true }), /isolated/i);
assert.throws(() => normalizePigletRelationship({ pigfs: 'read' }, { parentPigFs: null }), /unavailable/);
assert.throws(() => normalizePigletRelationship({ pigfs: 'read-write' }, { parentPigFs: 'read' }), /parent only has read/);
assert.throws(() => normalizePigletRelationship({ piglets: 'manage' }, { parentPiglets: 'read' }), /parent only has read/);

const composition = analyzePigletAuthorityComposition(systemTool, { capabilities: { network: ['https://api.example.com/'] } });
assert.equal(composition.level, 'notice');
assert.equal(composition.hostSecretsDelegated, false);
assert.ok(composition.reasons.some((item) => item.code === 'parent-pigfs-to-network'));

// One Wurst world may have many views/machine clients, but only one durable session.
let nextSession = 0, nextAttachment = 0, clock = 100;
const registry = new WurstSessionRegistry({
  now: () => ++clock,
  createSessionId: () => `session-${++nextSession}`,
  createAttachmentId: () => `attachment-${++nextAttachment}`
});
const relationship = normalizePigletRelationship({}, { parentPigLink: true });
const firstView = registry.attach('parent-a', 'pigfs://object/child-1', { kind: 'view', relationship });
const secondView = registry.attach('parent-a', 'pigfs://object/child-1', { kind: 'view', relationship });
const machine = registry.attach('parent-a', 'pigfs://object/child-1', { kind: 'machine', relationship });
assert.equal(firstView.created, true);
assert.equal(secondView.created, false);
assert.equal(firstView.session.id, secondView.session.id);
assert.equal(machine.session.id, firstView.session.id);
assert.deepEqual(registry.list('parent-a').map(({ views, machines }) => ({ views, machines })), [{ views: 2, machines: 1 }]);
assert.throws(() => registry.attach('parent-a', 'pigfs://object/child-1', { relationship: normalizePigletRelationship({ isolated: true }, { parentPigLink: true }) }), (error) => error?.code === 'WURST_SESSION_RELATIONSHIP_CONFLICT');
const revision1 = registry.bump(firstView.attachment.id);
assert.equal(revision1.revision, 1);
assert.throws(() => registry.requireFresh(secondView.attachment.id), (error) => error?.code === 'WURST_SESSION_CONFLICT' && error?.session?.revision === 1);
assert.equal(registry.refresh(secondView.attachment.id).attachment.baseRevision, 1);
assert.doesNotThrow(() => registry.requireFresh(secondView.attachment.id));
assert.equal(registry.release(firstView.attachment.id).closed, false);
assert.equal(registry.release(secondView.attachment.id).closed, false);
assert.equal(registry.release(machine.attachment.id).closed, true);
assert.equal(registry.list('parent-a').length, 0);

const childManifest = {
  format: 'wurst/7', id: 'io.wrst.child', name: 'Child', version: '1.0.0', entry: 'index.html',
  application: { protection: 'public' }, capabilities: {},
  pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'workspace', mount: '/workspace' }] },
  piglink: {
    format: 'wurst/piglink-1', headless: true, entry: '__wurst/piglink/entry.js',
    actions: { echo: { input: { type: 'object', properties: { oink: { type: 'integer' } }, required: ['oink'] }, output: { type: 'object', properties: { echoed: { type: 'object' } }, required: ['echoed'] }, timeoutMs: 1000 } },
    events: { changed: { payload: { type: 'object', properties: { revision: { type: 'integer' } }, required: ['revision'] } } }
  }
};
const childBytes = encodeWurst({ manifest: childManifest, files: [
  { path: 'index.html', data: Buffer.from('<h1>child</h1>'), mime: 'text/html', scope: 'app' },
  { path: '__wurst/piglink/entry.js', data: Buffer.from('PigLink.define({actions:{echo:x=>x}})'), mime: 'text/javascript', scope: 'piglink' }
] });

const childDigest = createHash('sha256').update(childBytes).digest('hex');
const parentPackage = encodeWurst({
  manifest: {
    format: 'wurst/7', id: parentManifest.id, name: parentManifest.name, version: parentManifest.version, entry: 'index.html',
    application: { protection: 'public' }, capabilities: {}, piglink: parentManifest.piglink,
    pigfs: { format: 'wurst/pigfs-policy-1', writable: true, realms: [{ id: 'workspace', mount: '/workspace' }] },
    piglet: { format: 'wurst/piglet-1', children: [{ id: 'child', entry: '__wurst/piglets/child.wurst', length: childBytes.length, sha256: childDigest }] }
  },
  files: [
    { path: 'index.html', data: Buffer.from('<h1>parent</h1>'), mime: 'text/html', scope: 'app' },
    { path: '__wurst/piglets/child.wurst', data: childBytes, mime: 'application/vnd.wrst.wurst', scope: 'piglet' }
  ]
});
const parentSession = await WursterWebSession.open(new Blob([parentPackage]), { sessionId: 'collaboration-parent' });
const openedChild = await parentSession._openEmbedSource('builtin:child', { parent: { pigfs: 'read-write', piglets: 'manage' } });
assert.equal(openedChild.parent.piglink.access, 'connect');
assert.equal(openedChild.parent.pigfs.access, 'read-write');
assert.equal(openedChild.parent.piglets.access, 'manage');
assert.equal(openedChild.composition.hostSecretsDelegated, false);
assert.equal(openedChild.composition.requiresAdditionalGrant, false);
await assert.rejects(() => parentSession._openEmbedSource('builtin:child', { parent: { isolated: true } }), (error) => error?.code === 'WURST_SESSION_RELATIONSHIP_CONFLICT');
await parentSession._closeEmbedSource(openedChild.handle);
const isolatedChild = await parentSession._openEmbedSource('builtin:child', { parent: { isolated: true } });
assert.equal(isolatedChild.parent.piglink, null);
await assert.rejects(() => parentSession._openEmbedSource('builtin:child', { parent: { isolated: true, pigfs: 'read' } }), /isolated/i);
await parentSession._closeEmbedSource(isolatedChild.handle);

// Two views of one PigFS-held Wurst share one session and revision coordinator.
await parentSession.fs.write('/workspace/child.wurst', new Uint8Array(childBytes), { mime: 'application/vnd.wrst.wurst' });
const viewA = await parentSession._openEmbedSource('pigfs:/workspace/child.wurst');
const viewB = await parentSession._openEmbedSource('pigfs:/workspace/child.wurst');
assert.equal(viewA.session.id, viewB.session.id);
assert.equal(viewA.session.locator.startsWith('pigfs://object/'), true);
assert.deepEqual(parentSession._runningPiglets().map(({ views, machines }) => ({ views, machines })), [{ views: 2, machines: 0 }]);

const machineClient = await parentSession._openEmbedSource('pigfs:/workspace/child.wurst', { kind: 'machine' });
assert.equal(machineClient.session.id, viewA.session.id, 'Web machine clients must attach to the same Wurst session as views');
assert.deepEqual(parentSession._runningPiglets().map(({ views, machines }) => ({ views, machines })), [{ views: 2, machines: 1 }]);
assert.equal((await parentSession._describeMachine(machineClient.handle)).piglink.headless, true);
const originalMountMachine = WursterWebSession.prototype.mountMachine;
const originalInvokePigLink = WursterWebSession.prototype.invokePigLink;
WursterWebSession.prototype.mountMachine = async function () { return this; };
WursterWebSession.prototype.invokePigLink = async function (name, input = {}) {
  assert.equal(name, 'echo');
  await this.fs.write('/workspace/machine.txt', new TextEncoder().encode(String(input.text || '')), { mime: 'text/plain' });
  await this._persistPigFs();
  return { echoed: input };
};
try {
  const machineResult = await parentSession._invokeMachine(machineClient.handle, 'echo', { text: 'from web machine' });
  assert.deepEqual(machineResult.result, { echoed: { text: 'from web machine' } });
  assert.equal(machineResult.session.revision, 1, 'Web machine PigFS writes must bump the shared Wurst session');
} finally {
  WursterWebSession.prototype.mountMachine = originalMountMachine;
  WursterWebSession.prototype.invokePigLink = originalInvokePigLink;
}
await assert.rejects(() => parentSession._persistEmbedSource(viewB.handle, childBytes), (error) => error?.code === 'WURST_SESSION_CONFLICT');
assert.equal(parentSession._refreshEmbedSource(viewB.handle).session.revision, 1);
await parentSession._closeEmbedSource(machineClient.handle);
assert.deepEqual(parentSession._runningPiglets().map(({ views, machines }) => ({ views, machines })), [{ views: 2, machines: 0 }]);

const childWriter = await WursterWebSession.open(new Blob([childBytes]), { sessionId: 'shared-child-writer' });
await childWriter.fs.write('/workspace/shared.txt', new TextEncoder().encode('from view A'), { mime: 'text/plain' });
const changedChild = new Uint8Array(await (await childWriter.fs.snapshotBlob()).arrayBuffer());
await childWriter.close();
parentSession._refreshEmbedSource(viewA.handle);
const persisted = await parentSession._persistEmbedSource(viewA.handle, changedChild);
assert.equal(persisted.session.revision, 2);
await assert.rejects(() => parentSession._persistEmbedSource(viewB.handle, changedChild), (error) => error?.code === 'WURST_SESSION_CONFLICT');
const refreshed = parentSession._refreshEmbedSource(viewB.handle);
assert.equal(refreshed.session.revision, 2);
const reloaded = await WursterWebSession.open(new Blob([await parentSession.fs.read('/workspace/child.wurst')]), { sessionId: 'shared-child-reader' });
assert.equal(new TextDecoder().decode(await reloaded.fs.read('/workspace/shared.txt')), 'from view A');
await reloaded.close();
await parentSession._closeEmbedSource(viewA.handle);
assert.equal(parentSession._runningPiglets()[0].views, 1);
await parentSession._closeEmbedSource(viewB.handle);
assert.equal(parentSession._runningPiglets().length, 0);
await parentSession.fs.dispose();

const session = await WursterWebSession.open(new Blob([childBytes]), {
  sessionId: 'collaboration-child',
  parent: { format: 'wurst/piglet-relationship-1', isolated: false, application: parentManifest, piglink: { access: 'connect' }, pigfs: null, piglets: null }
});

const posted = [];
const childWindow = {
  postMessage(message) {
    posted.push(message);
    if (message?.__wursterPigLinkInvoke) {
      queueMicrotask(() => session._onFrameMessage({
        source: childWindow,
        data: { __wursterPigLinkResult: 1, sessionId: session.id, id: message.id, ok: true, result: { echoed: message.input } }
      }));
    }
  }
};
session.frame = { contentWindow: childWindow, remove() {} };
assert.deepEqual(await session.invokePigLink('echo', { oink: 1 }), { echoed: { oink: 1 } });
await assert.rejects(() => session.invokePigLink('echo', { oink: 'bad' }), /integer/);

let childEvent = null;
const stop = session.onPigLinkEvent((name, payload) => { childEvent = { name, payload }; });
await session._onFrameMessage({ source: childWindow, data: { __wursterEvent: 1, sessionId: session.id, name: 'changed', payload: { revision: 2 } } });
assert.deepEqual(childEvent, { name: 'changed', payload: { revision: 2 } });
assert.ok(posted.some((message) => message?.__wursterPigLinkEventAccepted && message.name === 'changed'));
childEvent = null;
await session._onFrameMessage({ source: childWindow, data: { __wursterEvent: 1, sessionId: session.id, name: 'changed', payload: { revision: 'bad' } } });
assert.equal(childEvent, null, 'invalid PigLink events must not cross the runtime boundary');
stop();

assert.equal(session.deliverParentPigLinkEvent('changed', { revision: 3 }), true);
assert.ok(posted.some((message) => message?.__wursterParentPigLinkEvent && message.payload?.revision === 3));

await session.close();

const embedSource = await fs.readFile(new URL('../runtime/web/src/wurster-embed.mjs', import.meta.url), 'utf8');
assert.match(embedSource, /get relationship\(\)/);
assert.match(embedSource, /get authorityComposition\(\)/);
assert.match(embedSource, /get descriptor\(\)/);
assert.match(embedSource, /piglink = Object\.freeze/);
assert.match(embedSource, /wurst-authority-composition/);
assert.match(embedSource, /Parent Wurst delegation requires <wurst-embed> to run inside a Wurst runtime/);
assert.doesNotMatch(embedSource, /WebContentsView/);

console.log('✓ Piglet collaboration keeps Host services outside while PigLink, Parent PigFS and Parent Piglet services compose inside the Wurst boundary');
