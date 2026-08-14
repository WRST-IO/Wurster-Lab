import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopPigLinkRuntime, loadPigLinkEntry } from '../runtime/desktop/src/piglink-runtime.mjs';
import { loadPigletResource, registerDesktopPigletRuntime } from '../runtime/desktop/src/piglet-runtime.mjs';
import { createDesktopPigstyRuntime } from '../runtime/desktop/src/pigsty-runtime.mjs';

class MockIpc {
  handles = new Map();
  listeners = new Map();
  handle(name, fn) { this.handles.set(name, fn); }
  on(name, fn) { this.listeners.set(name, fn); }
}

const pigletBytes = Buffer.from('child-wurst-bytes');
const { createHash } = await import('node:crypto');
const childDigest = createHash('sha256').update(pigletBytes).digest('hex');
const pigLinkBytes = Buffer.from('PigLink.define({ actions: {} });');
const context = {
  manifest: {
    piglet: {
      children: [{ id: 'child', entry: '__wurst/piglet/child.wurst', sha256: childDigest }]
    },
    piglink: {
      entry: '__wurst/piglink/entry.js',
      actions: {
        echo: {
          timeoutMs: 1000,
          input: { type: 'object' },
          output: { type: 'object' }
        }
      },
      events: {}
    },
    pigsty: {
      format: 'wurst/pigsty-1',
      version: 'node-lts-1',
      builds: { site: { source: 'build.js', outputs: ['dist'] } }
    }
  },
  reader: {
    entry(name) {
      if (name === '__wurst/piglet/child.wurst') return { scope: 'piglet', encryption: null };
      if (name === '__wurst/piglink/entry.js') return { scope: 'piglink', encryption: null };
      return null;
    },
    async read(name) {
      if (name === '__wurst/piglet/child.wurst') return { data: pigletBytes };
      if (name === '__wurst/piglink/entry.js') return { data: pigLinkBytes };
      return null;
    },
    entries() { return []; }
  }
};

const assertWurstSender = () => context;

const pigletIpc = new MockIpc();
registerDesktopPigletRuntime({ ipcMain: pigletIpc, assertWurstSender });
assert.deepEqual((await pigletIpc.handles.get('wurst:piglet:children')({})).map((item) => item.id), ['child']);
assert.equal(await pigletIpc.handles.get('wurst:piglet:url')({}, 'child'), 'wurst://piglet/child.wurst');
assert.deepEqual((await loadPigletResource(context, 'child')).data, pigletBytes);

const pigLinkIpc = new MockIpc();
let sent = null;
const window = {
  isDestroyed: () => false,
  webContents: { send: (channel, message) => { sent = { channel, message }; } }
};
const pigLinkRuntime = createDesktopPigLinkRuntime({
  ipcMain: pigLinkIpc,
  assertWurstSender,
  getWindow: () => window,
  isCurrentContext: (candidate) => candidate === context
});
assert.deepEqual(await loadPigLinkEntry(context, 'entry.js'), pigLinkBytes);
const invocation = pigLinkRuntime.invoke(context, 'echo', { value: 42 });
assert.equal(sent.channel, 'wurst:piglink:invoke-request');
pigLinkIpc.listeners.get('wurst:piglink:invoke-result')({}, {
  requestId: sent.message.requestId,
  ok: true,
  result: { value: 42 }
});
assert.deepEqual(await invocation, { value: 42 });

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-desktop-pig-runtime-'));
const savedEnv = {
  WURSTER_PIGSTY_DEV: process.env.WURSTER_PIGSTY_DEV,
  WURSTER_PIGSTY_ENGINE: process.env.WURSTER_PIGSTY_ENGINE,
  WURSTER_EDGE_RUNTIME_DIR: process.env.WURSTER_EDGE_RUNTIME_DIR
};
try {
  delete process.env.WURSTER_PIGSTY_DEV;
  delete process.env.WURSTER_PIGSTY_ENGINE;
  delete process.env.WURSTER_EDGE_RUNTIME_DIR;
  const pigstyIpc = new MockIpc();
  const app = { getAppPath: () => temp, getPath: () => temp };
  const pigstyRuntime = createDesktopPigstyRuntime({ app, ipcMain: pigstyIpc, assertWurstSender });
  const status = await pigstyRuntime.status(context);
  assert.equal(status.declared, true);
  assert.equal(status.state, 'coming-soon');
  assert.equal(status.defaultEngine, null);
  assert.equal(status.engines.worker.available, false);

  process.env.WURSTER_PIGSTY_DEV = '1';
  const devStatus = await pigstyRuntime.status(context);
  assert.equal(devStatus.state, 'available');
  assert.equal(devStatus.defaultEngine, 'worker');
  assert.equal(devStatus.engines.worker.developmentOnly, true);
} finally {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(temp, { recursive: true, force: true });
}

console.log('✓ Desktop Piglet/PigLink/Pigsty modules keep feature ownership out of main and report Pigsty coming-soon by default');
