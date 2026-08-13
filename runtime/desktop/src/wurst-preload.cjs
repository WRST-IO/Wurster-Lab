const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const authSession = new Map();
const authResultListeners = new Set();
const interfaceHandlers = new Map();
let interfaceDeclaration = null;
let interfaceLoadError = null;
let interfaceReadyResolve;
const interfaceReady = new Promise((resolve) => { interfaceReadyResolve = resolve; });
let nextAuthId = 1;
let nextIdentityId = 1;
let authSyncScheduled = false;
let identitySyncScheduled = false;

function ensureAuthElementIds() {
  for (const el of document.querySelectorAll('wurster-auth')) {
    if (!el.dataset.wursterAuthId) el.dataset.wursterAuthId = `wa-${nextAuthId++}`;
  }
}

function authAnchorPayload() {
  ensureAuthElementIds();
  return [...document.querySelectorAll('wurster-auth')].map((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    return {
      id: el.dataset.wursterAuthId,
      type: String(el.getAttribute('type') || 'identity').toLowerCase(),
      purpose: String(el.getAttribute('purpose') || (String(el.getAttribute('type') || '').toLowerCase() === 'wurstkey' ? 'application' : 'identity')).toLowerCase(),
      target: String(el.getAttribute('target') || ''),
      session: String(el.getAttribute('session') || ''),
      visible,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height))
    };
  });
}

function ensureIdentityElementIds() {
  for (const el of document.querySelectorAll('wurst-identity')) {
    if (!el.dataset.wursterIdentityId) el.dataset.wursterIdentityId = `wi-${nextIdentityId++}`;
  }
}

function identityAnchorPayload() {
  ensureIdentityElementIds();
  return [...document.querySelectorAll('wurst-identity')].map((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    return {
      id: el.dataset.wursterIdentityId,
      visible,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height))
    };
  });
}

function syncAuthAnchors() {
  authSyncScheduled = false;
  try { ipcRenderer.send('wurst:auth:anchors', authAnchorPayload()); } catch {}
}

function scheduleAuthSync() {
  if (authSyncScheduled) return;
  authSyncScheduled = true;
  requestAnimationFrame(syncAuthAnchors);
}

function syncIdentityAnchors() {
  identitySyncScheduled = false;
  try { ipcRenderer.send('wurst:identity:anchors', identityAnchorPayload()); } catch {}
}

function scheduleIdentitySync() {
  if (identitySyncScheduled) return;
  identitySyncScheduled = true;
  requestAnimationFrame(syncIdentityAnchors);
}

function scheduleTrustedSurfaceSync() {
  scheduleAuthSync();
  scheduleIdentitySync();
}

function installAuthAnchors() {
  if (!document.head.querySelector('style[data-wurster-auth-style]')) {
    const style = document.createElement('style');
    style.dataset.wursterAuthStyle = '1';
    style.textContent = 'wurster-auth{display:block;min-height:72px;position:relative;contain:layout;}wurst-identity{display:inline-block;min-width:250px;min-height:58px;position:relative;contain:layout;vertical-align:middle;}';
    document.head.appendChild(style);
  }
  const observer = new MutationObserver(scheduleTrustedSurfaceSync);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['type', 'purpose', 'target', 'session', 'style', 'class', 'hidden'] });
  window.addEventListener('resize', scheduleTrustedSurfaceSync, { passive: true });
  window.addEventListener('scroll', scheduleTrustedSurfaceSync, { passive: true, capture: true });
  if (typeof ResizeObserver === 'function') {
    const resizeObserver = new ResizeObserver(scheduleTrustedSurfaceSync);
    resizeObserver.observe(document.documentElement);
  }
  scheduleTrustedSurfaceSync();
}

ipcRenderer.on('wurst:auth:result', (_event, payload = {}) => {
  const id = String(payload.id || '');
  if (!id) return;
  authSession.set(id, payload);
  const clean = payload.ok ? {
    ok: true,
    type: payload.type,
    purpose: payload.purpose,
    target: payload.target || null,
    identity: payload.identity || null
  } : {
    ok: false,
    type: payload.type,
    purpose: payload.purpose,
    target: payload.target || null,
    error: payload.error || 'Authentication failed'
  };
  for (const listener of authResultListeners) {
    try { listener(clean); } catch {}
  }
  // Keep DOM events as a convenience, but Wurst apps should prefer
  // wurst.auth.onResult(). Context-isolated callbacks are more reliable than
  // depending on a CustomEvent crossing isolated JavaScript worlds.
  const el = [...document.querySelectorAll('wurster-auth')].find((candidate) => candidate.dataset.wursterAuthId === id);
  if (!el) return;
  try {
    el.dispatchEvent(new CustomEvent(payload.ok ? 'wurster-auth-success' : 'wurster-auth-error', {
      bubbles: true,
      detail: payload.ok ? {
        type: payload.type,
        purpose: payload.purpose,
        target: payload.target || null,
        identity: payload.identity || null
      } : { error: payload.error || 'Authentication failed' }
    }));
  } catch {}
});

window.addEventListener('DOMContentLoaded', installAuthAnchors, { once: true });
window.addEventListener('DOMContentLoaded', () => { void loadWurstInterface(); }, { once: true });

contextBridge.exposeInMainWorld('WurstInterface', Object.freeze({ define: defineWurstInterface }));


function defineWurstInterface(definition = {}) {
  const actions = definition && typeof definition === 'object' ? definition.actions : null;
  if (!actions || typeof actions !== 'object') throw new Error('WurstInterface.define requires { actions }');
  for (const [name, handler] of Object.entries(actions)) {
    if (typeof handler !== 'function') throw new Error(`Wurst Interface action must be a function: ${name}`);
    if (interfaceDeclaration?.actions && !Object.hasOwn(interfaceDeclaration.actions, name)) {
      throw new Error(`Action is not declared in the Wurst manifest: ${name}`);
    }
    interfaceHandlers.set(name, handler);
  }
  return true;
}

async function loadWurstInterface() {
  try {
    interfaceDeclaration = await invoke('wurst:interface:describe');
    if (!interfaceDeclaration?.entry) return;
    const script = document.createElement('script');
    script.src = 'wurst://interface/entry.js';
    script.async = true;
    await new Promise((resolve, reject) => {
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error('Wurst Interface failed to load')), { once: true });
      document.head.appendChild(script);
    });
  } catch (error) {
    interfaceLoadError = error;
    console.error('[Wurster] Wurst Interface load failed:', error);
  } finally {
    interfaceReadyResolve();
  }
}

ipcRenderer.on('wurst:interface:invoke-request', async (_event, request = {}) => {
  const requestId = String(request.requestId || '');
  if (!requestId) return;
  try {
    await interfaceReady;
    if (interfaceLoadError) throw interfaceLoadError;
    const name = String(request.name || '');
    const handler = interfaceHandlers.get(name);
    if (!handler) throw new Error(`Wurst action is declared but not registered: ${name}`);
    const result = await handler(structuredClone(request.input ?? {}));
    ipcRenderer.send('wurst:interface:invoke-result', {
      requestId,
      ok: true,
      result: structuredClone(result == null ? null : result)
    });
  } catch (error) {
    ipcRenderer.send('wurst:interface:invoke-result', {
      requestId,
      ok: false,
      error: error?.message || String(error)
    });
  }
});

contextBridge.exposeInMainWorld('wurst', Object.freeze({
  info: () => invoke('wurst:info'),
  capabilities: Object.freeze({
    query: (name) => invoke('wurst:capabilities:query', String(name ?? '')),
    list: () => invoke('wurst:capabilities:list')
  }),
  auth: Object.freeze({
    status: (purpose = 'identity') => invoke('wurst:auth:status', String(purpose ?? 'identity')),
    onResult: (callback) => {
      if (typeof callback !== 'function') return false;
      authResultListeners.add(callback);
      return true;
    }
  }),
  interface: Object.freeze({
    ready: () => interfaceReady.then(() => Boolean(interfaceDeclaration)),
    describe: () => invoke('wurst:interface:describe'),
    invoke: (name, input = {}) => invoke('wurst:interface:invoke', String(name ?? ''), input),
    emit: (name, payload = null) => { ipcRenderer.send('wurst:interface:event', String(name ?? ''), payload); return true; }
  }),
  identity: Object.freeze({
    session: () => invoke('wurst:identity:session')
  }),
  window: Object.freeze({
    close: () => invoke('wurst:window:close'),
    minimize: () => invoke('wurst:window:minimize')
  }),
  snapshot: Object.freeze({
    export: () => invoke('wurst:snapshot:export')
  }),
  files: Object.freeze({
    open: (options = {}) => invoke('wurst:files:open', options),
    save: (options = {}, data) => {
      let bytes;
      if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (typeof data === 'string') bytes = new TextEncoder().encode(data);
      else throw new TypeError('wurst.files.save expects Uint8Array, ArrayBuffer or string');
      return invoke('wurst:files:save', options, bytes);
    }
  }),
  fs: Object.freeze({
    capabilities: () => invoke('wurst:fs:capabilities'),
    realms: () => invoke('wurst:fs:realms'),
    initialize: () => invoke('wurst:fs:initialize'),
    unlockRealm: (realmId) => invoke('wurst:fs:unlock-realm', String(realmId ?? '')),
    lockRealm: (realmId) => invoke('wurst:fs:lock-realm', String(realmId ?? '')),
    history: () => invoke('wurst:fs:history'),
    usage: () => invoke('wurst:fs:usage'),
    compact: () => invoke('wurst:fs:compact'),
    url: (path) => {
      const value = String(path ?? '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/^data\//, '');
      if (!value || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new TypeError('Invalid WurstFS media path');
      return `wurst://data/${value.split('/').map(encodeURIComponent).join('/')}`;
    },
    stat: (path) => invoke('wurst:fs:stat', path),
    list: (path = '/data') => invoke('wurst:fs:list', path),
    read: (path, options = {}) => invoke('wurst:fs:read', path, {
      offset: Number(options.offset ?? 0),
      length: options.length == null ? undefined : Number(options.length)
    }),
    write: async (path, data, options = {}) => {
      let bytes;
      if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (typeof data === 'string') bytes = new TextEncoder().encode(data);
      else throw new TypeError('wurst.fs.write expects Uint8Array, ArrayBuffer or string');
      const tx = await invoke('wurst:fs:begin-write', path, { mime: options.mime });
      try {
        const chunkSize = Number(tx.chunkSize) || (4 * 1024 * 1024);
        for (let offset = 0; offset < bytes.byteLength || (bytes.byteLength === 0 && offset === 0); offset += chunkSize) {
          const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
          await invoke('wurst:fs:write-chunk', tx.id, chunk);
          if (bytes.byteLength === 0) break;
        }
        return await invoke('wurst:fs:commit-write', tx.id);
      } catch (error) {
        await invoke('wurst:fs:abort-write', tx.id).catch(() => {});
        throw error;
      }
    },
    beginWrite: (path, options = {}) => invoke('wurst:fs:begin-write', path, { mime: options.mime }),
    writeChunk: (id, data) => {
      let bytes;
      if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (typeof data === 'string') bytes = new TextEncoder().encode(data);
      else throw new TypeError('wurst.fs.writeChunk expects Uint8Array, ArrayBuffer or string');
      return invoke('wurst:fs:write-chunk', id, bytes);
    },
    commitWrite: (id) => invoke('wurst:fs:commit-write', id),
    abortWrite: (id) => invoke('wurst:fs:abort-write', id),
    remove: (path, options = {}) => invoke('wurst:fs:remove', path, { recursive: Boolean(options.recursive) }),
    mkdir: (path, options = {}) => invoke('wurst:fs:mkdir', path, { recursive: options.recursive !== false }),
    rename: (from, to) => invoke('wurst:fs:rename', from, to)
  })
}));
