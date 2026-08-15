export class BlobWurstSource {
  constructor(blob) {
    this.blob = blob instanceof Blob ? blob : new Blob([blob]);
    this.size = this.blob.size;
    this.kind = 'blob';
  }
  async read(position, length) {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || position + length > this.size) throw new Error('Invalid Wurst byte range');
    return new Uint8Array(await this.blob.slice(position, position + length).arrayBuffer());
  }
}

export class MessagePortWurstSource {
  constructor(port, size, { kind = 'embed' } = {}) {
    if (!port?.postMessage) throw new TypeError('MessagePortWurstSource requires a MessagePort');
    if (!Number.isSafeInteger(Number(size)) || Number(size) < 0) throw new Error('Invalid embedded Wurst size');
    this.port = port;
    this.size = Number(size);
    this.kind = kind;
    this.seq = 1;
    this.pending = new Map();
    this._onMessage = (event) => {
      const message = event.data;
      if (message?.type !== 'wurster-source-result') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.ok ? pending.resolve(new Uint8Array(message.data)) : pending.reject(new Error(message.error || 'Embedded Wurst source failed'));
    };
    port.addEventListener?.('message', this._onMessage);
    port.start?.();
  }
  async read(position, length) {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || position + length > this.size) throw new Error('Invalid embedded Wurst byte range');
    if (length === 0) return new Uint8Array(0);
    const id = `r${this.seq++}`;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.port.postMessage({ type: 'wurster-source-read', id, position, length });
    return result;
  }
  resize(size) {
    const next = Number(size);
    if (!Number.isSafeInteger(next) || next < 0) throw new Error('Invalid embedded Wurst size');
    this.size = next;
    return this.size;
  }
  close() {
    this.port.removeEventListener?.('message', this._onMessage);
    for (const pending of this.pending.values()) pending.reject(new Error('Embedded Wurst source closed'));
    this.pending.clear();
  }
}

export class HttpWurstSource {
  static async open(url, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch() is required for HTTP Wursts');
    const target = new URL(String(url), globalThis.location?.href);
    const first = await fetchImpl(target, { headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' } });
    if (first.status !== 206) throw new Error('Remote server does not provide byte-range Wurst access');
    const match = String(first.headers.get('content-range') || '').match(/^bytes\s+0-0\/(\d+)$/i);
    if (!match) throw new Error('Remote server returned an invalid Wurst Content-Range');
    const size = Number(match[1]);
    const etag = first.headers.get('etag');
    const lastModified = first.headers.get('last-modified');
    await first.arrayBuffer();
    return new HttpWurstSource(target.toString(), size, { fetchImpl, etag: etag && !/^W\//i.test(etag) ? etag : null, lastModified });
  }
  constructor(url, size, { fetchImpl, etag, lastModified }) {
    this.url = url;
    this.size = size;
    this.fetchImpl = fetchImpl;
    this.etag = etag;
    this.lastModified = lastModified;
    this.kind = 'http';
  }
  async read(position, length) {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || position + length > this.size) throw new Error('Invalid remote Wurst range');
    if (length === 0) return new Uint8Array(0);
    const headers = { Range: `bytes=${position}-${position + length - 1}`, 'Accept-Encoding': 'identity' };
    if (this.etag) headers['If-Range'] = this.etag;
    else if (this.lastModified) headers['If-Range'] = this.lastModified;
    const response = await this.fetchImpl(this.url, { headers });
    if (response.status !== 206) throw new Error('Remote Wurst changed or stopped serving byte ranges');
    const got = String(response.headers.get('content-range') || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    if (!got || Number(got[1]) !== position || Number(got[2]) !== position + length - 1 || Number(got[3]) !== this.size) throw new Error('Remote Wurst range does not match the pinned representation');
    if (this.etag && response.headers.get('etag') && response.headers.get('etag') !== this.etag) throw new Error('Remote Wurst ETag changed while streaming');
    const out = new Uint8Array(await response.arrayBuffer());
    if (out.byteLength !== length) throw new Error('Remote Wurst range was truncated');
    return out;
  }
}

export async function sourceFrom(input) {
  if (typeof input === 'string' || input instanceof URL) return HttpWurstSource.open(input);
  if (input instanceof Blob || input instanceof ArrayBuffer || input instanceof Uint8Array || ArrayBuffer.isView(input)) return new BlobWurstSource(input);
  if (input?.read && Number.isSafeInteger(input.size)) return input;
  throw new TypeError('Wurster Web expects a Wurst URL, File, Blob, ArrayBuffer, Uint8Array or byte-range source');
}
