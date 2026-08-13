const MODULE_URL = new URL(import.meta.url);
const HOST_URL = new URL('./wurster-embed-host.html', MODULE_URL);

function targetOrigin(url) { return new URL(url).origin; }
function toTransferBuffer(value) {
  const data = value instanceof Uint8Array ? value : new Uint8Array(value);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

class BlobProvider {
  constructor(blob) { this.blob = blob instanceof Blob ? blob : new Blob([blob]); this.size = this.blob.size; this.kind = 'blob'; }
  async read(position, length) { return new Uint8Array(await this.blob.slice(position, position + length).arrayBuffer()); }
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

async function providerFrom(input) {
  if (input instanceof Blob || input instanceof ArrayBuffer || input instanceof Uint8Array || ArrayBuffer.isView(input)) return new BlobProvider(input);
  if (typeof input === 'string' || input instanceof URL) return HttpProvider.open(input);
  throw new TypeError('<wurst-embed> expects src, File, Blob, ArrayBuffer or Uint8Array');
}

export class WurstEmbedElement extends HTMLElement {
  static observedAttributes = ['src', 'wurstkey'];
  constructor() {
    super();
    this._root = this.attachShadow({ mode: 'closed' });
    this._frame = null; this._port = null; this._provider = null; this._generation = 0;
    const style = document.createElement('style');
    style.textContent = ':host{display:block;position:relative;width:100%;height:420px;min-height:180px;contain:layout paint}iframe{width:100%;height:100%;border:0;display:block;background:transparent}.status{position:absolute;inset:0;z-index:2;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#fff8f6;color:#6d5961;font:600 13px system-ui;text-align:center}.status[hidden]{display:none}.pig{font-size:30px;display:block;margin-bottom:8px}.error{color:#a62f48}';
    this._status = document.createElement('div'); this._status.className = 'status';
    this._status.innerHTML = '<div><span class="pig">🐷</span>Warming the Wurster…</div>';
    this._root.append(style, this._status);
  }
  connectedCallback() { if (this.hasAttribute('src')) void this.load(this.getAttribute('src')); }
  attributeChangedCallback(name, oldValue, newValue) {
    if (!this.isConnected || oldValue === newValue) return;
    if (name === 'src' && newValue) void this.load(newValue);
    if (name === 'wurstkey' && this._provider) void this._start(this._provider);
  }
  async load(input) {
    const generation = ++this._generation;
    this._show('🐷', 'Opening Wurst…');
    try {
      const provider = await providerFrom(input);
      if (generation !== this._generation) return this;
      this._provider = provider;
      await this._start(provider, generation);
      return this;
    } catch (error) {
      if (generation === this._generation) this._fail(error);
      throw error;
    }
  }
  async open(input) { return this.load(input); }
  async _start(provider, generation = ++this._generation) {
    this._teardownFrame();
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
      if (m?.type === 'wurster-embed-ready') {
        this._status.hidden = true;
        this.dispatchEvent(new CustomEvent('wurst-ready', { detail: m.detail || {}, bubbles: true }));
      } else if (m?.type === 'wurster-embed-error') this._fail(new Error(m.error || 'Wurst failed to open'));
    });
    await new Promise((resolve, reject) => {
      frame.addEventListener('load', resolve, { once: true });
      frame.addEventListener('error', () => reject(new Error('Could not load the Wurster embed host')), { once: true });
    });
    if (generation !== this._generation) return;
    this._status.hidden = true;
    frame.contentWindow.postMessage({
      type: 'wurster-embed-init', size: provider.size, sourceKind: provider.kind,
      wurstKey: this.getAttribute('wurstkey') || null
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
  _teardownFrame() { this._port?.close?.(); this._port = null; this._frame?.remove(); this._frame = null; }
  disconnectedCallback() { this._generation += 1; this._teardownFrame(); }
}

export function registerWurstEmbed(tagName = 'wurst-embed') {
  if (!customElements.get(tagName)) customElements.define(tagName, WurstEmbedElement);
  return customElements.get(tagName);
}

if (typeof window !== 'undefined' && window.customElements) registerWurstEmbed();
