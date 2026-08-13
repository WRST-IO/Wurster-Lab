import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  encodeWurst,
  generateWurstKey,
  sealApplicationFiles
} from '../packages/format/src/index.js';
import { ProtectionCore } from '../runtime/desktop/src/protection-core.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-protection-worker-'));
const filePath = path.join(tmp, 'worker-test.wurst');
const wurstKey = generateWurstKey().wurstKey;
const manifest = {
  format: 'wurst/7', id: 'io.wrst.worker-test', name: 'Protection Worker Test', version: '0.20.0', entry: 'index.html', type: 'widget',
  application: { protection: 'partial' }, protection: { storedIdentity: true }, capabilities: {}, security: { signed: false }
};

const appSealed = sealApplicationFiles({ manifest, files: [
  { path: 'index.html', scope: 'app', data: Buffer.from('<h1>Worker</h1>') },
  { path: 'secret.js', scope: 'app', data: Buffer.from('42'), sealed: true }
], wurstKey });
await fs.writeFile(filePath, encodeWurst({ manifest: appSealed.manifest, files: appSealed.files }));

const client = new ProtectionCore();
try {
  const unlocked = await client.dispatch('unlock-application', { filePath, manifest: appSealed.manifest, wurstKey });
  const slice = await client.dispatch('read', { handle: unlocked.handle, path: 'secret.js', offset: 0, length: 2 });
  assert.equal(slice.data.toString(), '42');
  await assert.rejects(() => client.dispatch('read', { handle: 'not-a-handle', path: 'secret.js', offset: 0, length: 2 }), /Protection handle is not available/);
  await client.dispatch('destroy', { handle: unlocked.handle });
  await assert.rejects(() => client.dispatch('read', { handle: unlocked.handle, path: 'secret.js', offset: 0, length: 2 }), /Protection handle is not available/);
  console.log('✓ Protection core is application-only and keeps WurstKey material behind opaque handles');
} finally {
  await client.dispatch('shutdown');
  await fs.rm(tmp, { recursive: true, force: true });
}
