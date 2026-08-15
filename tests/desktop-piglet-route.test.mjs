import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { encodeWurst } from '../packages/format/src/index.js';
import { WursterWebSession } from '../runtime/web/src/wurster-web.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.MessageChannel) globalThis.MessageChannel = MessageChannel;
const desktopMain = await fs.readFile(new URL('../runtime/desktop/src/main.mjs', import.meta.url), 'utf8');
assert.match(desktopMain, /__wurster\/.*Service Worker control/);

Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: { origin: 'wurst://runtime', href: 'wurst://runtime/wurster-embed-host.html' }
});

const timeline = [];
const listeners = new Map();
const controller = {
  postMessage(message, ports = []) {
    timeline.push(`session:${message.sessionId}`);
    assert.equal(message.type, 'wurster-register-session');
    queueMicrotask(() => ports[0]?.postMessage({
      type: 'wurster-session-registered',
      sessionId: message.sessionId,
      ok: true
    }));
  }
};
const serviceWorker = {
  controller: null,
  ready: Promise.resolve({ active: controller }),
  async register(url, options) {
    timeline.push(`register:${url}:${options.scope}`);
    queueMicrotask(() => {
      this.controller = controller;
      for (const listener of listeners.get('controllerchange') || []) listener();
      timeline.push('controlled');
    });
    return { active: controller };
  },
  addEventListener(name, listener) {
    const set = listeners.get(name) || new Set();
    set.add(listener);
    listeners.set(name, set);
  },
  removeEventListener(name, listener) {
    listeners.get(name)?.delete(listener);
  }
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker } });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

let frameLoad;
const frame = {
  attributes: new Map(),
  style: {},
  contentWindow: {},
  setAttribute(name, value) { this.attributes.set(name, value); },
  addEventListener(name, listener) { if (name === 'load') frameLoad = listener; },
  set src(value) {
    this._src = value;
    timeline.push(`navigate:${value}`);
    queueMicrotask(() => frameLoad?.());
  },
  get src() { return this._src; }
};
globalThis.document = { createElement(tag) { assert.equal(tag, 'iframe'); return frame; } };

const manifest = {
  format: 'wurst/7',
  id: 'io.wrst.desktop-piglet-route',
  name: 'Desktop Piglet Route',
  version: '1.0.0',
  entry: 'index.html',
  application: { protection: 'public' },
  capabilities: []
};
const bytes = encodeWurst({
  manifest,
  files: [
    { path: 'index.html', scope: 'app', mime: 'text/html; charset=utf-8', data: Buffer.from('<!doctype html><h1 id="child">flappy-oink</h1><script src="./child.js"></script>') },
    { path: 'child.js', scope: 'app', mime: 'text/javascript; charset=utf-8', data: Buffer.from('globalThis.__childRendered = true;') }
  ]
});
const session = await WursterWebSession.open(new Blob([bytes]), { sessionId: 'desktop-child-session' });
const target = {
  child: null,
  replaceChildren(node) { this.child = node; timeline.push('mounted'); }
};

await session.mount(target);

assert.equal(target.child, frame);
assert.equal(frame.src, 'wurst://runtime/__wurster/desktop-child-session/app/index.html');
assert.ok(timeline.indexOf('controlled') < timeline.findIndex((item) => item.startsWith('session:')), 'Service Worker must control the runtime page before session registration');
assert.ok(timeline.findIndex((item) => item.startsWith('session:')) < timeline.findIndex((item) => item.startsWith('navigate:')), 'Virtual app navigation must wait for the Service Worker session acknowledgement');

const response = await session._serve({ scope: 'app', path: 'index.html', method: 'GET', range: null });
assert.equal(response.status, 200);
const html = new TextDecoder().decode(new Uint8Array(response.body));
assert.match(html, /flappy-oink/);
assert.match(html, /wurster/i, 'Mounted child HTML receives the Wurster bootstrap');

await session.fs.dispose();
console.log('✓ Desktop Piglet virtual app route waits for Service Worker control, registers its session and serves the child index.html');
