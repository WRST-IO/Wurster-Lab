const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const authSession = new Map();
const authResultListeners = new Set();
const piglinkHandlers = new Map();
let piglinkDeclaration = null;
let piglinkLoadError = null;
let piglinkReadyResolve;
const piglinkReady = new Promise((resolve) => { piglinkReadyResolve = resolve; });
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


function intersectRects(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function clippedElementGeometry(el, rect) {
  let visible = {
    left: Math.max(0, rect.left),
    top: Math.max(0, rect.top),
    right: Math.min(window.innerWidth, rect.right),
    bottom: Math.min(window.innerHeight, rect.bottom)
  };
  visible.width = Math.max(0, visible.right - visible.left);
  visible.height = Math.max(0, visible.bottom - visible.top);
  for (let node = el.parentElement; node && visible.width > 0 && visible.height > 0; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clipsX = /^(?:hidden|clip|auto|scroll)$/.test(style.overflowX);
    const clipsY = /^(?:hidden|clip|auto|scroll)$/.test(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const parent = node.getBoundingClientRect();
    const clip = {
      left: clipsX ? parent.left : -Infinity,
      right: clipsX ? parent.right : Infinity,
      top: clipsY ? parent.top : -Infinity,
      bottom: clipsY ? parent.bottom : Infinity
    };
    visible = intersectRects(visible, clip);
  }
  return {
    visible: visible.width > 0 && visible.height > 0,
    clipX: Math.max(0, Math.round(visible.left - rect.left)),
    clipY: Math.max(0, Math.round(visible.top - rect.top)),
    clipWidth: Math.max(0, Math.round(visible.width)),
    clipHeight: Math.max(0, Math.round(visible.height))
  };
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
    const clip = clippedElementGeometry(el, rect);
    const visible = rect.width > 8 && rect.height > 8 && clip.visible && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    return {
      id: el.dataset.wursterIdentityId,
      visible,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
      clipX: clip.clipX,
      clipY: clip.clipY,
      clipWidth: clip.clipWidth,
      clipHeight: clip.clipHeight
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
window.addEventListener('DOMContentLoaded', () => { void loadPigLink(); }, { once: true });

contextBridge.exposeInMainWorld('PigLink', Object.freeze({ define: definePigLink }));


function definePigLink(definition = {}) {
  const actions = definition && typeof definition === 'object' ? definition.actions : null;
  if (!actions || typeof actions !== 'object') throw new Error('PigLink.define requires { actions }');
  for (const [name, handler] of Object.entries(actions)) {
    if (typeof handler !== 'function') throw new Error(`PigLink action must be a function: ${name}`);
    if (piglinkDeclaration?.actions && !Object.hasOwn(piglinkDeclaration.actions, name)) {
      throw new Error(`Action is not declared in the Wurst manifest: ${name}`);
    }
    piglinkHandlers.set(name, handler);
  }
  return true;
}

async function loadPigLink() {
  try {
    piglinkDeclaration = await invoke('wurst:piglink:describe');
    if (!piglinkDeclaration?.entry) return;
    const script = document.createElement('script');
    script.src = 'wurst://piglink/entry.js';
    script.async = true;
    await new Promise((resolve, reject) => {
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error('PigLink failed to load')), { once: true });
      document.head.appendChild(script);
    });
  } catch (error) {
    piglinkLoadError = error;
    console.error('[Wurster] PigLink load failed:', error);
  } finally {
    piglinkReadyResolve();
  }
}

ipcRenderer.on('wurst:piglink:invoke-request', async (_event, request = {}) => {
  const requestId = String(request.requestId || '');
  if (!requestId) return;
  try {
    await piglinkReady;
    if (piglinkLoadError) throw piglinkLoadError;
    const name = String(request.name || '');
    const handler = piglinkHandlers.get(name);
    if (!handler) throw new Error(`Wurst action is declared but not registered: ${name}`);
    const result = await handler(structuredClone(request.input ?? {}));
    ipcRenderer.send('wurst:piglink:invoke-result', {
      requestId,
      ok: true,
      result: structuredClone(result == null ? null : result)
    });
  } catch (error) {
    ipcRenderer.send('wurst:piglink:invoke-result', {
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
  piglink: Object.freeze({
    ready: () => piglinkReady.then(() => Boolean(piglinkDeclaration)),
    describe: () => invoke('wurst:piglink:describe'),
    invoke: (name, input = {}) => invoke('wurst:piglink:invoke', String(name ?? ''), input),
    emit: (name, payload = null) => { ipcRenderer.send('wurst:piglink:event', String(name ?? ''), payload); return true; }
  }),
  piglet: Object.freeze({
    children: () => invoke('wurst:piglet:children'),
    url: (ref) => invoke('wurst:piglet:url', String(ref ?? '')),
    inspect: (ref) => invoke('wurst:piglet:inspect', String(ref ?? '')),
    install: async (name, data, options = {}) => {
      let bytes;
      if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else throw new TypeError('wurst.piglet.install expects Uint8Array or ArrayBuffer Wurst bytes');
      return invoke('wurst:piglet:install', String(name ?? 'Piglet.wurst'), bytes, options);
    },
    remove: (ref) => invoke('wurst:piglet:remove', String(ref ?? '')),
    open: (ref, options = {}) => invoke('wurst:piglet:open', String(ref ?? ''), options),
    surfaces: () => invoke('wurst:piglet:surfaces'),
    setBounds: (handle, bounds) => invoke('wurst:piglet:bounds', String(handle ?? ''), bounds),
    focus: (handle) => invoke('wurst:piglet:focus', String(handle ?? '')),
    close: (handle) => invoke('wurst:piglet:close', String(handle ?? ''))
  }),
  pigsty: Object.freeze({
    status: () => invoke('wurst:pigsty:status'),
    run: (request = {}) => invoke('wurst:pigsty:run', request),
    build: (name = 'default', request = {}) => invoke('wurst:pigsty:build', String(name ?? 'default'), request)
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
