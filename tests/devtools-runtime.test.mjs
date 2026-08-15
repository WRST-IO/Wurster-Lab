import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDesktopDevToolsRuntime, isWurstDevToolsShortcut } from '../runtime/desktop/src/devtools-runtime.mjs';

let nextWindowId = 1;

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.id = nextWindowId++;
    this.options = options;
    this.webContents = new EventEmitter();
    this.webContents.id = 1000 + this.id;
    this.destroyed = false;
    this.shown = false;
    this.focused = false;
    this.centered = false;
    FakeWindow.instances.push(this);
  }
  isDestroyed() { return this.destroyed; }
  show() { this.shown = true; }
  focus() { this.focused = true; }
  center() { this.centered = true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  requestClose() { this.emit('close'); this.destroy(); }
}
FakeWindow.instances = [];

class FakeTarget extends EventEmitter {
  constructor(id, { openEvent = true } = {}) {
    super();
    this.id = id;
    this.destroyed = false;
    this.opened = false;
    this.openEvent = openEvent;
    this.devToolsWebContents = null;
    this.openCalls = 0;
    this.closeCalls = 0;
    this.openOptions = null;
  }
  isDestroyed() { return this.destroyed; }
  isDevToolsOpened() { return this.opened; }
  setDevToolsWebContents(value) { this.devToolsWebContents = value; }
  openDevTools(options) {
    this.openCalls += 1;
    this.openOptions = options;
    this.opened = true;
    if (this.openEvent) queueMicrotask(() => this.emit('devtools-opened'));
  }
  closeDevTools() {
    this.closeCalls += 1;
    if (!this.opened) return;
    this.opened = false;
    queueMicrotask(() => this.emit('devtools-closed'));
  }
  destroyTarget() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

function freshRuntime(options = {}) {
  FakeWindow.instances.length = 0;
  nextWindowId = 1;
  return createDesktopDevToolsRuntime({ BrowserWindow: FakeWindow, timeoutMs: 30, ...options });
}


test('recognizes runtime-owned DevTools shortcuts before renderer key handling', () => {
  assert.equal(isWurstDevToolsShortcut({ type: 'keyDown', key: 'i', meta: true, alt: true, control: false, shift: false }, 'darwin'), true);
  assert.equal(isWurstDevToolsShortcut({ type: 'keyDown', key: 'I', control: true, shift: true, meta: false, alt: false }, 'win32'), true);
  assert.equal(isWurstDevToolsShortcut({ type: 'keyDown', key: 'i', control: true, shift: true, meta: false, alt: false }, 'linux'), true);
  assert.equal(isWurstDevToolsShortcut({ type: 'keyUp', key: 'i', meta: true, alt: true }, 'darwin'), false);
  assert.equal(isWurstDevToolsShortcut({ type: 'keyDown', key: 'i', meta: true, alt: true, isAutoRepeat: true }, 'darwin'), false);
  assert.equal(isWurstDevToolsShortcut({ type: 'keyDown', key: 'i', meta: true, alt: true, shift: true }, 'darwin'), false);
});

test('opens DevTools in an explicitly owned visible BrowserWindow', async () => {
  const runtime = freshRuntime();
  const target = new FakeTarget(7);
  const state = await runtime.open(target, { title: 'TexturePacker Developer Tools' });
  const win = FakeWindow.instances[0];
  assert.equal(target.devToolsWebContents, win.webContents);
  assert.equal(target.openCalls, 1);
  assert.deepEqual(target.openOptions, { mode: 'detach', activate: false, title: 'TexturePacker Developer Tools' });
  assert.equal(win.options.show, false);
  assert.equal(win.options.title, 'TexturePacker Developer Tools');
  assert.equal(win.centered, true);
  assert.equal(win.shown, true);
  assert.equal(win.focused, true);
  assert.deepEqual(state, { targetId: 7, windowId: 1, opening: false });
});

test('replaces invisible Electron-managed ghost DevTools instead of toggling them closed', async () => {
  const runtime = freshRuntime();
  const target = new FakeTarget(11);
  target.opened = true;
  await runtime.open(target);
  assert.equal(target.closeCalls, 1);
  assert.equal(target.openCalls, 1);
  assert.equal(FakeWindow.instances[0].shown, true);
});

test('toggle closes only the DevTools window owned for that target', async () => {
  const runtime = freshRuntime();
  const target = new FakeTarget(13);
  await runtime.toggle(target);
  const win = FakeWindow.instances[0];
  assert.ok(runtime.state());
  const closed = await runtime.toggle(target);
  assert.equal(closed, null);
  assert.equal(runtime.state(), null);
  assert.equal(target.opened, false);
  assert.equal(win.destroyed, true);
});

test('DevTools shortcut also closes the owned inspector while the inspector itself is focused', async () => {
  const runtime = freshRuntime();
  const target = new FakeTarget(15);
  await runtime.open(target);
  const win = FakeWindow.instances[0];
  let prevented = false;
  win.webContents.emit('before-input-event', { preventDefault() { prevented = true; } }, {
    type: 'keyDown', key: 'i', meta: process.platform === 'darwin', alt: process.platform === 'darwin',
    control: process.platform !== 'darwin', shift: process.platform !== 'darwin'
  });
  assert.equal(prevented, true);
  assert.equal(runtime.state(), null);
  assert.equal(target.opened, false);
});

test('closing the DevTools BrowserWindow closes the inspected target DevTools', async () => {
  const runtime = freshRuntime();
  const target = new FakeTarget(17);
  await runtime.open(target);
  FakeWindow.instances[0].requestClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.state(), null);
  assert.equal(target.opened, false);
});

test('destroying the inspected Wurst renderer destroys its DevTools host', async () => {
  const runtime = freshRuntime();
  const target = new FakeTarget(19);
  await runtime.open(target);
  const win = FakeWindow.instances[0];
  target.destroyTarget();
  assert.equal(runtime.state(), null);
  assert.equal(win.destroyed, true);
});

test('switching inspected Wursts tears down the previous owned DevTools window', async () => {
  const runtime = freshRuntime();
  const first = new FakeTarget(23);
  const second = new FakeTarget(29);
  await runtime.open(first);
  const firstWindow = FakeWindow.instances[0];
  await runtime.open(second);
  assert.equal(firstWindow.destroyed, true);
  assert.equal(first.opened, false);
  assert.equal(runtime.state().targetId, 29);
});

test('failed DevTools open is visible to callers and leaves no zombie host', async () => {
  const runtime = freshRuntime();
  const target = new FakeTarget(31, { openEvent: false });
  await assert.rejects(runtime.open(target), /Could not open Wurst Developer Tools: Timed out waiting for devtools-opened/);
  assert.equal(runtime.state(), null);
  assert.equal(FakeWindow.instances[0].destroyed, true);
  assert.equal(target.opened, false);
});
