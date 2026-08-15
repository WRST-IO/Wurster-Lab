import assert from 'node:assert/strict';

class FakeClassList { toggle() {} }
class FakeNode {
  constructor(tag = '') {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.className = '';
    this.classList = new FakeClassList();
    this.hidden = false;
    this.innerHTML = '';
    this.contentWindow = { postMessage: (...args) => { this.posted = args; } };
  }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(name, listener) { if (name === 'load') queueMicrotask(listener); }
  remove() { this.removed = true; }
}
class FakeRoot { append(...nodes) { this.nodes ??= []; this.nodes.push(...nodes); } }
class FakeHTMLElement {
  constructor() { this.attrs = new Map(); this.isConnected = true; }
  attachShadow() { return new FakeRoot(); }
  setAttribute(name, value = '') { this.attrs.set(String(name), String(value)); }
  getAttribute(name) { return this.attrs.has(String(name)) ? this.attrs.get(String(name)) : null; }
  hasAttribute(name) { return this.attrs.has(String(name)); }
  dispatchEvent() { return true; }
}

const registry = new Map();
globalThis.HTMLElement = FakeHTMLElement;
globalThis.document = {
  baseURI: 'wurst://app/index.html',
  createElement: (tag) => new FakeNode(tag)
};
globalThis.window = { customElements: {
  get: (name) => registry.get(name),
  define: (name, value) => registry.set(name, value)
} };
globalThis.customElements = globalThis.window.customElements;
if (typeof globalThis.CustomEvent !== 'function') globalThis.CustomEvent = class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };

const { WurstEmbedElement } = await import('../runtime/web/src/wurster-embed.mjs');

function bridgeHarness({ subscriptionThrows = false } = {}) {
  const calls = [];
  const bridge = {
    async open(src, options) {
      calls.push(['open', src, options]);
      return {
        handle: 'attachment-1',
        size: 16,
        writable: false,
        descriptor: { ref: src },
        parent: { isolated: true, piglink: false, pigfs: null, piglets: null },
        composition: { level: 'ok' },
        session: { format: 'wurst/runtime-session-1', id: 'session-1', revision: 0 }
      };
    },
    async read() { return new Uint8Array(0); },
    subscribeSession(handle) {
      calls.push(['subscribeSession', handle]);
      if (subscriptionThrows) throw new Error('simulated bridge cache miss');
      return 'sub-1';
    },
    unsubscribeSession(id) { calls.push(['unsubscribeSession', id]); },
    async close(handle) { calls.push(['close', handle]); return true; }
  };
  return { bridge, calls };
}

{
  const { bridge, calls } = bridgeHarness();
  globalThis.wurstEmbedRuntime = bridge;
  const embed = new WurstEmbedElement();
  embed.setAttribute('isolated', '');
  await embed.load('builtin:flappywurst');

  assert.equal(embed.session?.id, 'session-1');
  assert.deepEqual(calls.slice(0, 2).map(([name]) => name), ['open', 'subscribeSession'],
    'a freshly opened provider must stay alive until session subscription is installed');
  assert.equal(calls.some(([name]) => name === 'close'), false,
    'starting a fresh embed must not close its own attachment');

  embed.disconnectedCallback();
  await Promise.resolve();
  assert.ok(calls.some(([name, handle]) => name === 'close' && handle === 'attachment-1'),
    'disconnect must still release the attachment');
}

{
  const { bridge, calls } = bridgeHarness({ subscriptionThrows: true });
  globalThis.wurstEmbedRuntime = bridge;
  const embed = new WurstEmbedElement();
  embed.setAttribute('isolated', '');

  await assert.doesNotReject(embed.load('builtin:flappywurst'),
    'isolated rendering must not fail just because session event subscription is unavailable');
  assert.equal(embed.session?.id, 'session-1');
  assert.ok(calls.some(([name]) => name === 'subscribeSession'));
  embed.disconnectedCallback();
}

console.log('✓ desktop <wurst-embed> keeps fresh attachments alive and treats session events as optional');
