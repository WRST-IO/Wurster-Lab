const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const authSession = new Map();
const authResultListeners = new Set();
const piglinkHandlers = new Map();
const embedRelationships = new Map();
const embedSessions = new Map();
const embedParentPigLinkSubscriptions = new Map();
const embedSessionSubscriptions = new Map();
const machineClients = new Map();
let nextEmbedSubscriptionId = 1;
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


function normalizeEmbedSource(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new TypeError('<wurst-embed> requires a src');
  if (value.startsWith('builtin:') || value.startsWith('pigfs:') || value.startsWith('wurst://')) return value;
  if (value.startsWith('/')) return `pigfs:${value}`;
  return new URL(value, document.baseURI).href;
}

function installWurstEmbedElement() {
  if (customElements.get('wurst-embed')) return;
  const script = document.createElement('script');
  script.type = 'module';
  script.src = 'wurst://runtime/wurster-embed.mjs';
  script.dataset.wursterEmbedRuntime = '1';
  document.head.appendChild(script);
}

contextBridge.exposeInMainWorld('wurstEmbedRuntime', Object.freeze({
  open: async (src, options = {}) => {
    const opened = await invoke('wurst:piglet:embed-open', normalizeEmbedSource(src), options);
    if (opened?.handle) {
      const key = String(opened.handle);
      embedRelationships.set(key, structuredClone(opened.parent ?? null));
      embedSessions.set(key, structuredClone(opened.session ?? null));
    }
    return opened;
  },
  read: (handle, offset, length) => invoke('wurst:piglet:embed-read', String(handle ?? ''), Number(offset), Number(length)),
  persist: (handle, data) => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return invoke('wurst:piglet:embed-persist', String(handle ?? ''), bytes);
  },
  refresh: async (handle) => {
    const key = String(handle ?? '');
    const refreshed = await invoke('wurst:piglet:embed-refresh', key);
    if (refreshed?.session) embedSessions.set(key, structuredClone(refreshed.session));
    return refreshed;
  },
  invoke: (handle, method, args = []) => invoke('wurst:piglet:embed-invoke', String(handle ?? ''), String(method ?? ''), Array.isArray(args) ? args : []),
  subscribeParentPigLink: (handle, callback) => {
    const key = String(handle ?? '');
    if (typeof callback !== 'function') throw new TypeError('Parent PigLink event subscriber must be a function');
    if (!embedRelationships.get(key)?.piglink) throw new Error('Parent PigLink is unavailable to this Piglet');
    const id = `epl-${nextEmbedSubscriptionId++}`;
    embedParentPigLinkSubscriptions.set(id, { handle: key, callback });
    return id;
  },
  unsubscribeParentPigLink: (subscriptionId) => embedParentPigLinkSubscriptions.delete(String(subscriptionId ?? '')),
  subscribeSession: (handle, callback) => {
    const key = String(handle ?? '');
    if (typeof callback !== 'function') throw new TypeError('Wurst session subscriber must be a function');
    if (!embedSessions.get(key)?.id) throw new Error('Wurst session is unavailable');
    const id = `ews-${nextEmbedSubscriptionId++}`;
    embedSessionSubscriptions.set(id, { handle: key, callback });
    return id;
  },
  unsubscribeSession: (subscriptionId) => embedSessionSubscriptions.delete(String(subscriptionId ?? '')),
  close: async (handle) => {
    const key = String(handle ?? '');
    for (const [id, sub] of embedParentPigLinkSubscriptions) if (sub.handle === key) embedParentPigLinkSubscriptions.delete(id);
    for (const [id, sub] of embedSessionSubscriptions) if (sub.handle === key) embedSessionSubscriptions.delete(id);
    embedRelationships.delete(key);
    embedSessions.delete(key);
    return invoke('wurst:piglet:embed-close', key);
  }
}));

ipcRenderer.on('wurst:piglink:event-accepted', (_event, message = {}) => {
  const name = String(message.name ?? '');
  const payload = structuredClone(message.payload ?? null);
  for (const sub of embedParentPigLinkSubscriptions.values()) {
    if (!embedRelationships.get(sub.handle)?.piglink) continue;
    try { sub.callback(name, payload); } catch {}
  }
});

ipcRenderer.on('wurst:piglet:session-changed', (_event, detail = {}) => {
  const sessionId = String(detail?.session?.id ?? '');
  if (!sessionId) return;
  for (const sub of embedSessionSubscriptions.values()) {
    const session = embedSessions.get(sub.handle);
    if (session?.id !== sessionId) continue;
    embedSessions.set(sub.handle, structuredClone(detail.session));
    try { sub.callback(structuredClone(detail)); } catch {}
  }
});

ipcRenderer.on('wurst:piglet:machine-event', (_event, detail = {}) => {
  const sessionId = String(detail?.session?.id ?? '');
  const name = String(detail?.name ?? '');
  if (!sessionId || !name) return;
  const payload = structuredClone(detail?.payload ?? null);
  for (const client of machineClients.values()) {
    if (client.sessionId !== sessionId) continue;
    for (const key of [name, '*']) for (const listener of client.listeners.get(key) || []) {
      try { listener(payload, name); } catch {}
    }
  }
});

async function connectPigletMachine(ref, options = {}) {
  const opened = await invoke('wurst:piglet:machine-connect', String(ref ?? ''), options);
  const handle = String(opened?.handle ?? '');
  if (!handle) throw new Error('Wurster did not return a machine attachment');
  let closed = false;
  const client = { sessionId: String(opened?.session?.id ?? ''), listeners: new Map() };
  machineClients.set(handle, client);
  return Object.freeze({
    descriptor: structuredClone(opened.descriptor ?? null),
    session: structuredClone(opened.session ?? null),
    piglink: Object.freeze({
      describe: () => invoke('wurst:piglet:machine-describe', handle),
      invoke: async (name, input = {}, invokeOptions = {}) => {
        if (closed) throw new Error('Wurst machine connection is closed');
        const result = await invoke('wurst:piglet:machine-invoke', handle, String(name ?? ''), input, invokeOptions);
        return result?.result ?? null;
      },
      on: (name, listener) => {
        if (typeof listener !== 'function') throw new TypeError('PigLink event listener must be a function');
        const eventName = String(name ?? '*');
        const set = client.listeners.get(eventName) || new Set();
        set.add(listener); client.listeners.set(eventName, set);
        return () => { set.delete(listener); if (!set.size) client.listeners.delete(eventName); };
      }
    }),
    close: async () => {
      if (closed) return false;
      closed = true;
      machineClients.delete(handle);
      return invoke('wurst:piglet:machine-close', handle);
    }
  });
}

window.addEventListener('DOMContentLoaded', installAuthAnchors, { once: true });
window.addEventListener('DOMContentLoaded', installWurstEmbedElement, { once: true });
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
  parent: null,
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
    running: () => invoke('wurst:piglet:running'),
    connect: connectPigletMachine,
    invoke: async (ref, name, input = {}, options = {}) => {
      const child = await connectPigletMachine(ref, options);
      try { return await child.piglink.invoke(name, input, options); }
      finally { await child.close().catch(() => {}); }
    },
    inspect: (ref) => invoke('wurst:piglet:inspect', String(ref ?? '')),
    install: async (name, data, options = {}) => {
      let bytes;
      if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else throw new TypeError('wurst.piglet.install expects Uint8Array or ArrayBuffer Wurst bytes');
      return invoke('wurst:piglet:install', String(name ?? 'Piglet.wurst'), bytes, options);
    },
    remove: (ref) => invoke('wurst:piglet:remove', String(ref ?? ''))
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
  pigfs: Object.freeze({
    capabilities: () => invoke('wurst:pigfs:capabilities'),
    realms: () => invoke('wurst:pigfs:realms'),
    initialize: () => invoke('wurst:pigfs:initialize'),
    unlockRealm: (realmId) => invoke('wurst:pigfs:unlock-realm', String(realmId ?? '')),
    lockRealm: (realmId) => invoke('wurst:pigfs:lock-realm', String(realmId ?? '')),
    history: () => invoke('wurst:pigfs:history'),
    usage: () => invoke('wurst:pigfs:usage'),
    compact: () => invoke('wurst:pigfs:compact'),
    url: (path) => {
      const value = String(path ?? '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/^data\//, '');
      if (!value || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new TypeError('Invalid PigFS media path');
      return `wurst://pigfs/${value.split('/').map(encodeURIComponent).join('/')}`;
    },
    stat: (path) => invoke('wurst:pigfs:stat', path),
    list: (path = '/') => invoke('wurst:pigfs:list', path),
    read: (path, options = {}) => invoke('wurst:pigfs:read', path, {
      offset: Number(options.offset ?? 0),
      length: options.length == null ? undefined : Number(options.length)
    }),
    write: async (path, data, options = {}) => {
      let bytes;
      if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (typeof data === 'string') bytes = new TextEncoder().encode(data);
      else throw new TypeError('wurst.pigfs.write expects Uint8Array, ArrayBuffer or string');
      const tx = await invoke('wurst:pigfs:begin-write', path, { mime: options.mime });
      try {
        const chunkSize = Number(tx.chunkSize) || (4 * 1024 * 1024);
        for (let offset = 0; offset < bytes.byteLength || (bytes.byteLength === 0 && offset === 0); offset += chunkSize) {
          const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
          await invoke('wurst:pigfs:write-chunk', tx.id, chunk);
          if (bytes.byteLength === 0) break;
        }
        return await invoke('wurst:pigfs:commit-write', tx.id);
      } catch (error) {
        await invoke('wurst:pigfs:abort-write', tx.id).catch(() => {});
        throw error;
      }
    },
    beginWrite: (path, options = {}) => invoke('wurst:pigfs:begin-write', path, { mime: options.mime }),
    writeChunk: (id, data) => {
      let bytes;
      if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (typeof data === 'string') bytes = new TextEncoder().encode(data);
      else throw new TypeError('wurst.pigfs.writeChunk expects Uint8Array, ArrayBuffer or string');
      return invoke('wurst:pigfs:write-chunk', id, bytes);
    },
    commitWrite: (id) => invoke('wurst:pigfs:commit-write', id),
    abortWrite: (id) => invoke('wurst:pigfs:abort-write', id),
    remove: (path, options = {}) => invoke('wurst:pigfs:remove', path, { recursive: Boolean(options.recursive) }),
    mkdir: (path, options = {}) => invoke('wurst:pigfs:mkdir', path, { recursive: options.recursive !== false }),
    rename: (from, to) => invoke('wurst:pigfs:rename', from, to)
  })
}));
