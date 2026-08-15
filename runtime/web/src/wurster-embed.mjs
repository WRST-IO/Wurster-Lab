const MODULE_URL = new URL(import.meta.url);
const DESKTOP_APP_BOOTSTRAP = MODULE_URL.protocol === 'wurst:'
  && MODULE_URL.hostname === 'app'
  && MODULE_URL.pathname === '/__wurst/runtime/wurster-embed.mjs';
const HOST_URL = DESKTOP_APP_BOOTSTRAP
  ? new URL('wurst://runtime/wurster-embed-host.html')
  : new URL('./wurster-embed-host.html', MODULE_URL);

function targetOrigin(url) { return new URL(url).origin; }
function toTransferBuffer(value) {
  const data = value instanceof Uint8Array ? value : new Uint8Array(value);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

class BlobProvider {
  constructor(blob) { this.blob = blob instanceof Blob ? blob : new Blob([blob]); this.size = this.blob.size; this.kind = 'blob'; }
  async read(position, length) { return new Uint8Array(await this.blob.slice(position, position + length).arrayBuffer()); }
}


class RuntimeBridgeProvider {
  static async open(input, options = {}) {
    const bridge = globalThis.wurstEmbedRuntime;
    if (!bridge?.open || !bridge?.read) return null;
    const opened = await bridge.open(String(input), options);
    if (opened == null) return null;
    if (!opened?.handle || !Number.isSafeInteger(opened.size)) throw new Error('Wurster embed runtime returned an invalid source');
    return new RuntimeBridgeProvider(bridge, opened);
  }
  constructor(bridge, opened) {
    this.bridge = bridge;
    this.handle = opened.handle;
    this.size = opened.size;
    this.kind = 'runtime';
    this.writable = Boolean(opened.writable);
    this.descriptor = opened.descriptor || null;
    this.parent = opened.parent || null;
    this.composition = opened.composition || null;
    this.session = opened.session || null;
  }
  async read(position, length) {
    const result = await this.bridge.read(this.handle, position, length);
    return result instanceof Uint8Array ? result : new Uint8Array(result);
  }
  async persist(value) {
    if (!this.writable || !this.bridge.persist) throw new Error('This embedded Wurst is not writable');
    const result = await this.bridge.persist(this.handle, value);
    if (result?.session) this.session = result.session;
    return result;
  }
  async refresh() {
    if (!this.bridge.refresh) return { size: this.size, session: this.session };
    const result = await this.bridge.refresh(this.handle);
    if (Number.isSafeInteger(result?.size)) this.size = result.size;
    if (result?.session) this.session = result.session;
    return result;
  }
  async invokeParent(method, args = []) {
    if (!this.parent || !this.bridge.invoke) throw new Error('This embedded Wurst has no delegated parent runtime access');
    return this.bridge.invoke(this.handle, String(method ?? ''), args);
  }
  subscribeParentPigLink(listener) {
    if (!this.parent?.piglink || !this.bridge.subscribeParentPigLink) return null;
    const id = this.bridge.subscribeParentPigLink(this.handle, listener);
    return () => { try { this.bridge.unsubscribeParentPigLink?.(id); } catch {} };
  }
  subscribeSession(listener) {
    if (!this.session?.id || !this.bridge.subscribeSession) return null;
    try {
      const id = this.bridge.subscribeSession(this.handle, listener);
      if (!id) return null;
      return () => { try { this.bridge.unsubscribeSession?.(id); } catch {} };
    } catch {
      return null;
    }
  }
  async close() { try { await this.bridge.close?.(this.handle); } catch {} }
}

class HttpProvider {
  static async open(rawUrl) {
    const url = new URL(String(rawUrl), document.baseURI);
    const response = await fetch(url, { headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' } });
    if (response.status === 206) {
      const match = String(response.headers.get('content-range') || '').match(/^bytes\s+0-0\/(\d+)$/i);
      if (!match) throw new Error('Wurst server returned an invalid Content-Range');
      await response.arrayBuffer();
      return new HttpProvider(url, Number(match[1]), {
        etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified')
      });
    }
    if (!response.ok) throw new Error(`Could not load Wurst: HTTP ${response.status}`);
    return new BlobProvider(await response.blob());
  }
  constructor(url, size, { etag = null, lastModified = null } = {}) {
    this.url = url; this.size = size; this.kind = 'http';
    this.etag = etag && !/^W\//i.test(etag) ? etag : null;
    this.lastModified = lastModified || null;
  }
  async read(position, length) {
    if (length === 0) return new Uint8Array(0);
    const headers = { Range: `bytes=${position}-${position + length - 1}`, 'Accept-Encoding': 'identity' };
    if (this.etag) headers['If-Range'] = this.etag; else if (this.lastModified) headers['If-Range'] = this.lastModified;
    const response = await fetch(this.url, { headers });
    if (response.status !== 206) throw new Error('Remote Wurst changed or stopped serving byte ranges');
    const contentRange = String(response.headers.get('content-range') || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    if (!contentRange || Number(contentRange[1]) !== position || Number(contentRange[2]) !== position + length - 1 || Number(contentRange[3]) !== this.size) throw new Error('Remote Wurst range does not match its pinned representation');
    if (this.etag && response.headers.get('etag') && response.headers.get('etag') !== this.etag) throw new Error('Remote Wurst ETag changed while streaming');
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength !== length) throw new Error('Remote Wurst range was truncated');
    return data;
  }
}

async function providerFrom(input, options = {}) {
  if ((typeof input === 'string' || input instanceof URL) && globalThis.wurstEmbedRuntime?.open) {
    const runtime = await RuntimeBridgeProvider.open(input, options);
    if (runtime) return runtime;
  }
  if (input instanceof Blob || input instanceof ArrayBuffer || input instanceof Uint8Array || ArrayBuffer.isView(input)) return new BlobProvider(input);
  if (typeof input === 'string' || input instanceof URL) return HttpProvider.open(input);
  throw new TypeError('<wurst-embed> expects src, File, Blob, ArrayBuffer or Uint8Array');
}

export class WurstEmbedElement extends HTMLElement {
  static observedAttributes = ['src', 'wurstkey', 'parent-pigfs', 'parent-piglets', 'isolated'];
  constructor() {
    super();
    this._root = this.attachShadow({ mode: 'closed' });
    this._frame = null; this._port = null; this._provider = null; this._generation = 0; this._childSeq = 1; this._childPending = new Map(); this._pigLinkListeners = new Map(); this._unsubscribeParentPigLink = null; this._unsubscribeSession = null; this.ready = Promise.resolve(this);
    this.piglink = Object.freeze({
      describe: () => this._childCall('piglink.describe'),
      invoke: (name, input = {}) => this._childCall('piglink.invoke', [String(name ?? ''), input]),
      on: (name, listener) => {
        const eventName = String(name ?? '*');
        if (typeof listener !== 'function') throw new TypeError('PigLink event listener must be a function');
        const set = this._pigLinkListeners.get(eventName) || new Set(); set.add(listener); this._pigLinkListeners.set(eventName, set);
        return () => { set.delete(listener); if (!set.size) this._pigLinkListeners.delete(eventName); };
      }
    });
    const style = document.createElement('style');
    style.textContent = ':host{display:block;position:relative;width:100%;height:420px;min-height:180px;contain:layout paint}iframe{width:100%;height:100%;border:0;display:block;background:transparent}.status{position:absolute;inset:0;z-index:2;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#fff8f6;color:#6d5961;font:600 13px system-ui;text-align:center}.status[hidden]{display:none}.pig{font-size:30px;display:block;margin-bottom:8px}.error{color:#a62f48}';
    this._status = document.createElement('div'); this._status.className = 'status';
    this._status.innerHTML = '<div><span class="pig">🐷</span>Warming the Wurster…</div>';
    this._root.append(style, this._status);
  }
  get relationship() { return this._provider?.parent ? structuredClone(this._provider.parent) : null; }
  get authorityComposition() { return this._provider?.composition ? structuredClone(this._provider.composition) : null; }
  get descriptor() { return this._provider?.descriptor ? structuredClone(this._provider.descriptor) : null; }
  get session() { return this._provider?.session ? structuredClone(this._provider.session) : null; }
  connectedCallback() { if (this.hasAttribute('src')) void this.load(this.getAttribute('src')); }
  attributeChangedCallback(name, oldValue, newValue) {
    if (!this.isConnected || oldValue === newValue) return;
    if (name === 'src' && newValue) void this.load(newValue);
    if ((name === 'wurstkey' || name === 'parent-pigfs' || name === 'parent-piglets' || name === 'isolated') && this._provider) void this.load(this.getAttribute('src'));
  }
  async load(input) {
    const generation = ++this._generation;
    let resolveReady, rejectReady;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this._show('🐷', 'Opening Wurst…');
    try {
      const embedOptions = this._embedOptions();
      const provider = await providerFrom(input, embedOptions);
      if ((embedOptions.parent.pigfs || embedOptions.parent.piglets) && provider.kind !== 'runtime') {
        await provider.close?.();
        throw new Error('Parent Wurst delegation requires <wurst-embed> to run inside a Wurst runtime');
      }
      if (generation !== this._generation) {
        await provider.close?.();
        return this;
      }
      this._teardownFrame();
      this._provider = provider;
      await this._start(provider, generation);
      resolveReady?.(this);
      return this;
    } catch (error) {
      if (generation === this._generation) {
        this._teardownFrame();
        this._fail(error);
      }
      rejectReady?.(error);
      throw error;
    }
  }
  _embedOptions() {
    const pigfs = String(this.getAttribute('parent-pigfs') || '').trim().toLowerCase();
    const piglets = String(this.getAttribute('parent-piglets') || '').trim().toLowerCase();
    const isolated = this.hasAttribute('isolated');
    if (pigfs && !['read', 'read-write'].includes(pigfs)) throw new TypeError('parent-pigfs must be "read" or "read-write"');
    if (piglets && !['read', 'manage'].includes(piglets)) throw new TypeError('parent-piglets must be "read" or "manage"');
    if (isolated && (pigfs || piglets)) throw new TypeError('isolated cannot be combined with parent-pigfs or parent-piglets');
    return { parent: { isolated, pigfs: pigfs || null, piglets: piglets || null } };
  }
  _childCall(method, args = []) {
    if (this._provider?.parent?.isolated) return Promise.reject(new Error('PigLink is disabled for an isolated Wurst embed'));
    if (!this._port) return Promise.reject(new Error('Embedded Wurst is not ready'));
    const id = `child-${this._childSeq++}`;
    const result = new Promise((resolve, reject) => this._childPending.set(id, { resolve, reject }));
    this._port.postMessage({ type: 'wurster-embed-child-call', id, method, args });
    return result;
  }
  async open(input) { return this.load(input); }
  async _start(provider, generation = ++this._generation) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-top-navigation-by-user-activation');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = this.getAttribute('title') || 'Embedded Wurst';
    frame.src = HOST_URL.toString();
    this._frame = frame; this._root.append(frame);
    const channel = new MessageChannel(); this._port = channel.port1;
    const port = channel.port1; port.start?.();
    port.addEventListener('message', async (event) => {
      const m = event.data;
      if (m?.type === 'wurster-source-read') {
        try {
          const data = await provider.read(Number(m.position), Number(m.length));
          const buffer = toTransferBuffer(data);
          port.postMessage({ type: 'wurster-source-result', id: m.id, ok: true, data: buffer }, [buffer]);
        } catch (error) { port.postMessage({ type: 'wurster-source-result', id: m.id, ok: false, error: error?.message || String(error) }); }
        return;
      }
      if (m?.type === 'wurster-embed-persist') {
        try {
          if (!provider.persist) throw new Error('This embed source cannot persist PigFS mutations');
          const result = await provider.persist(new Uint8Array(m.data));
          port.postMessage({ type: 'wurster-embed-persist-result', id: m.id, ok: true, result });
        } catch (error) {
          port.postMessage({ type: 'wurster-embed-persist-result', id: m.id, ok: false, error: error?.message || String(error) });
        }
        return;
      }
      if (m?.type === 'wurster-embed-parent-call') {
        try {
          if (!provider.invokeParent) throw new Error('Parent runtime access is unavailable');
          const result = await provider.invokeParent(m.method, Array.isArray(m.args) ? m.args : []);
          port.postMessage({ type: 'wurster-embed-parent-result', id: m.id, ok: true, result });
        } catch (error) {
          port.postMessage({ type: 'wurster-embed-parent-result', id: m.id, ok: false, error: error?.message || String(error) });
        }
        return;
      }
      if (m?.type === 'wurster-embed-child-result') {
        const pending = this._childPending.get(String(m.id || ''));
        if (!pending) return;
        this._childPending.delete(String(m.id || ''));
        m.ok ? pending.resolve(m.result) : pending.reject(new Error(m.error || 'Embedded PigLink call failed'));
        return;
      }
      if (m?.type === 'wurster-embed-child-event') {
        if (provider.parent?.isolated) return;
        const name = String(m.name || ''), payload = structuredClone(m.payload ?? null);
        for (const key of [name, '*']) for (const listener of this._pigLinkListeners.get(key) || []) {
          try { listener(payload, name); } catch {}
        }
        this.dispatchEvent(new CustomEvent('wurst-piglink-event', {
          detail: { name, payload }, bubbles: true, composed: true
        }));
        return;
      }
      if (m?.type === 'wurster-embed-session-refreshed') {
        try { await provider.refresh?.(); } catch {}
        return;
      }
      if (m?.type === 'wurster-embed-session-refresh-failed') {
        this.dispatchEvent(new CustomEvent('wurst-session-conflict', {
          detail: { error: m.error || 'Wurst view could not rebase', code: m.code || 'WURST_SESSION_CONFLICT', session: provider.session || null },
          bubbles: true, composed: true
        }));
        return;
      }
      if (m?.type === 'wurster-embed-ready') {
        this._status.hidden = true;
        const detail = { ...(m.detail || {}), relationship: provider.parent || null, composition: provider.composition || null, session: provider.session || null };
        this.dispatchEvent(new CustomEvent('wurst-ready', { detail, bubbles: true }));
        if (provider.composition?.level === 'notice') this.dispatchEvent(new CustomEvent('wurst-authority-composition', { detail: provider.composition, bubbles: true, composed: true }));
      } else if (m?.type === 'wurster-embed-error') this._fail(new Error(m.error || 'Wurst failed to open'));
    });
    await new Promise((resolve, reject) => {
      frame.addEventListener('load', resolve, { once: true });
      frame.addEventListener('error', () => reject(new Error('Could not load the Wurster embed host')), { once: true });
    });
    if (generation !== this._generation) return;
    this._status.hidden = true;
    this._unsubscribeParentPigLink?.();
    this._unsubscribeParentPigLink = provider.subscribeParentPigLink?.((name, payload) => {
      try { port.postMessage({ type: 'wurster-embed-parent-piglink-event', name: String(name ?? ''), payload: structuredClone(payload ?? null) }); } catch {}
    }) || null;
    this._unsubscribeSession?.();
    this._unsubscribeSession = provider.subscribeSession?.((detail) => {
      if (String(detail?.writer ?? '') === String(provider.handle ?? '')) return;
      const session = detail?.session ? structuredClone(detail.session) : null;
      try { port.postMessage({ type: 'wurster-embed-session-changed', size: Number(detail?.size ?? provider.size), session }); } catch {}
      this.dispatchEvent(new CustomEvent('wurst-session-changed', { detail: { session }, bubbles: true, composed: true }));
    }) || null;
    frame.contentWindow.postMessage({
      type: 'wurster-embed-init', size: provider.size, sourceKind: provider.kind,
      wurstKey: this.getAttribute('wurstkey') || null,
      persistent: Boolean(provider.persist && provider.writable),
      parent: provider.parent || null,
      session: provider.session || null
    }, targetOrigin(HOST_URL), [channel.port2]);
  }
  _show(icon, text, error = false) {
    this._status.hidden = false; this._status.classList.toggle('error', error);
    this._status.innerHTML = `<div><span class="pig">${icon}</span>${text}</div>`;
  }
  _fail(error) {
    this._show('🌭', error?.message || String(error), true);
    this.dispatchEvent(new CustomEvent('wurst-error', { detail: { error: error?.message || String(error) }, bubbles: true }));
  }
  _teardownFrame() {
    const provider = this._provider;
    this._provider = null;
    for (const pending of this._childPending.values()) pending.reject(new Error('Embedded Wurst closed'));
    this._childPending.clear();
    this._unsubscribeParentPigLink?.(); this._unsubscribeParentPigLink = null;
    this._unsubscribeSession?.(); this._unsubscribeSession = null;
    this._port?.close?.(); this._port = null; this._frame?.remove(); this._frame = null; void provider?.close?.();
  }
  disconnectedCallback() { this._generation += 1; this._teardownFrame(); }
}

export function registerWurstEmbed(tagName = 'wurst-embed') {
  if (!customElements.get(tagName)) customElements.define(tagName, WurstEmbedElement);
  return customElements.get(tagName);
}

if (typeof window !== 'undefined' && window.customElements) registerWurstEmbed();
