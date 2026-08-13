import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { dataFsPath } from '../runtime/desktop/src/wurst-fs-paths.mjs';
import {
  createWursterIdentityRecord,
  decodeWursterIdentityString,
  encodeWurst,
  encodeWursterIdentityString,
  generateMeatphrase,
  verifyWursterIdentityRecord
} from '../packages/format/src/index.js';


assert.equal(dataFsPath('/data/operator/root.json'), 'data/operator/root.json');
assert.equal(dataFsPath('operator/root.json'), 'data/operator/root.json');
assert.equal(dataFsPath('/operator/root.json'), 'data/operator/root.json');
assert.equal(dataFsPath('/data'), 'data');
assert.equal(dataFsPath('/'), 'data');
assert.throws(() => dataFsPath('/data/operator/../root.json'), /Unsafe WurstFS path/);

const preload = await fs.readFile(new URL('../runtime/desktop/src/wurst-preload.cjs', import.meta.url), 'utf8');
const main = await fs.readFile(new URL('../runtime/desktop/src/main.mjs', import.meta.url), 'utf8');
const settings = await fs.readFile(new URL('../runtime/desktop/src/settings.html', import.meta.url), 'utf8');

for (const method of ['realms', 'initialize', 'unlockRealm', 'lockRealm', 'history']) {
  assert.match(preload, new RegExp(`\\b${method}:`), `desktop Wurst API must expose fs.${method}()`);
}
assert.doesNotMatch(preload, /wurst:fs:grant|wurst:fs:revoke|wurst:fs:rekey/, 'realm sharing/admin mutations must not be a silent renderer API');
assert.match(main, /purpose === 'realm'/);
assert.match(main, /filesystem-identity/);
assert.match(main, /rootAdmins: actor \? \[actor\.publicRecord\.identityId\] : \[]/);
assert.match(settings, /Save \.wurstid/);

const phrase = generateMeatphrase(12).meatphrase;
const publicIdentity = createWursterIdentityRecord(phrase, { name: 'Offline Pig', emoji: '🐷' });
const portable = encodeWursterIdentityString(publicIdentity);
const recovered = decodeWursterIdentityString(portable);
assert.equal(recovered.identityId, publicIdentity.identityId);
assert.equal(verifyWursterIdentityRecord(recovered).valid, true);

// A signed app may declare its realm topology, but sealed initial realms are
// intentionally owner-only. Sharing is an explicit trusted-runtime operation.
assert.doesNotThrow(() => encodeWurst({
  manifest: {
    format: 'wurst/7', id: 'io.wrst.realm-contract', name: 'Realm Contract', version: '0.20.0', entry: 'index.html', type: 'widget',
    application: { protection: 'public' }, protection: { storedIdentity: true }, capabilities: {},
    data: {
      format: 'wurst/data-realms-1', writable: true,
      realms: [
        { id: 'workspace', label: 'Workspace' },
        { id: 'private', label: 'Private', governance: 'personal' }
      ]
    },
    security: { signed: false }
  },
  files: [{ path: 'index.html', data: Buffer.from('<h1>realm contract</h1>'), scope: 'app', mime: 'text/html' }]
}));

assert.throws(() => encodeWurst({
  manifest: {
    format: 'wurst/7', id: 'io.wrst.bad-realm-contract', name: 'Bad Realm Contract', version: '0.20.0', entry: 'index.html', type: 'widget',
    application: { protection: 'public' }, capabilities: {},
    data: { format: 'wurst/data-realms-1', writable: true, realms: [{ id: 'private', governance: 'personal', protection: 'public', read: 'public', write: 'owner' }] },
    security: { signed: false }
  },
  files: [{ path: 'index.html', data: Buffer.from('<h1>bad</h1>'), scope: 'app', mime: 'text/html' }]
}), /sealed owner-only/);

console.log('✓ Desktop WurstFS path normalization maps renderer paths into the /data namespace safely');
console.log('✓ Desktop runtime exposes WurstFS realm identity/unlock primitives without silent renderer-side sharing authority');
console.log('✓ .wurstid public identities are portable, self-verifying and safe to exchange before a Wurst is opened');
console.log('✓ Signed manifests can declare ordinary and personal sealed realms without enabling multi-user history');
