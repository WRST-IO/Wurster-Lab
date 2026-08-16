import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { autoUpdateEnabled, autoUpdateSupported, runStartupAutoUpdate } from '../runtime/desktop/src/update-runtime.mjs';


const root = path.resolve(import.meta.dirname, '..');
const desktopMain = await fs.readFile(path.join(root, 'runtime', 'desktop', 'src', 'main.mjs'), 'utf8');
const settingsHtml = await fs.readFile(path.join(root, 'runtime', 'desktop', 'src', 'settings.html'), 'utf8');
const launcherPreload = await fs.readFile(path.join(root, 'runtime', 'desktop', 'src', 'launcher-preload.cjs'), 'utf8');
const updateHtml = await fs.readFile(path.join(root, 'runtime', 'desktop', 'src', 'update.html'), 'utf8');
assert.match(desktopMain, /openLauncherWindow\(\{ show: false, loadHome: false \}\)/);
assert.match(desktopMain, /runAutomaticStartupUpdate/);
assert.match(settingsHtml, /id="autoUpdateToggle"/);
assert.match(launcherPreload, /wurster:settings:update:auto/);
assert.match(updateHtml, /Oink oink/);
assert.match(updateHtml, /wursterUpdate\?\.onState/);

class FakeUpdater extends EventEmitter {
  constructor(result = { isUpdateAvailable: true, updateInfo: { version: '0.33.2' }, cancellationToken: { id: 'token' } }) {
    super();
    this.result = result;
    this.downloaded = null;
    this.installed = false;
  }
  async checkForUpdates() { return this.result; }
  async downloadUpdate(token) {
    this.downloaded = token;
    this.emit('download-progress', { percent: 42.4, transferred: 424, total: 1000, bytesPerSecond: 50 });
    this.emit('download-progress', { percent: 100, transferred: 1000, total: 1000, bytesPerSecond: 80 });
    return ['/tmp/wurster-update'];
  }
  quitAndInstall() { this.installed = true; }
}

assert.equal(autoUpdateEnabled({}), true);
assert.equal(autoUpdateEnabled({ updates: {} }), true);
assert.equal(autoUpdateEnabled({ updates: { autoUpdate: false } }), false);
assert.equal(autoUpdateSupported({ isPackaged: true, platform: 'darwin' }), true);
assert.equal(autoUpdateSupported({ isPackaged: true, platform: 'win32' }), true);
assert.equal(autoUpdateSupported({ isPackaged: true, platform: 'linux' }), false);
assert.equal(autoUpdateSupported({ isPackaged: false, platform: 'darwin' }), false);

{
  let loads = 0;
  const result = await runStartupAutoUpdate({ isPackaged: true, platform: 'darwin', settings: { updates: { autoUpdate: false } }, loadUpdater: async () => { loads += 1; } });
  assert.equal(result.status, 'disabled');
  assert.equal(loads, 0);
}

{
  let loads = 0;
  const result = await runStartupAutoUpdate({ isPackaged: false, platform: 'darwin', settings: {}, loadUpdater: async () => { loads += 1; } });
  assert.equal(result.status, 'unsupported');
  assert.equal(loads, 0);
}

{
  const updater = new FakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '0.33.2' } });
  const states = [];
  const result = await runStartupAutoUpdate({ isPackaged: true, platform: 'win32', settings: {}, loadUpdater: async () => updater, onState: async (state) => states.push(state), settleDelayMs: 0 });
  assert.equal(result.status, 'current');
  assert.equal(updater.installed, false);
  assert.deepEqual(states, []);
}

{
  const updater = new FakeUpdater();
  const states = [];
  const result = await runStartupAutoUpdate({ isPackaged: true, platform: 'darwin', settings: {}, loadUpdater: async () => updater, onState: async (state) => states.push(state), settleDelayMs: 0 });
  assert.equal(result.status, 'installing');
  assert.equal(result.version, '0.33.2');
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallEvent, 'manual');
  assert.equal(updater.autoRunAppAfterInstall, true);
  assert.equal(updater.allowPrerelease, false);
  assert.deepEqual(updater.downloaded, { id: 'token' });
  assert.equal(updater.installed, true);
  assert.deepEqual(states.map((state) => state.phase), ['available', 'downloading', 'downloading', 'ready']);
  assert.equal(states[1].percent, 42.4);
}

{
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  const states = [];
  const result = await runStartupAutoUpdate({ isPackaged: true, platform: 'darwin', settings: {}, loadUpdater: async () => updater, onState: async (state) => states.push(state), settleDelayMs: 0 });
  assert.equal(result.status, 'error');
  assert.equal(states.at(-1).phase, 'error');
  assert.match(states.at(-1).message, /offline/);
}

console.log('✓ desktop startup auto-update defaults on, stays opt-out, reports progress and fails open');
