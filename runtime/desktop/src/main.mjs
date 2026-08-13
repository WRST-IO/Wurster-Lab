import {
  app,
  BrowserWindow,
  clipboard,
  WebContentsView,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  shell,
  safeStorage,
  session,
  systemPreferences
} from 'electron';
import crypto from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtectionClient } from './protection-client.mjs';
import { buildWurst } from '@wurster/meatgrinder';
import { validateJsonValue } from '@wurster/interface';
import { UnlockSessionBroker } from '@wurster/session';
import { generateTotpSecret, totpUri, verifyTotp } from './identity-core.mjs';
import { publisherDisplayName, secureTrustPresentation, verificationTrustRoute } from './publisher-trust-presentation.mjs';
import { dataFsPath } from './wurst-fs-paths.mjs';
import {
  SEALED_APP_INDEX_PATH,
  classifyRisk,
  createPublisherKeyBundle,
  deriveWursterIdentityMaterial,
  encodeWursterIdentityString,
  createPublisherCertificateRequest,
  generateMeatphrase,
  mimeFor,
  measureWurstFs2Storage,
  networkOrigins,
  normalizeCapabilities,
  normalizeMeatphrase,
  normalizeWurstKey,
  normalizeWurstPath,
  publisherDnsRecordName,
  publisherDnsTxtValue,
  publisherIdentityFromBundle,
  verifyPublisherDomainRecords,
  unlockPublisherPrivateKey,
  openLocalWurstFsStore,
  wurstFsRealmCapabilities,
  wurstFsRealmGovernance,
  verifyWursterIdentityRecord,
  writeCompactedWurstFile,
  openWurstFile,
  verifyPackageSignatureFromReader,
  verifyPublisherCertificate
} from '@wurster/format';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WURST_PRELOAD = path.join(HERE, 'wurst-preload.cjs');
const AUTH_CONTROL_PRELOAD = path.join(HERE, 'auth-control-preload.cjs');
const AUTH_CONTROL_HTML = path.join(HERE, 'auth-control.html');
const IDENTITY_CONTROL_PRELOAD = path.join(HERE, 'identity-control-preload.cjs');
const IDENTITY_CONTROL_HTML = path.join(HERE, 'identity-control.html');
const IDENTITY_VERIFICATION_HTML = path.join(HERE, 'identity-verification.html');
const SEALED_BOOTSTRAP_HTML = path.join(HERE, 'sealed-bootstrap.html');
const TRUSTED_AUTHORITIES_JSON = path.join(HERE, 'trusted-authorities.json');
const TRUST_BUNDLE_JSON = path.join(HERE, 'trust-bundle.json');
const WURSTER_ICON = path.join(app.getAppPath(), 'build', 'icons', 'wurster.png');
const MAX_WURST_FS_SLICE_BYTES = 2 * 1024 * 1024;
const MAX_WURST_FS_CHUNK_BYTES = 4 * 1024 * 1024;
const SUPPORTED_CAPABILITIES = new Set(['storage.local', 'network', 'window.alwaysOnTop', 'code.unsafeEval', 'files.open', 'files.save']);
const MEAT_LOCKER_FORMAT = 'wurster/meat-locker-5';
const WURSTER_SETTINGS_FORMAT = 'wurster/settings-1';
const SETTINGS_HTML = path.join(HERE, 'settings.html');
const LAUNCHER_PRELOAD = path.join(HERE, 'launcher-preload.cjs');
const LAUNCHER_HTML = path.join(HERE, 'launcher.html');
const WRST_AUTHORITY_URL = 'https://authority.wrst.io';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'wurst',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true
    }
  }
]);

app.enableSandbox();
app.setAppUserModelId('io.wrst.wurster');
try { app.setAsDefaultProtocolClient('wurster'); } catch {}
if (process.platform === 'win32') {
  const wursterData = path.join(app.getPath('appData'), 'Wurster');
  mkdirSync(wursterData, { recursive: true });
  app.setPath('userData', wursterData);
  app.setPath('sessionData', wursterData);
}

let currentFile = null;
let currentWindow = null;
let currentContext = null;
const authSurfaces = new Map();
const authSurfaceByWebContents = new Map();
const identitySurfaces = new Map();
const identitySurfaceByWebContents = new Map();
let launcherWindow = null;
let launcherReturnMode = 'launcher';
let launcherView = 'launcher';
let verificationPayload = null;
let verificationReturnMode = 'launcher';
let devToolsWindow = null;
let pendingTotpSetup = null;
let pendingMacOpenFile = null;
let pendingRuntimeHandoff = null;
let initialOpenComplete = false;
let isOpeningPackage = false;
let nextInterfaceRequestId = 1;
const pendingInterfaceInvocations = new Map();
let grinderSourcePath = null;
let grinderCarrierPath = null;
let grinderLastOutput = null;
let grinderSignerId = null;
let grinderBusy = false;
const protectionClient = new ProtectionClient();
const unlockSessions = new UnlockSessionBroker({ defaultTtlMs: 60 * 60 * 1000, maxTtlMs: 24 * 60 * 60 * 1000 });

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', async (_event, argv) => {
    const verificationFile = findIdentityVerificationArgument(argv);
    if (verificationFile) {
      await showIdentityVerificationForFile(verificationFile);
      return;
    }
    const deepLink = findRuntimeHandoffArgument(argv);
    if (deepLink) {
      await handleRuntimeHandoff(deepLink);
      return;
    }
    const file = findWurstArgument(argv);
    if (file) {
      try {
        await loadPackage(path.resolve(file));
      } catch (error) {
        await showWurstError(error);
      }
      return;
    }
    if (currentWindow && !currentWindow.isDestroyed()) {
      if (currentWindow.isMinimized()) currentWindow.restore();
      currentWindow.focus();
    }
  });
}


function findRuntimeHandoffArgument(argv = []) {
  return argv.find((arg) => typeof arg === 'string' && arg.startsWith('wurster://')) ?? null;
}

function findIdentityVerificationArgument(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--verify-wurst-identity') {
      const candidate = argv[index + 1];
      return isWurstCandidate(candidate) ? candidate : null;
    }
    if (typeof arg === 'string' && arg.startsWith('--verify-wurst-identity=')) {
      const candidate = arg.slice('--verify-wurst-identity='.length);
      return isWurstCandidate(candidate) ? candidate : null;
    }
  }
  return null;
}

function parseRuntimeHandoff(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (url.protocol !== 'wurster:') return null;
    const action = (url.hostname || url.pathname.replace(/^\/+/, '') || 'open').toLowerCase();
    const origin = url.searchParams.get('origin');
    const request = url.searchParams.get('request');
    const purpose = url.searchParams.get('purpose') || 'identity';
    const wurstId = url.searchParams.get('wurst');
    const duration = url.searchParams.get('duration') || null;
    return { action, origin, request, purpose, wurstId, duration, rawUrl: url.toString() };
  } catch {
    return null;
  }
}

async function handleRuntimeHandoff(rawUrl) {
  const handoff = parseRuntimeHandoff(rawUrl);
  if (!handoff) return false;
  if (!app.isReady()) {
    pendingRuntimeHandoff = handoff.rawUrl;
    return true;
  }
  const host = handoff.origin ? (() => { try { return new URL(handoff.origin).origin; } catch { return handoff.origin; } })() : 'a web Wurst';
  if (currentWindow && !currentWindow.isDestroyed()) {
    if (currentWindow.isMinimized()) currentWindow.restore();
    currentWindow.show();
    currentWindow.focus();
  } else {
    const win = openLauncherWindow();
    win.show();
    win.focus();
  }
  if (handoff.action === 'auth') {
    const result = await dialog.showMessageBox(launcherWindow ?? currentWindow ?? undefined, {
      type: 'info',
      title: 'Wurster Web Handoff',
      message: 'A web Wurst wants to use your local Wurster identity.',
      detail: `${host}\nWurst: ${handoff.wurstId || 'not supplied'}\nPurpose: ${handoff.purpose}\nRequested session: ${handoff.duration || 'default'}\nRequest: ${handoff.request || 'not supplied'}\n\nNo Meatphrase or private key is sent to the website. The handoff request is origin- and request-bound; returning a cryptographic session grant is the next bridge step.`,
      buttons: ['Open Identities', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response === 0) await openProtectedSettingsWindow();
  }
  return true;
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  void handleRuntimeHandoff(url);
});

function isWurstCandidate(filePath) {
  return typeof filePath === 'string' && /\.(wurst|wrst|png)$/i.test(filePath);
}

async function openRequestedWurst(filePath) {
  if (!isWurstCandidate(filePath)) return false;
  const resolved = path.resolve(filePath);
  if (currentFile && path.resolve(currentFile) === resolved && currentWindow && !currentWindow.isDestroyed()) {
    if (currentWindow.isMinimized()) currentWindow.restore();
    currentWindow.focus();
    return true;
  }
  try {
    await loadPackage(resolved);
    return true;
  } catch (error) {
    await showWurstError(error);
    return false;
  }
}

// macOS delivers Finder/Open-With document launches through the open-file event,
// often before app.whenReady(). Keep the path until the runtime is ready instead
// of falling through to the generic file picker.
app.on('open-file', (event, filePath) => {
  if (!isWurstCandidate(filePath)) return;
  event.preventDefault();
  pendingMacOpenFile = filePath;
  if (app.isReady() && initialOpenComplete) {
    const requested = pendingMacOpenFile;
    pendingMacOpenFile = null;
    void openRequestedWurst(requested);
  }
});

function findWurstArgument(argv) {
  return argv.find((arg) => isWurstCandidate(arg)) ?? null;
}

function safeRequestPath(rawUrl, manifest) {
  const url = new URL(rawUrl);
  if (url.hostname !== 'app') throw new Error('Unknown Wurst host');
  const candidate = decodeURIComponent(url.pathname.replace(/^\//, '')) || manifest.entry;
  if (!candidate || typeof candidate !== 'string') throw new Error('Wurst request has no public path');
  if (candidate.startsWith('__wurst/') || candidate.startsWith('data/')) {
    throw new Error('Private Wurst data is not web-addressable');
  }
  return candidate;
}

function cspFor(manifest) {
  const allowedNetwork = networkOrigins(manifest);
  const capabilities = normalizeCapabilities(manifest.capabilities);
  const connect = allowedNetwork.length ? allowedNetwork.join(' ') : "'none'";
  const scripts = capabilities['code.unsafeEval'] ? "'self' wurst://interface 'unsafe-eval'" : "'self' wurst://interface";
  return [
    "default-src 'self' data: blob:",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' wurst://data data: blob:",
    "font-src 'self' wurst://data data: blob:",
    "media-src 'self' wurst://data data: blob:",
    "worker-src 'self' blob:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'"
  ].join('; ');
}

function responseFor(entry, manifest, data = entry.data, range = null) {
  const headers = {
    'Content-Type': entry.mime,
    'Content-Security-Policy': cspFor(manifest),
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), usb=(), serial=(), hid=(), fullscreen=()',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(data.length)
  };
  if (range) headers['Content-Range'] = `bytes ${range.offset}-${range.offset + data.length - 1}/${range.total}`;
  return new Response(data, { status: range ? 206 : 200, headers });
}

function parseHttpRange(value, total) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value).trim());
  if (!match) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? total - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) return null;
  end = Math.min(end, total - 1);
  return { offset: start, length: end - start + 1, total };
}

function partitionFor(manifest) {
  const id = crypto.createHash('sha256').update(String(manifest.id)).digest('hex').slice(0, 24);
  const capabilities = normalizeCapabilities(manifest.capabilities);
  return capabilities['storage.local'] ? `persist:wurst-${id}` : `wurst-${id}-${crypto.randomUUID()}`;
}

function networkRequestAllowed(rawUrl, manifest) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'wurst:' || url.protocol === 'data:' || url.protocol === 'blob:') return true;
    if (url.protocol !== 'https:') return false;
    return networkOrigins(manifest).includes(url.origin);
  } catch {
    return false;
  }
}

function fullySealedApplication(manifest) {
  return manifest?.application?.protection === 'sealed';
}

async function sealedApplicationMap(context) {
  if (!fullySealedApplication(context.manifest)) return null;
  if (context.sealedAppMap) return context.sealedAppMap;
  const protectionHandle = activeApplicationProtectionHandle(context);
  if (!protectionHandle) throw new Error('Sealed application is locked');

  const indexPath = context.manifest.application?.sealedIndex ?? SEALED_APP_INDEX_PATH;
  const indexEntry = context.reader.entry(indexPath);
  if (!indexEntry || !indexEntry.encryption) throw new Error('Sealed application index is missing or not protected');
  const total = indexEntry.encryption.plainLength;
  const loaded = await protectionClient.read({ handle: protectionHandle, path: indexPath, offset: 0, length: total });
  const parsed = JSON.parse(Buffer.from(loaded.data).toString('utf8'));
  if (parsed?.format !== 'wurst/sealed-app-map-1' || !Array.isArray(parsed.files)) throw new Error('Invalid sealed application map');
  const entryPath = normalizeWurstPath(parsed.entry);
  const files = new Map();
  for (const item of parsed.files) {
    const publicPath = normalizeWurstPath(item.path);
    const resource = normalizeWurstPath(item.resource);
    if (publicPath.startsWith('__wurst/') || publicPath.startsWith('data/')) throw new Error('Invalid path in sealed application map');
    if (files.has(publicPath)) throw new Error(`Duplicate path in sealed application map: ${publicPath}`);
    const resourceEntry = context.reader.entry(resource);
    if (!resourceEntry || !resourceEntry.encryption || (resourceEntry.scope ?? 'app') !== 'app') throw new Error(`Invalid protected resource in sealed application map: ${resource}`);
    files.set(publicPath, { resource, mime: typeof item.mime === 'string' && item.mime ? item.mime : mimeFor(publicPath) });
  }
  if (!files.has(entryPath)) throw new Error('Sealed application entry is missing from protected map');
  context.sealedAppMap = { entry: entryPath, files };
  return context.sealedAppMap;
}

async function resolveApplicationResource(context, requestPath) {
  if (!fullySealedApplication(context.manifest)) {
    const entry = context.reader.entry(requestPath);
    if (!entry || (entry.scope ?? 'app') !== 'app') return null;
    return { resourcePath: requestPath, entry };
  }

  const map = await sealedApplicationMap(context);
  const mapped = map.files.get(normalizeWurstPath(requestPath));
  if (!mapped) return null;
  const rawEntry = context.reader.entry(mapped.resource);
  return { resourcePath: mapped.resource, entry: { ...rawEntry, path: requestPath, mime: mapped.mime } };
}

function configureSession(wurstSession, context) {
  wurstSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  wurstSession.setPermissionCheckHandler(() => false);
  wurstSession.setDevicePermissionHandler(() => false);
  wurstSession.on('will-download', (event) => event.preventDefault());
  wurstSession.on('file-system-access-restricted', (_event, _details, callback) => callback('deny'));
  wurstSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !networkRequestAllowed(details.url, context.manifest) });
  });

  if (wurstSession.protocol.isProtocolHandled('wurst')) wurstSession.protocol.unhandle('wurst');
  wurstSession.protocol.handle('wurst', async (request) => {
    try {
      const parsedUrl = new URL(request.url);
      if (parsedUrl.hostname === 'data') {
        if (!realmDataMode(context.manifest)) return new Response('WurstFS not declared', { status: 404 });
        const requested = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
        const fsPath = dataFsPath(requested);
        const options = realmReadOptions(context, fsPath);
        let entry;
        try { entry = await context.reader.fsStat(fsPath, options); }
        catch (error) { if (error?.code === 'WURST_FS_LOCKED') return new Response('Protected WurstFS realm is locked', { status: 423 }); throw error; }
        if (!entry || entry.type !== 'file') return new Response('WurstFS resource not found', { status: 404 });
        const total = entry.size;
        const requestedRange = parseHttpRange(request.headers.get('range'), total);
        const offset = requestedRange?.offset ?? 0;
        const length = requestedRange?.length ?? total;
        const loaded = await context.reader.fsReadRange(fsPath, offset, length, options);
        if (!loaded) return new Response('WurstFS resource not found', { status: 404 });
        const resourceEntry = {
          path: fsPath,
          length: total,
          mime: entry.mime || mimeFor(entry.name || fsPath)
        };
        if (request.method === 'HEAD') {
          const headers = {
            'Content-Type': resourceEntry.mime,
            'Content-Security-Policy': cspFor(context.manifest),
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
            'Accept-Ranges': 'bytes',
            'Content-Length': String(requestedRange?.length ?? total)
          };
          if (requestedRange) headers['Content-Range'] = `bytes ${requestedRange.offset}-${requestedRange.offset + requestedRange.length - 1}/${total}`;
          return new Response(null, { status: requestedRange ? 206 : 200, headers });
        }
        return responseFor(resourceEntry, context.manifest, loaded.data, requestedRange);
      }
      if (parsedUrl.hostname === 'interface') {
        const declaration = context.manifest.interface;
        if (!declaration?.entry) return new Response('Wurst Interface not declared', { status: 404 });
        const requested = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
        if (requested !== 'entry.js') return new Response('Wurst Interface resource not found', { status: 404 });
        const entry = context.reader.entry(declaration.entry);
        if (!entry || entry.scope !== 'interface' || entry.encryption) return new Response('Wurst Interface unavailable', { status: 404 });
        const loaded = await context.reader.read(declaration.entry, { verify: true });
        return new Response(loaded.data, {
          status: 200,
          headers: {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Content-Security-Policy': cspFor(context.manifest),
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store'
          }
        });
      }
      const requestPath = safeRequestPath(request.url, context.manifest);
      const resolved = await resolveApplicationResource(context, requestPath);
      if (!resolved) return new Response('Wurst resource not found', { status: 404 });
      const { entry, resourcePath } = resolved;
      const total = entry.encryption?.plainLength ?? entry.length;
      const requestedRange = parseHttpRange(request.headers.get('range'), total);

      if (entry.encryption) {
        const protectionHandle = activeApplicationProtectionHandle(context);
        if (!protectionHandle) return new Response('Protected Wurst content is locked', { status: 423 });
        const offset = requestedRange?.offset ?? 0;
        const length = requestedRange?.length ?? total;
        const sliced = await protectionClient.read({ handle: protectionHandle, path: resourcePath, offset, length });
        const data = Buffer.from(sliced.data);
        return responseFor({ ...entry, length: total }, context.manifest, data, requestedRange);
      }

      if (requestedRange) {
        const sliced = await context.reader.readRange(resourcePath, requestedRange.offset, requestedRange.length, { verify: true });
        return responseFor(entry, context.manifest, sliced.data, requestedRange);
      }
      const loaded = await context.reader.read(resourcePath, { verify: true });
      return responseFor(entry, context.manifest, loaded.data);
    } catch {
      return new Response('Bad Wurst request', { status: 400 });
    }
  });
}

function activeCapabilities(manifest) {
  return Object.entries(normalizeCapabilities(manifest.capabilities))
    .filter(([, value]) => value !== false && value != null)
    .map(([name]) => name);
}

function unsupportedCapabilities(manifest) {
  return activeCapabilities(manifest).filter((name) => !SUPPORTED_CAPABILITIES.has(name));
}

function runtimeCapabilityState(manifest, rawName) {
  const name = String(rawName ?? '').trim();
  const capabilities = normalizeCapabilities(manifest.capabilities);
  const requested = Boolean(name && capabilities[name] !== false && capabilities[name] != null);
  const supported = Boolean(name && SUPPORTED_CAPABILITIES.has(name));
  if (!requested) return { name, requested: false, supported, state: 'undeclared', reason: null };
  if (!supported) return { name, requested: true, supported: false, state: 'unsupported', reason: 'runtime' };
  return { name, requested: true, supported: true, state: 'available', reason: null };
}

function runtimeCapabilityStates(manifest) {
  return Object.fromEntries(activeCapabilities(manifest).map((name) => [name, runtimeCapabilityState(manifest, name)]));
}

function validateNetworkPolicy(manifest) {
  const caps = normalizeCapabilities(manifest.capabilities);
  if (!caps.network) return;
  const risk = classifyRisk(manifest);
  if (risk.reasons.some((reason) => reason.reason.includes('Network allowlist contains') || reason.reason.includes('not restricted'))) {
    throw new Error('Wurster refuses unrestricted or non-HTTPS network capabilities. Declare explicit HTTPS origins.');
  }
}

async function trustStorePath() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  return path.join(app.getPath('userData'), 'trusted-publishers.json');
}

async function readTrustStore() {
  try {
    const raw = JSON.parse(await fs.readFile(await trustStorePath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

async function trustPublisher(publisher) {
  const store = await readTrustStore();
  store[publisher.fingerprint] = { label: publisher.label ?? null, email: publisher.email ?? null, domain: publisher.domain ?? null, addedAt: new Date().toISOString() };
  await fs.writeFile(await trustStorePath(), `${JSON.stringify(store, null, 2)}\n`);
}

async function publisherDomainCachePath() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  return path.join(app.getPath('userData'), 'publisher-domain-cache.json');
}

async function readPublisherDomainCache() {
  try {
    const parsed = JSON.parse(await fs.readFile(await publisherDomainCachePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writePublisherDomainCache(cache) {
  await fs.writeFile(await publisherDomainCachePath(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
}

async function resolvePublisherDomainIdentity(publisher) {
  if (!publisher?.domain) return null;
  const domain = publisher.domain;
  const fingerprint = publisher.fingerprint;
  const recordName = publisherDnsRecordName(domain);
  const cache = await readPublisherDomainCache();
  const cached = cache[domain];
  try {
    const records = await Promise.race([
      resolveTxt(recordName),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('DNS verification timed out'), { code: 'ETIMEOUT' })), 1800))
    ]);
    const verification = verifyPublisherDomainRecords({ domain, fingerprint, records });
    if (verification.status === 'verified') {
      cache[domain] = { fingerprint, verifiedAt: new Date().toISOString(), recordName };
      await writePublisherDomainCache(cache).catch(() => {});
    }
    return { ...verification, recordName, source: 'dns', cached: false };
  } catch (error) {
    if (['ENODATA', 'ENOTFOUND', 'ENONAME'].includes(error?.code)) {
      return { status: 'unverified', verified: false, conflict: false, domain, recordName, source: 'dns', cached: false, reason: 'no-record' };
    }
    if (cached?.fingerprint === fingerprint) {
      return { status: 'previously-verified', verified: true, conflict: false, domain, recordName, source: 'cache', cached: true, verifiedAt: cached.verifiedAt ?? null, reason: error?.code ?? 'offline' };
    }
    return { status: 'unavailable', verified: false, conflict: false, domain, recordName, source: 'dns', cached: false, reason: error?.code ?? error?.message ?? 'unavailable' };
  }
}

async function readTrustedAuthorities() {
  let builtin = [];
  try {
    const raw = JSON.parse(await fs.readFile(TRUSTED_AUTHORITIES_JSON, 'utf8'));
    builtin = Array.isArray(raw) ? raw : [];
  } catch {}

  let user = [];
  try {
    const userPath = path.join(app.getPath('userData'), 'trusted-authorities.json');
    const raw = JSON.parse(await fs.readFile(userPath, 'utf8'));
    user = Array.isArray(raw) ? raw : [];
  } catch {}
  return [...builtin, ...user];
}

async function readBuiltinTrustBundle() {
  try {
    return JSON.parse(await fs.readFile(TRUST_BUNDLE_JSON, 'utf8'));
  } catch {
    return null;
  }
}

async function resolvePublisherTrust(signature) {
  if (!signature?.valid || !signature.publisher) return { trusted: false, kind: 'unsigned', certificate: null, domain: null };

  // A trusted Authority certificate is intentionally an offline-first route.
  // Verify it before doing any live publisher-DNS lookup so opening an
  // Authority-certified Wurst never requires routine network contact.
  let certificate = null;
  if (signature.certificate?.record) {
    const roots = await readTrustedAuthorities();
    const trustBundle = await readBuiltinTrustBundle();
    certificate = verifyPublisherCertificate(signature.certificate.record, roots, new Date(), trustBundle);
    if (certificate.status === 'verified') {
      const trustedFingerprint = certificate.root?.fingerprint ?? certificate.issuer?.fingerprint;
      const root = roots.find((candidate) => candidate.fingerprint === trustedFingerprint);
      return {
        trusted: true,
        kind: 'authority',
        certificate,
        domain: null,
        authority: certificate.root?.name ?? certificate.issuer?.name ?? 'Wurst Authority',
        issuer: certificate.issuer?.name ?? null,
        development: Boolean(root?.development)
      };
    }
    if (certificate.status === 'revoked-issuer' || certificate.status === 'revoked-publisher') {
      return { trusted: false, kind: 'revoked-certificate', certificate, domain: null };
    }
    if (certificate.status === 'invalid') return { trusted: false, kind: 'invalid-certificate', certificate, domain: null };
  }

  const domain = await resolvePublisherDomainIdentity(signature.publisher);
  if (domain?.status === 'conflict') {
    return { trusted: false, kind: 'domain-conflict', certificate, domain };
  }
  if (domain?.verified) {
    return { trusted: true, kind: domain.cached ? 'domain-cached' : 'domain', certificate, domain };
  }

  if (certificate) return { trusted: false, kind: 'untrusted-authority', certificate, domain };

  const store = await readTrustStore();
  if (store[signature.publisher.fingerprint]) return { trusted: true, kind: 'local', certificate: null, domain };
  return { trusted: false, kind: 'signed-unknown', certificate: null, domain };
}

function riskDetail(risk, signature, publisherTrust) {
  const lines = risk.reasons.map((item) => `• ${item.reason}`);
  lines.push('');
  if (signature.status === 'signed') {
    lines.push(`Signed by: ${publisherDisplayName(signature.publisher)}`);
    lines.push(`Fingerprint: ${signature.publisher.fingerprint.slice(0, 24)}…`);
    if (publisherTrust?.kind === 'domain' || publisherTrust?.kind === 'domain-cached') {
      lines.push(`Publisher verification: ${publisherTrust.kind === 'domain' ? 'DOMAIN VERIFIED' : 'previously domain verified'} (${publisherTrust.domain?.domain})`);
    } else if (publisherTrust?.kind === 'domain-conflict') {
      lines.push(`Publisher verification: CONFLICT (${publisherTrust.domain?.domain} does not authorize this key)`);
    } else if (publisherTrust?.kind === 'authority') {
      lines.push(`Publisher verification: VERIFIED by ${publisherTrust.authority}${publisherTrust.development ? ' [DEVELOPMENT ROOT]' : ''}`);
    } else if (publisherTrust?.kind === 'local') {
      lines.push('Publisher verification: locally trusted on this Wurster');
    } else if (publisherTrust?.kind === 'untrusted-authority') {
      lines.push('Publisher certificate: valid, but Authority is not trusted by this Wurster');
    } else if (publisherTrust?.kind === 'revoked-certificate') {
      lines.push(`Publisher certificate: REVOKED (${publisherTrust.certificate?.status ?? 'revoked'})`);
    } else if (publisherTrust?.kind === 'invalid-certificate') {
      lines.push(`Publisher certificate: INVALID (${publisherTrust.certificate?.error ?? 'verification failed'})`);
    } else {
      lines.push('Publisher verification: unknown publisher');
    }
  } else {
    lines.push('Publisher: unsigned');
  }
  return lines.join('\n');
}

async function authorizePackage(manifest, risk, signature) {
  if (signature.status === 'invalid') throw new Error(`Wurst signature is invalid: ${signature.error ?? 'unknown verification error'}`);

  // A conforming runtime never rejects a valid Wurst merely because this
  // particular platform/runtime cannot provide one of its optional capabilities.
  // Unsupported capabilities remain unavailable and are observable from
  // wurst.capabilities so the application can degrade gracefully.
  validateNetworkPolicy(manifest);

  const publisherTrust = await resolvePublisherTrust(signature);
  if (publisherTrust.kind === 'domain-conflict') {
    const response = await dialog.showMessageBox(launcherWindow && !launcherWindow.isDestroyed() ? launcherWindow : undefined, {
      type: 'warning',
      title: 'Publisher identity conflict',
      message: `${publisherTrust.domain.domain} does not authorize this Wurst signing key.`,
      detail: 'The package signature itself is valid, but its claimed domain identity conflicts with the domain’s current _wurst DNS records.',
      buttons: ['Cancel', 'Open Wurst Anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (response.response !== 1) throw new Error('Wurst opening canceled because of a publisher identity conflict');
  }

  const supportedCapabilities = Object.fromEntries(Object.entries(normalizeCapabilities(manifest.capabilities))
    .filter(([name, value]) => SUPPORTED_CAPABILITIES.has(name) && value !== false && value != null));
  const runtimeRisk = classifyRisk({ ...manifest, capabilities: supportedCapabilities });
  if (runtimeRisk.level === 'red' && signature.status !== 'signed') {
    throw new Error('RED WURST: security-sensitive capabilities available on this runtime require a valid publisher signature.');
  }
  return { publisherTrust, unsupportedCapabilities: unsupportedCapabilities(manifest) };
}

async function meatLockerPath() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  return path.join(app.getPath('userData'), 'meat-locker.json');
}

async function settingsPath() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  return path.join(app.getPath('userData'), 'wurster-settings.json');
}

function meatLockerAvailable() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (typeof safeStorage.getSelectedStorageBackend === 'function') {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === 'basic_text') return false;
    }
    return true;
  } catch {
    return false;
  }
}

function devicePresenceAvailable() {
  if (process.platform === 'darwin') {
    return typeof systemPreferences.canPromptTouchID === 'function'
      && systemPreferences.canPromptTouchID();
  }
  // Windows Hello is requested through the system UserConsentVerifier API.
  // Availability is checked when the prompt is actually invoked.
  if (process.platform === 'win32') return true;
  return false;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
    });
  });
}

async function promptWindowsHello(message) {
  const owner = currentWindow && !currentWindow.isDestroyed()
    ? currentWindow
    : (launcherWindow && !launcherWindow.isDestroyed() ? launcherWindow : null);
  try {
    if (owner) {
      if (owner.isMinimized()) owner.restore();
      owner.show();
      owner.moveTop();
      owner.focus();
    }
  } catch {}
  let ownerHwnd = '0';
  try {
    const handle = owner?.getNativeWindowHandle?.();
    if (handle?.length >= 8) ownerHwnd = handle.readBigUInt64LE(0).toString();
    else if (handle?.length >= 4) ownerHwnd = String(handle.readUInt32LE(0));
  } catch {}
  const messageBase64 = Buffer.from(String(message), 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WursterForeground {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
"@
$owner = [IntPtr]([Int64]${ownerHwnd})
if ($owner -ne [IntPtr]::Zero) {
  [WursterForeground]::BringWindowToTop($owner) | Out-Null
  [WursterForeground]::SetForegroundWindow($owner) | Out-Null
}
$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${messageBase64}'))
$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$resultType = [Windows.Security.Credentials.UI.UserConsentVerificationResult,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1
if (-not $method) { throw 'Windows Runtime AsTask bridge unavailable' }
$op = $verifier::RequestVerificationAsync($message)
$task = $method.MakeGenericMethod($resultType).Invoke($null, @($op))
$task.Wait()
Write-Output $task.Result.ToString()
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded]);
  const result = stdout.split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  if (result !== 'Verified') throw new Error(result ? `Windows Security: ${result}` : 'Windows Security verification failed');
  return true;
}

async function promptRuntimeUserPresence(message) {
  if (process.platform === 'darwin' && devicePresenceAvailable()) {
    await systemPreferences.promptTouchID(message);
    return true;
  }
  if (process.platform === 'win32') return promptWindowsHello(message);
  throw new Error('This runtime has no interactive OS user-presence adapter yet');
}

async function readMeatLocker() {
  try {
    const parsed = JSON.parse(await fs.readFile(await meatLockerPath(), 'utf8'));
    if (!Array.isArray(parsed?.identities)) throw new Error('Invalid Meat Locker');
    if (['wurster/meat-locker-3', 'wurster/meat-locker-4'].includes(parsed.format)) {
      const migrated = { format: MEAT_LOCKER_FORMAT, identities: parsed.identities, publishers: Array.isArray(parsed.publishers) ? parsed.publishers : [] };
      await writeMeatLocker(migrated).catch(() => {});
      return migrated;
    }
    if (parsed.format !== MEAT_LOCKER_FORMAT) throw new Error('Invalid Meat Locker');
    if (!Array.isArray(parsed.publishers)) parsed.publishers = [];
    return parsed;
  } catch {
    return { format: MEAT_LOCKER_FORMAT, identities: [], publishers: [] };
  }
}

async function writeMeatLocker(locker) {
  await fs.writeFile(await meatLockerPath(), `${JSON.stringify(locker, null, 2)}\n`, { mode: 0o600 });
}

async function readWursterSettings() {
  try {
    const parsed = JSON.parse(await fs.readFile(await settingsPath(), 'utf8'));
    if (parsed?.format !== WURSTER_SETTINGS_FORMAT) throw new Error('Invalid Wurster settings');
    return parsed;
  } catch {
    return { format: WURSTER_SETTINGS_FORMAT, totp: null };
  }
}

async function writeWursterSettings(settings) {
  await fs.writeFile(await settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

function identitySummary(identity) {
  return {
    id: identity.id,
    name: identity.name,
    emoji: identity.emoji ?? '🐷',
    createdAt: identity.createdAt,
    lastUsedAt: identity.lastUsedAt ?? null,
    protection: {
      totp: Boolean(identity.protection?.totp)
    },
    wursterIdentity: identity.wursterIdentity ? structuredClone(identity.wursterIdentity) : null
  };
}

function normalizeIdentityEmoji(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '🐷';
  return Array.from(normalized).slice(0, 8).join('');
}

async function listMeatIdentities() {
  if (!meatLockerAvailable()) return [];
  const locker = await readMeatLocker();
  return locker.identities.map(identitySummary);
}

async function saveMeatIdentity(name, meatphrase, protection = {}, emoji = '🐷') {
  if (!meatLockerAvailable()) throw new Error('Secure OS storage is not available on this device');
  const normalizedName = String(name ?? '').trim().slice(0, 80) || 'Personal Meat';
  const normalized = normalizeMeatphrase(meatphrase);
  const encrypted = safeStorage.encryptString(normalized).toString('base64');
  const wursterIdentity = deriveWursterIdentityMaterial(normalized, { name: normalizedName, emoji: normalizeIdentityEmoji(emoji) }).publicRecord;
  const locker = await readMeatLocker();
  const identity = {
    id: crypto.randomUUID(),
    name: normalizedName,
    emoji: normalizeIdentityEmoji(emoji),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    protection: {
      totp: Boolean(protection.totp)
    },
    protectedMeatphrase: encrypted,
    wursterIdentity
  };
  locker.identities.push(identity);
  await writeMeatLocker(locker);
  return identitySummary(identity);
}

async function updateMeatIdentity(identityId, updates = {}) {
  const locker = await readMeatLocker();
  const identity = locker.identities.find((item) => item.id === String(identityId));
  if (!identity) throw new Error('Meat Identity not found');
  if (updates.name != null) identity.name = String(updates.name).trim().slice(0, 80) || identity.name;
  if (updates.emoji != null) identity.emoji = normalizeIdentityEmoji(updates.emoji);
  if (updates.protection && typeof updates.protection === 'object') {
    identity.protection = {
      totp: Boolean(updates.protection.totp)
    };
    if (identity.protection.totp) {
      const settings = await readWursterSettings();
      if (!settings.totp?.protectedSecret) throw new Error('Configure Wurster Authenticator protection before requiring TOTP for an identity');
    }
  }
  if (updates.name != null || updates.emoji != null || !identity.wursterIdentity) {
    const phrase = safeStorage.decryptString(Buffer.from(identity.protectedMeatphrase, 'base64'));
    identity.wursterIdentity = deriveWursterIdentityMaterial(phrase, { name: identity.name, emoji: identity.emoji }).publicRecord;
  }
  await writeMeatLocker(locker);
  return identitySummary(identity);
}

async function deleteMeatIdentity(identityId) {
  const locker = await readMeatLocker();
  const before = locker.identities.length;
  locker.identities = locker.identities.filter((item) => item.id !== String(identityId));
  if (locker.identities.length === before) return false;
  await writeMeatLocker(locker);
  return true;
}

async function verifyLockerTotp(code) {
  if (!meatLockerAvailable()) throw new Error('Secure OS storage is not available on this device');
  const settings = await readWursterSettings();
  if (!settings.totp?.protectedSecret) throw new Error('Wurster Authenticator protection is not configured');
  const secret = safeStorage.decryptString(Buffer.from(settings.totp.protectedSecret, 'base64'));
  try {
    if (!verifyTotp(secret, code)) throw new Error('Invalid authenticator code');
  } finally {
    // JavaScript strings cannot be reliably zeroized; keep lifetime minimal.
  }
  return true;
}

async function authorizeIdentityUse(identity, { totp = null } = {}) {
  await promptIdentityDevicePresence(identity);
  if (identity.protection?.totp) await verifyLockerTotp(totp);
}

async function loadMeatIdentity(identityId, authorization = {}) {
  if (!meatLockerAvailable()) throw new Error('Secure OS storage is not available on this device');
  const locker = await readMeatLocker();
  const identity = locker.identities.find((item) => item.id === String(identityId));
  if (!identity) throw new Error('Meat Identity not found');
  await authorizeIdentityUse(identity, authorization);
  const meatphrase = safeStorage.decryptString(Buffer.from(identity.protectedMeatphrase, 'base64'));
  if (!identity.wursterIdentity) identity.wursterIdentity = deriveWursterIdentityMaterial(meatphrase, { name: identity.name, emoji: identity.emoji }).publicRecord;
  identity.lastUsedAt = new Date().toISOString();
  await writeMeatLocker(locker);
  return { meatphrase, ...identitySummary(identity) };
}

async function revealMeatIdentity(identityId, authorization = {}) {
  return loadMeatIdentity(identityId, authorization);
}


function publisherSignerName(publisher) {
  return publisher.domain ?? publisher.email ?? publisher.label ?? `Signer ${String(publisher.fingerprint ?? '').slice(0, 10)}…`;
}

function publisherSignerSummary(publisher, verification = null, authority = null) {
  return {
    id: publisher.id,
    label: publisher.label ?? null,
    email: publisher.email ?? null,
    domain: publisher.domain ?? null,
    fingerprint: publisher.fingerprint,
    createdAt: publisher.createdAt,
    lastUsedAt: publisher.lastUsedAt ?? null,
    dns: publisher.domain ? {
      name: publisherDnsRecordName(publisher.domain),
      value: publisherDnsTxtValue(publisher.fingerprint)
    } : null,
    verification: verification ?? publisher.verification ?? { status: publisher.domain ? 'unchecked' : 'none', verified: false, conflict: false },
    authority: authority ?? publisher.authority ?? { status: 'none', verified: false, authority: 'WRST.IO', claims: [] },
    pendingAuthority: {
      domain: publisher.authorityDomainPending?.challenge?.statement?.dns ?? null,
      email: publisher.authorityEmailPending ? {
        email: publisher.email ?? null,
        expiresAt: publisher.authorityEmailPending.challenge?.statement?.expiresAt ?? null
      } : null
    }
  };
}

async function publisherAuthorityStatus(publisher) {
  if (!publisher?.certificate) return { status: 'none', verified: false, authority: 'WRST.IO', claims: [] };
  const roots = await readTrustedAuthorities();
  const trustBundle = await readBuiltinTrustBundle();
  const result = verifyPublisherCertificate(publisher.certificate, roots, new Date(), trustBundle);
  const claims = Array.isArray(result?.claims) ? result.claims : [];
  const matchesPublisher = result?.subject?.fingerprint === publisher.fingerprint;
  if (result?.status === 'verified' && matchesPublisher) {
    return {
      status: 'verified',
      verified: true,
      authority: 'WRST.IO',
      issuer: result.issuer?.name ?? null,
      expiresAt: result.expiresAt ?? publisher.certificate?.statement?.expiresAt ?? null,
      claims
    };
  }
  return {
    status: matchesPublisher ? (result?.status ?? 'invalid') : 'publisher-mismatch',
    verified: false,
    authority: 'WRST.IO',
    claims,
    error: matchesPublisher ? (result?.error ?? null) : 'Certificate belongs to a different publisher key'
  };
}

async function cachedPublisherSignerVerification(publisher) {
  if (!publisher.domain) return { status: 'none', verified: false, conflict: false };
  const cache = await readPublisherDomainCache();
  const cached = cache[publisher.domain];
  if (cached?.fingerprint === publisher.fingerprint) {
    return { status: 'previously-verified', verified: true, conflict: false, cached: true, verifiedAt: cached.verifiedAt ?? null };
  }
  return publisher.verification ?? { status: 'unchecked', verified: false, conflict: false };
}

async function listPublisherSigners() {
  if (!meatLockerAvailable()) return [];
  const locker = await readMeatLocker();
  return Promise.all(locker.publishers.map(async (publisher) => publisherSignerSummary(publisher, await cachedPublisherSignerVerification(publisher), await publisherAuthorityStatus(publisher))));
}

async function savePublisherSigner({ label = null, email = null, domain = null, meatphrase = null } = {}) {
  if (!meatLockerAvailable()) throw new Error('Secure OS storage is required for MeatGrinder signing identities');
  const requestedMeatphrase = String(meatphrase ?? '').trim();
  const created = createPublisherKeyBundle({ label, email, domain, meatphrase: requestedMeatphrase || undefined });
  const locker = await readMeatLocker();
  if (locker.publishers.some((item) => item.fingerprint === created.fingerprint)) throw new Error('This publisher key is already stored in Wurster');
  const publisher = {
    id: crypto.randomUUID(),
    label: created.bundle.label ?? null,
    email: created.bundle.email ?? null,
    domain: created.bundle.domain ?? null,
    fingerprint: created.fingerprint,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    verification: { status: created.bundle.domain ? 'unchecked' : 'none', verified: false, conflict: false },
    certificate: null,
    authorityDomainPending: null,
    authorityEmailPending: null,
    protectedBundle: safeStorage.encryptString(JSON.stringify(created.bundle)).toString('base64'),
    protectedMeatphrase: safeStorage.encryptString(created.meatphrase).toString('base64')
  };
  locker.publishers.push(publisher);
  await writeMeatLocker(locker);
  return {
    ...publisherSignerSummary(publisher),
    generatedMeatphrase: requestedMeatphrase ? null : created.meatphrase
  };
}

async function importPublisherSigner({ bundle, meatphrase } = {}) {
  if (!meatLockerAvailable()) throw new Error('Secure OS storage is required for MeatGrinder signing identities');
  if (!bundle || typeof bundle !== 'object') throw new Error('Publisher key bundle is missing');
  if (!meatphrase) throw new Error('Publisher Meatphrase is required');
  const identity = publisherIdentityFromBundle(bundle);
  // Prove the supplied Meatphrase opens this exact private key before storing it.
  unlockPublisherPrivateKey(bundle, meatphrase);
  const locker = await readMeatLocker();
  if (locker.publishers.some((item) => item.fingerprint === identity.fingerprint)) throw new Error('This publisher key is already stored in Wurster');
  const publisher = {
    id: crypto.randomUUID(),
    label: identity.label ?? null,
    email: identity.email ?? null,
    domain: identity.domain ?? null,
    fingerprint: identity.fingerprint,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    verification: { status: identity.domain ? 'unchecked' : 'none', verified: false, conflict: false },
    certificate: null,
    authorityDomainPending: null,
    authorityEmailPending: null,
    protectedBundle: safeStorage.encryptString(JSON.stringify(bundle)).toString('base64'),
    protectedMeatphrase: safeStorage.encryptString(normalizeMeatphrase(meatphrase)).toString('base64')
  };
  locker.publishers.push(publisher);
  await writeMeatLocker(locker);
  return publisherSignerSummary(publisher);
}

async function verifyPublisherSignerDns(publisherId) {
  const locker = await readMeatLocker();
  const publisher = locker.publishers.find((item) => item.id === String(publisherId));
  if (!publisher) throw new Error('MeatGrinder signing identity not found');
  if (!publisher.domain) return publisherSignerSummary(publisher, { status: 'none', verified: false, conflict: false });
  const verification = await resolvePublisherDomainIdentity(publisher);
  publisher.verification = {
    status: verification.status,
    verified: Boolean(verification.verified),
    conflict: Boolean(verification.conflict),
    checkedAt: new Date().toISOString(),
    reason: verification.reason ?? null
  };
  await writeMeatLocker(locker);
  return publisherSignerSummary(publisher, verification);
}

async function wrstAuthorityPost(pathname, payload) {
  const response = await fetch(new URL(pathname, WRST_AUTHORITY_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `WRST.IO Authority request failed with HTTP ${response.status}`);
    error.code = body.error || null;
    error.status = response.status;
    throw error;
  }
  return body;
}

async function authorityRequestMaterial(publisherId, purpose) {
  const material = await loadPublisherSignerMaterial(publisherId, { prompt: true });
  const request = createPublisherCertificateRequest(material.bundle, material.meatphrase);
  if (purpose === 'domain' && !request.statement.subject.domain) throw new Error('This signing identity has no domain claim');
  if (purpose === 'email' && !request.statement.subject.email) throw new Error('This signing identity has no email claim');
  return { material, request };
}

async function beginPublisherAuthorityDomain(publisherId) {
  const { request } = await authorityRequestMaterial(publisherId, 'domain');
  const body = await wrstAuthorityPost('/v1/domain/challenge', { request });
  if (!body.challenge) throw new Error('WRST.IO did not return a domain challenge');
  const locker = await readMeatLocker();
  const publisher = locker.publishers.find((item) => item.id === String(publisherId));
  if (!publisher) throw new Error('MeatGrinder signing identity not found');
  publisher.authorityDomainPending = { request, challenge: body.challenge, createdAt: new Date().toISOString() };
  await writeMeatLocker(locker);
  return { signer: publisherSignerSummary(publisher, await cachedPublisherSignerVerification(publisher), await publisherAuthorityStatus(publisher)), dns: body.challenge.statement?.dns ?? null, expiresAt: body.challenge.statement?.expiresAt ?? null };
}

async function completePublisherAuthorityDomain(publisherId) {
  const locker = await readMeatLocker();
  const publisher = locker.publishers.find((item) => item.id === String(publisherId));
  if (!publisher) throw new Error('MeatGrinder signing identity not found');
  const pending = publisher.authorityDomainPending;
  if (!pending?.request || !pending?.challenge) throw new Error('No pending WRST.IO domain challenge. Request one first.');
  const body = await wrstAuthorityPost('/v1/domain/certificate', { request: pending.request, challenge: pending.challenge, certificate: publisher.certificate ?? null });
  if (!body.certificate) throw new Error('WRST.IO did not return a publisher certificate');
  publisher.certificate = body.certificate;
  publisher.authorityDomainPending = null;
  await writeMeatLocker(locker);
  const authority = await publisherAuthorityStatus(publisher);
  if (!authority.verified) throw new Error(`WRST.IO returned a certificate Wurster cannot verify: ${authority.error ?? authority.status}`);
  return publisherSignerSummary(publisher, await cachedPublisherSignerVerification(publisher), authority);
}

async function beginPublisherAuthorityEmail(publisherId) {
  const { request } = await authorityRequestMaterial(publisherId, 'email');
  const body = await wrstAuthorityPost('/v1/email/challenge', { request });
  if (!body.challenge) throw new Error('WRST.IO did not return an email challenge');
  const locker = await readMeatLocker();
  const publisher = locker.publishers.find((item) => item.id === String(publisherId));
  if (!publisher) throw new Error('MeatGrinder signing identity not found');
  publisher.authorityEmailPending = { request, challenge: body.challenge, createdAt: new Date().toISOString() };
  await writeMeatLocker(locker);
  return { signer: publisherSignerSummary(publisher, await cachedPublisherSignerVerification(publisher), await publisherAuthorityStatus(publisher)), email: publisher.email, expiresAt: body.challenge.statement?.expiresAt ?? null };
}

async function completePublisherAuthorityEmail(publisherId, code) {
  const cleanCode = String(code ?? '').trim();
  if (!/^\d{6}$/.test(cleanCode)) throw new Error('WRST.IO email verification code must contain exactly six digits');
  const locker = await readMeatLocker();
  const publisher = locker.publishers.find((item) => item.id === String(publisherId));
  if (!publisher) throw new Error('MeatGrinder signing identity not found');
  const pending = publisher.authorityEmailPending;
  if (!pending?.request || !pending?.challenge) throw new Error('No pending WRST.IO email challenge. Send a code first.');
  const body = await wrstAuthorityPost('/v1/email/certificate', { request: pending.request, challenge: pending.challenge, code: cleanCode, certificate: publisher.certificate ?? null });
  if (!body.certificate) throw new Error('WRST.IO did not return a publisher certificate');
  publisher.certificate = body.certificate;
  publisher.authorityEmailPending = null;
  await writeMeatLocker(locker);
  const authority = await publisherAuthorityStatus(publisher);
  if (!authority.verified) throw new Error(`WRST.IO returned a certificate Wurster cannot verify: ${authority.error ?? authority.status}`);
  return publisherSignerSummary(publisher, await cachedPublisherSignerVerification(publisher), authority);
}

async function loadPublisherSignerMaterial(publisherId, { prompt = true } = {}) {
  if (!meatLockerAvailable()) throw new Error('Secure OS storage is not available on this device');
  const locker = await readMeatLocker();
  const publisher = locker.publishers.find((item) => item.id === String(publisherId));
  if (!publisher) throw new Error('MeatGrinder signing identity not found');
  if (prompt && devicePresenceAvailable()) await promptRuntimeUserPresence(`Sign Wurst as ${publisherSignerName(publisher)}`);
  const bundle = JSON.parse(safeStorage.decryptString(Buffer.from(publisher.protectedBundle, 'base64')));
  const meatphrase = safeStorage.decryptString(Buffer.from(publisher.protectedMeatphrase, 'base64'));
  publisher.lastUsedAt = new Date().toISOString();
  await writeMeatLocker(locker);
  return { bundle, meatphrase, certificate: publisher.certificate ?? null, summary: publisherSignerSummary(publisher, await cachedPublisherSignerVerification(publisher), await publisherAuthorityStatus(publisher)) };
}

async function revealPublisherSignerMeatphrase(publisherId) {
  const material = await loadPublisherSignerMaterial(publisherId, { prompt: true });
  return { meatphrase: material.meatphrase, signer: material.summary };
}

async function deletePublisherSigner(publisherId) {
  const locker = await readMeatLocker();
  const before = locker.publishers.length;
  locker.publishers = locker.publishers.filter((item) => item.id !== String(publisherId));
  if (locker.publishers.length === before) return false;
  if (grinderSignerId === String(publisherId)) grinderSignerId = null;
  await writeMeatLocker(locker);
  return true;
}

async function promptIdentityDevicePresence(identity) {
  if (!devicePresenceAvailable()) return true;
  return promptRuntimeUserPresence(`Use Meat Identity: ${identity.name}`);
}

async function promptWursterAdministrationPresence() {
  // This protects Wurster's local Meat Locker, never the portable Wurst file.
  // macOS uses Touch ID and Windows asks the system UserConsentVerifier
  // (Windows Hello / PIN / biometric, depending on the machine).
  return promptRuntimeUserPresence('Open Wurster Meat Locker');
}

async function readIdentityForAuth(identityId) {
  if (!meatLockerAvailable()) throw new Error('Secure OS storage is not available on this device');
  const locker = await readMeatLocker();
  const identity = locker.identities.find((item) => item.id === String(identityId));
  if (!identity) throw new Error('Meat Identity not found');
  await promptIdentityDevicePresence(identity);
  const meatphrase = safeStorage.decryptString(Buffer.from(identity.protectedMeatphrase, 'base64'));
  if (!identity.wursterIdentity) {
    identity.wursterIdentity = deriveWursterIdentityMaterial(meatphrase, { name: identity.name, emoji: identity.emoji }).publicRecord;
    await writeMeatLocker(locker);
  }
  return { identity, meatphrase, summary: identitySummary(identity) };
}

async function markIdentityUsed(identityId) {
  const locker = await readMeatLocker();
  const identity = locker.identities.find((item) => item.id === String(identityId));
  if (!identity) return;
  identity.lastUsedAt = new Date().toISOString();
  await writeMeatLocker(locker);
}

function authSurfaceForEvent(event) {
  const surface = authSurfaceByWebContents.get(event.sender.id);
  if (!surface || surface.destroyed || surface.context !== currentContext) throw new Error('Invalid Wurster Auth surface');
  return surface;
}

function authResultPayload(surface, ok, extra = {}) {
  return {
    id: surface.anchorId,
    ok,
    type: surface.type,
    purpose: surface.purpose,
    target: surface.target || null,
    ...extra
  };
}

function sendAuthResultToWurst(surface, ok, extra = {}) {
  if (!currentWindow || currentWindow.isDestroyed()) return;
  currentWindow.webContents.send('wurst:auth:result', authResultPayload(surface, ok, extra));
}

function authSurfaceLayout(surface, expanded = surface.expanded) {
  const base = surface.baseBounds;
  const content = currentWindow?.getContentBounds?.() ?? { width: 800, height: 600 };
  const baseWidth = Math.max(220, Math.min(base.width, Math.max(220, content.width - 8)));
  const baseHeight = Math.max(60, base.height);
  const anchorX = Math.max(4, Math.min(base.x, Math.max(4, content.width - baseWidth - 4)));
  const anchorY = Math.max(4, Math.min(base.y, Math.max(4, content.height - baseHeight - 4)));

  if (!expanded) {
    return {
      viewBounds: { x: anchorX, y: anchorY, width: baseWidth, height: baseHeight },
      controlBounds: { x: 0, y: 0, width: baseWidth, height: baseHeight },
      expanded: false
    };
  }

  // While the identity picker is open, the trusted Wurster view temporarily
  // covers the whole Wurst window. This keeps the popup independent from the
  // DOM anchor's clipping/overflow rules while still keeping all secret UI in
  // a separate WebContents owned by Wurster.
  return {
    viewBounds: { x: 0, y: 0, width: Math.max(1, content.width), height: Math.max(1, content.height) },
    controlBounds: { x: anchorX, y: anchorY, width: baseWidth, height: baseHeight },
    expanded: true
  };
}

function applyAuthSurfaceLayout(surface) {
  if (!surface || surface.destroyed) return;
  const layout = authSurfaceLayout(surface, surface.expanded);
  // Re-adding an existing child view moves it to the top of the view stack.
  // Do this for an expanded picker so the dropdown can never end up hidden
  // behind the Wurst renderer or another embedded surface.
  if (surface.expanded && currentWindow && !currentWindow.isDestroyed()) {
    currentWindow.contentView.addChildView(surface.view);
  }
  surface.view.setBounds(layout.viewBounds);
  if (!surface.view.webContents.isDestroyed()) {
    surface.view.webContents.send('wurster:auth:layout', {
      ...layout.controlBounds,
      expanded: layout.expanded
    });
  }
}

function destroyAuthSurface(surface) {
  if (!surface || surface.destroyed) return;
  surface.destroyed = true;
  if (surface.pendingMeatphrase) surface.pendingMeatphrase = null;
  authSurfaces.delete(surface.anchorId);
  authSurfaceByWebContents.delete(surface.view.webContents.id);
  try { currentWindow?.contentView.removeChildView(surface.view); } catch {}
  try { surface.view.webContents.close(); } catch {}
}

function destroyAllAuthSurfaces() {
  for (const surface of [...authSurfaces.values()]) destroyAuthSurface(surface);
  authSurfaces.clear();
  authSurfaceByWebContents.clear();
}

function createAuthSurface(context, anchor) {
  if (!currentWindow || currentWindow.isDestroyed()) return null;
  const view = new WebContentsView({
    webPreferences: {
      preload: AUTH_CONTROL_PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false
    }
  });
  const surface = {
    anchorId: anchor.id,
    type: anchor.type,
    purpose: anchor.purpose,
    target: anchor.target,
    session: anchor.session || '',
    context,
    view,
    baseBounds: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
    expanded: false,
    destroyed: false,
    pendingIdentity: null,
    pendingMeatphrase: null
  };
  authSurfaces.set(surface.anchorId, surface);
  authSurfaceByWebContents.set(view.webContents.id, surface);
  currentWindow.contentView.addChildView(view);
  applyAuthSurfaceLayout(surface);
  try { view.setBackgroundColor('#00000000'); } catch {}
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event) => event.preventDefault());
  void view.webContents.loadFile(AUTH_CONTROL_HTML).then(() => applyAuthSurfaceLayout(surface));
  return surface;
}

function updateAuthSurface(surface, anchor) {
  surface.type = anchor.type;
  surface.purpose = anchor.purpose;
  surface.target = anchor.target;
  surface.session = anchor.session || '';
  surface.baseBounds = { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height };
  applyAuthSurfaceLayout(surface);
}

ipcMain.on('wurst:auth:anchors', (event, rawAnchors) => {
  if (!currentContext || !currentWindow || currentWindow.isDestroyed() || event.sender.id !== currentWindow.webContents.id) return;
  const anchors = Array.isArray(rawAnchors) ? rawAnchors.slice(0, 8) : [];
  const seen = new Set();
  for (const raw of anchors) {
    const id = String(raw?.id ?? '').slice(0, 80);
    const type = raw?.type === 'wurstkey' ? 'wurstkey' : 'identity';
    const requestedPurpose = String(raw?.purpose ?? '').toLowerCase();
    const purpose = type === 'wurstkey'
      ? 'application'
      : ['identity', 'filesystem', 'realm'].includes(requestedPurpose) ? requestedPurpose : 'identity';
    const width = Math.round(Number(raw?.width));
    const height = Math.round(Number(raw?.height));
    const x = Math.round(Number(raw?.x));
    const y = Math.round(Number(raw?.y));
    if (!id || !raw?.visible || !Number.isFinite(width) || !Number.isFinite(height) || width < 180 || height < 54) continue;
    if (![x, y].every(Number.isFinite)) continue;
    const anchor = { id, type, purpose, target: String(raw?.target ?? '').slice(0, 256), session: String(raw?.session ?? '').slice(0, 32), width, height, x, y };
    seen.add(id);
    const existing = authSurfaces.get(id);
    if (existing) updateAuthSurface(existing, anchor);
    else createAuthSurface(currentContext, anchor);
  }
  for (const [id, surface] of [...authSurfaces]) if (!seen.has(id)) destroyAuthSurface(surface);
});

function identitySurfaceForEvent(event) {
  const surface = identitySurfaceByWebContents.get(event.sender.id);
  if (!surface || surface.destroyed || surface.context !== currentContext) throw new Error('Invalid Wurst Identity surface');
  return surface;
}

function identitySurfaceLayout(surface) {
  const base = surface.baseBounds;
  const content = currentWindow?.getContentBounds?.() ?? { width: 800, height: 600 };
  const width = Math.max(190, Math.min(base.width, Math.max(190, content.width - 8)));
  const height = Math.max(50, Math.min(base.height, 110));
  const x = Math.max(4, Math.min(base.x, Math.max(4, content.width - width - 4)));
  const y = Math.max(4, Math.min(base.y, Math.max(4, content.height - height - 4)));
  return { x, y, width, height };
}

function raiseExpandedAuthSurfaces() {
  if (!currentWindow || currentWindow.isDestroyed()) return;
  for (const surface of authSurfaces.values()) {
    if (surface.expanded && !surface.destroyed) currentWindow.contentView.addChildView(surface.view);
  }
}

function applyIdentitySurfaceLayout(surface) {
  if (!surface || surface.destroyed || !currentWindow || currentWindow.isDestroyed()) return;
  surface.view.setBounds(identitySurfaceLayout(surface));
  raiseExpandedAuthSurfaces();
}

function destroyIdentitySurface(surface) {
  if (!surface || surface.destroyed) return;
  surface.destroyed = true;
  identitySurfaces.delete(surface.anchorId);
  identitySurfaceByWebContents.delete(surface.view.webContents.id);
  try { currentWindow?.contentView.removeChildView(surface.view); } catch {}
  try { surface.view.webContents.close(); } catch {}
}

function destroyAllIdentitySurfaces() {
  for (const surface of [...identitySurfaces.values()]) destroyIdentitySurface(surface);
  identitySurfaces.clear();
  identitySurfaceByWebContents.clear();
}

function createIdentitySurface(context, anchor) {
  if (!currentWindow || currentWindow.isDestroyed()) return null;
  const view = new WebContentsView({
    webPreferences: {
      preload: IDENTITY_CONTROL_PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false
    }
  });
  const surface = {
    anchorId: anchor.id,
    context,
    view,
    baseBounds: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
    destroyed: false
  };
  identitySurfaces.set(surface.anchorId, surface);
  identitySurfaceByWebContents.set(view.webContents.id, surface);
  currentWindow.contentView.addChildView(view);
  applyIdentitySurfaceLayout(surface);
  try { view.setBackgroundColor('#00000000'); } catch {}
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event) => event.preventDefault());
  void view.webContents.loadFile(IDENTITY_CONTROL_HTML).then(() => applyIdentitySurfaceLayout(surface));
  return surface;
}

function updateIdentitySurface(surface, anchor) {
  surface.baseBounds = { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height };
  applyIdentitySurfaceLayout(surface);
}

ipcMain.on('wurst:identity:anchors', (event, rawAnchors) => {
  if (!currentContext || !currentWindow || currentWindow.isDestroyed() || event.sender.id !== currentWindow.webContents.id) return;
  const anchors = Array.isArray(rawAnchors) ? rawAnchors.slice(0, 8) : [];
  const seen = new Set();
  for (const raw of anchors) {
    const id = String(raw?.id ?? '').slice(0, 80);
    const width = Math.round(Number(raw?.width));
    const height = Math.round(Number(raw?.height));
    const x = Math.round(Number(raw?.x));
    const y = Math.round(Number(raw?.y));
    if (!id || !raw?.visible || !Number.isFinite(width) || !Number.isFinite(height) || width < 190 || height < 50) continue;
    if (![x, y].every(Number.isFinite)) continue;
    const anchor = { id, width, height, x, y };
    seen.add(id);
    const existing = identitySurfaces.get(id);
    if (existing) updateIdentitySurface(existing, anchor);
    else createIdentitySurface(currentContext, anchor);
  }
  for (const [id, surface] of [...identitySurfaces]) if (!seen.has(id)) destroyIdentitySurface(surface);
});

ipcMain.handle('wurster:identity-control:context', async (event) => {
  const surface = identitySurfaceForEvent(event);
  return {
    id: surface.context.manifest.id,
    name: surface.context.manifest.name,
    version: surface.context.manifest.version,
    trust: secureTrustPresentation(surface.context)
  };
});

ipcMain.handle('wurster:identity-control:verify', async (event) => {
  const surface = identitySurfaceForEvent(event);
  await showIdentityVerificationForContext(surface.context);
  return true;
});

function protectionSessionBinding(context) {
  return context.runtimeBinding;
}

function activeProtectionSession(context, purpose) {
  if (!context?.runtimeBinding) return null;
  return unlockSessions.get(protectionSessionBinding(context), purpose);
}

function activeApplicationProtectionHandle(context) {
  const grant = activeProtectionSession(context, 'application');
  return grant?.secretHandle === context?.applicationProtectionHandle ? context.applicationProtectionHandle : null;
}

function scheduleProtectionSessionExpiry(context, grant) {
  if (context.applicationSessionTimer) clearTimeout(context.applicationSessionTimer);
  const delay = Math.max(0, grant.expiresAt - Date.now()) + 20;
  context.applicationSessionTimer = setTimeout(async () => {
    context.applicationSessionTimer = null;
    const active = activeProtectionSession(context, 'application');
    if (active) return;
    if (context.applicationProtectionHandle === grant.secretHandle) {
      await protectionClient.destroy(context.applicationProtectionHandle).catch(() => {});
      context.applicationProtectionHandle = null;
      context.sealedAppMap = null;
    }
  }, Math.min(delay, 0x7fffffff));
}

function grantApplicationProtectionSession(context, handle, requestedSession = null, metadata = null) {
  const grant = unlockSessions.grant({
    binding: protectionSessionBinding(context),
    purpose: 'application',
    scopes: ['app:read'],
    requestedTtl: requestedSession || '60m',
    secretHandle: handle,
    metadata
  });
  scheduleProtectionSessionExpiry(context, grant);
  return grant;
}

async function unlockApplicationWithWurstKey(context, wurstKey, requestedSession = null) {
  if (!context.manifest?.security?.applicationKeyWrap) throw new Error('This Wurst has no WurstKey-protected application content');
  const active = activeProtectionSession(context, 'application');
  if (context.applicationProtectionHandle && active?.secretHandle === context.applicationProtectionHandle) return { handle: context.applicationProtectionHandle, session: unlockSessions.status(protectionSessionBinding(context), 'application').session };
  if (context.applicationProtectionHandle) { await protectionClient.destroy(context.applicationProtectionHandle).catch(() => {}); context.applicationProtectionHandle = null; }
  const unlocked = await protectionClient.unlockApplication({ filePath: context.filePath, manifest: context.manifest, wurstKey });
  context.applicationProtectionHandle = unlocked.handle;
  context.sealedAppMap = null;
  const grant = grantApplicationProtectionSession(context, context.applicationProtectionHandle, requestedSession);
  return { handle: context.applicationProtectionHandle, session: unlockSessions.status(protectionSessionBinding(context), 'application').session, grantId: grant.id };
}

async function completeAuthSurface(surface, secret, identity = null) {
  if (surface.type === 'identity') {
    const normalizedSecret = normalizeMeatphrase(secret);
    const existingRecord = identity?.wursterIdentity ?? null;
    const material = deriveWursterIdentityMaterial(normalizedSecret, {
      name: existingRecord?.name ?? identity?.name ?? 'Personal Meat',
      emoji: existingRecord?.emoji ?? identity?.emoji ?? '🐷',
      claims: existingRecord?.claims ?? []
    });
    if (existingRecord && material.publicRecord.identityId !== existingRecord.identityId) throw new Error('Stored Meat Identity does not match its Wurster public identity');
    if (existingRecord) material.publicRecord = structuredClone(existingRecord);
    grantFilesystemIdentitySession(surface.context, material, identity, surface.session || '60m');
    if (identity?.id) await markIdentityUsed(identity.id);
    if (realmDataMode(surface.context.manifest) && surface.purpose === 'realm') {
      const target = String(surface.target ?? '').trim();
      if (!target) throw new Error('Realm authentication requires target="realm-id"');
      const store = await ensureWurstFsStore(surface.context);
      if (!store.root) {
        await store.initialize({
          actor: material,
          rootAdmins: [material.publicRecord.identityId],
          realms: realmTemplatesForRuntime(surface.context, material)
        });
        await refreshWurstFsContext(surface.context);
      }
      await ensureRealmUnlockedForIdentity(surface.context, target, material);
    }
    sendAuthResultToWurst(surface, true, { identity: surface.context.identitySession });
    return;
  }
  if (surface.type === 'wurstkey') {
    await unlockApplicationWithWurstKey(surface.context, normalizeWurstKey(secret), surface.session || '60m');
    sendAuthResultToWurst(surface, true);
    if (fullySealedApplication(surface.context.manifest) && surface.context.bootstrapWindow === currentWindow) {
      const map = await sealedApplicationMap(surface.context);
      await currentWindow.loadURL(`wurst://app/${map.entry}`);
    }
    return;
  }
  throw new Error('Unsupported Wurster Auth type');
}

ipcMain.handle('wurster:auth:context', async (event) => {
  const surface = authSurfaceForEvent(event);
  const storedIdentityAllowed = surface.context.manifest?.protection?.storedIdentity !== false;
  const identities = surface.type === 'identity' && storedIdentityAllowed ? await listMeatIdentities() : [];
  const preferred = surface.context.identitySession
    ? identities.find((item) => item.id === surface.context.identitySession.id) ?? null
    : null;
  return {
    type: surface.type,
    purpose: surface.purpose,
    target: surface.target || null,
    identities,
    preferredIdentity: preferred,
    devicePresenceAvailable: devicePresenceAvailable(),
    meatLockerAvailable: surface.type === 'identity' && storedIdentityAllowed && meatLockerAvailable(),
    trust: secureTrustPresentation(surface.context)
  };
});


ipcMain.handle('wurster:auth:manage-identities', async (event) => {
  authSurfaceForEvent(event);
  return Boolean(await openProtectedSettingsWindow());
});

ipcMain.handle('wurster:auth:expanded', async (event, expanded) => {
  const surface = authSurfaceForEvent(event);
  surface.expanded = Boolean(expanded);
  applyAuthSurfaceLayout(surface);
  return true;
});

ipcMain.handle('wurster:auth:manual', async (event, value) => {
  const surface = authSurfaceForEvent(event);
  try {
    if (surface.type === 'identity') await completeAuthSurface(surface, normalizeMeatphrase(value));
    else await completeAuthSurface(surface, normalizeWurstKey(value));
    return { ok: true };
  } catch (error) {
    sendAuthResultToWurst(surface, false, { error: error.message });
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('wurster:auth:identity', async (event, identityId) => {
  const surface = authSurfaceForEvent(event);
  if (surface.type !== 'identity') return { ok: false, error: 'This Auth control does not accept Meat Identities' };
  try {
    if (surface.context.manifest?.protection?.storedIdentity === false) throw new Error('This Wurst requires direct Meatphrase entry');
    const prepared = await readIdentityForAuth(identityId);
    surface.pendingIdentity = prepared.summary;
    surface.pendingMeatphrase = prepared.meatphrase;
    if (prepared.identity.protection?.totp) return { ok: true, needsTotp: true };
    const secret = surface.pendingMeatphrase;
    surface.pendingMeatphrase = null;
    await completeAuthSurface(surface, secret, prepared.summary);
    return { ok: true, needsTotp: false };
  } catch (error) {
    surface.pendingMeatphrase = null;
    surface.pendingIdentity = null;
    sendAuthResultToWurst(surface, false, { error: error.message });
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('wurster:auth:totp', async (event, code) => {
  const surface = authSurfaceForEvent(event);
  try {
    if (!surface.pendingMeatphrase || !surface.pendingIdentity) throw new Error('No Meat Identity is awaiting authenticator verification');
    await verifyLockerTotp(code);
    const secret = surface.pendingMeatphrase;
    const identity = surface.pendingIdentity;
    surface.pendingMeatphrase = null;
    surface.pendingIdentity = null;
    await completeAuthSurface(surface, secret, identity);
    return { ok: true };
  } catch (error) {
    sendAuthResultToWurst(surface, false, { error: error.message });
    return { ok: false, error: error.message };
  }
});

async function clearCurrentContext() {
  for (const [requestId, pending] of pendingInterfaceInvocations) {
    if (pending.context !== currentContext) continue;
    clearTimeout(pending.timer);
    pending.reject(new Error('Wurst closed before action completed'));
    pendingInterfaceInvocations.delete(requestId);
  }

  destroyAllAuthSurfaces();
  destroyAllIdentitySurfaces();
  if (currentContext?.wurstFsHygieneTimer) clearTimeout(currentContext.wurstFsHygieneTimer);
  if (currentContext?.applicationSessionTimer) clearTimeout(currentContext.applicationSessionTimer);
  if (currentContext?.filesystemIdentityTimer) clearTimeout(currentContext.filesystemIdentityTimer);
  if (currentContext?.runtimeBinding) unlockSessions.revokeBinding(currentContext.runtimeBinding);
  if (currentContext) currentContext.closing = true;
  if (currentContext?.wurstFsStore?.closeFile) await currentContext.wurstFsStore.closeFile().catch(() => {});
  else if (currentContext?.wurstFsStore?.close) await currentContext.wurstFsStore.close().catch(() => {});
  if (currentContext?.applicationProtectionHandle) await protectionClient.destroy(currentContext.applicationProtectionHandle);
  if (currentContext?.reader) await currentContext.reader.close().catch(() => {});
  currentContext = null;
}

function metadataPackage(context) {
  return { manifest: context.manifest, index: context.reader.index, wurstFsRoot: context.reader.wurstFsRoot };
}

function assertWurstSender(event) {
  if (!currentWindow || currentWindow.isDestroyed() || event.sender.id !== currentWindow.webContents.id || !currentContext) {
    throw new Error('Invalid Wurst runtime caller');
  }
  return currentContext;
}

function realmDataMode(manifest) {
  return manifest?.data?.format === 'wurst/data-realms-1';
}

function filesystemMode(context) {
  return realmDataMode(context?.manifest) ? 'realms' : 'none';
}

function activeFilesystemIdentity(context) {
  if (!context?.wurstIdentityMaterial) return null;
  const grant = unlockSessions.get(protectionSessionBinding(context), 'filesystem-identity');
  if (grant) return context.wurstIdentityMaterial;
  context.wurstIdentityMaterial = null;
  if (context.identitySession?.kind === 'wurster-identity') context.identitySession = null;
  if (context.wurstFsStore?.realmKeys) {
    for (const realmId of [...context.wurstFsStore.realmKeys.keys()]) context.wurstFsStore.lockRealm(realmId);
  }
  return null;
}

function scheduleFilesystemIdentityExpiry(context, grant) {
  if (context.filesystemIdentityTimer) clearTimeout(context.filesystemIdentityTimer);
  const delay = Math.max(0, Number(grant.expiresAt) - Date.now());
  context.filesystemIdentityTimer = setTimeout(() => {
    const active = unlockSessions.get(protectionSessionBinding(context), 'filesystem-identity');
    if (active?.id !== grant.id) return;
    unlockSessions.revoke(protectionSessionBinding(context), 'filesystem-identity');
    context.wurstIdentityMaterial = null;
    if (context.identitySession?.kind === 'wurster-identity') context.identitySession = null;
    if (context.wurstFsStore?.realmKeys) {
      for (const realmId of [...context.wurstFsStore.realmKeys.keys()]) context.wurstFsStore.lockRealm(realmId);
    }
  }, Math.min(delay, 0x7fffffff));
}

function grantFilesystemIdentitySession(context, material, identity = null, requestedSession = null) {
  if (!material?.publicRecord) throw new Error('Wurster filesystem identity material is missing');
  const grant = unlockSessions.grant({
    binding: protectionSessionBinding(context),
    purpose: 'filesystem-identity',
    scopes: ['fs:identity', 'fs:sign', 'fs:decrypt'],
    requestedTtl: requestedSession || '60m',
    metadata: { identityId: material.publicRecord.identityId }
  });
  context.wurstIdentityMaterial = material;
  context.identitySession = {
    kind: 'wurster-identity',
    id: identity?.id ?? null,
    name: identity?.name ?? material.publicRecord.name,
    emoji: identity?.emoji ?? material.publicRecord.emoji ?? '🐷',
    wursterIdentity: structuredClone(material.publicRecord),
    expiresAt: grant.expiresAt
  };
  scheduleFilesystemIdentityExpiry(context, grant);
  return grant;
}

async function ensureWurstFsStore(context) {
  if (!realmDataMode(context.manifest)) throw new Error('This Wurst does not use WurstFS realms');
  if (context.wurstFsStore) return context.wurstFsStore;
  if (context.reader.carrier) throw new Error('WurstFS realm writes are not available for carrier Wursts');
  context.wurstFsStore = await openLocalWurstFsStore(context.filePath, context.reader);
  return context.wurstFsStore;
}

async function ensureWurstFsInitializedForWrite(context) {
  const store = await ensureWurstFsStore(context);
  if (store.root) return store;
  const actor = activeFilesystemIdentity(context);
  if (!actor && realmTemplatesNeedIdentity(context)) {
    const error = new Error('Authenticate a Wurster Identity before initializing identity-backed WurstFS realms');
    error.code = 'WURST_AUTH_REQUIRED';
    throw error;
  }
  await store.initialize({
    actor,
    rootAdmins: actor ? [actor.publicRecord.identityId] : [],
    realms: realmTemplatesForRuntime(context, actor)
  });
  await refreshWurstFsContext(context);
  return store;
}

async function ensureRealmUnlockedForIdentity(context, realmId, material = activeFilesystemIdentity(context)) {
  const store = await ensureWurstFsStore(context);
  const realm = store.realm(realmId);
  if (!realm) throw new Error(`Unknown WurstFS realm ${realmId}`);
  if (realm.protection === 'public') return { realm: realm.id, unlocked: true, public: true };
  if (!material) {
    const error = new Error(`WurstFS realm ${realm.id} requires a Wurster Identity`);
    error.code = 'WURST_AUTH_REQUIRED';
    throw error;
  }
  if (wurstFsRealmGovernance(realm) === 'personal' && !realm.claimed) {
    await store.claimPersonalRealm(realm.id, { actor: material });
    await refreshWurstFsContext(context);
    return { realm: realm.id, unlocked: true, claimed: true, identity: material.publicRecord.identityId };
  }
  return store.unlockRealm(realm.id, material);
}

function realmReadOptions(context, fsPath) {
  if (!realmDataMode(context.manifest) || context.reader.wurstFsRoot?.format !== 'wurst/fs-2') return {};
  const normalized = String(fsPath ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts[0] !== 'data' || parts.length < 2) return { realmKeys: context.wurstFsStore?.realmKeys ?? new Map() };
  const realmId = parts[1].toLowerCase();
  const realmKey = context.wurstFsStore?.realmKeys?.get(realmId) ?? null;
  return { realmKey, realmKeys: context.wurstFsStore?.realmKeys ?? new Map() };
}

function packageHasProtectedApp(context) {
  return context.reader.entries().some((entry) => (entry.scope ?? 'app') === 'app' && Boolean(entry.encryption));
}

async function waitForWurstFsMaintenance(context) {
  if (context.wurstFsMaintenance) await context.wurstFsMaintenance;
}

async function currentWurstFsUsage(context) {
  const root = context.reader.wurstFsRoot;
  if (!root) {
    return {
      physicalBytes: Math.max(0, context.reader.source.size - context.reader.baseLength),
      liveBytes: 0,
      reclaimableBytes: 0,
      logicalBytes: 0,
      files: 0,
      directories: 0,
      historyMode: 'none'
    };
  }
  return measureWurstFs2Storage(context.reader.source, root, {
    baseOffset: context.reader.baseLength,
    commitOffset: context.reader.wurstFsCommitOffset,
    realmKeys: context.wurstFsStore?.realmKeys ?? new Map()
  });
}

async function compactCurrentWurstFs(context, { reason = 'manual' } = {}) {
  if (context.reader.carrier) return { compacted: false, reason: 'carrier-read-only' };
  if (!realmDataMode(context.manifest)) return { compacted: false, reason: 'no-data' };
  if (context.reader.wurstFsRoot?.historyMode === 'integrity') return { compacted: false, reason: 'integrity-history-retained' };
  if (!context.manifest.data?.writable) return { compacted: false, reason: 'read-only' };
  if (context.wurstFsMaintenance) return context.wurstFsMaintenance;
  if (context.wurstFsStore?.sessions?.size) return { compacted: false, reason: 'write-in-progress' };

  const task = (async () => {
    const originalReader = context.reader;
    const originalCommit = originalReader.wurstFsCommitOffset ?? null;
    const store = await ensureWurstFsStore(context);
    for (const realm of Object.values(store.root?.realms ?? {})) {
      if (realm.protection !== 'sealed' || store.realmKeys.has(realm.id)) continue;
      if (wurstFsRealmGovernance(realm) === 'personal' && realm.claimed === false && !(realm.catalogPages?.length)) continue;
      const material = activeFilesystemIdentity(context);
      if (!material) {
        const error = new Error(`Unlock sealed realm ${realm.id} before compaction`);
        error.code = 'WURST_AUTH_REQUIRED';
        throw error;
      }
      store.unlockRealm(realm.id, material);
    }
    const callbacks = { realmKeys: store.realmKeys };
    const tempPath = `${context.filePath}.compact-${process.pid}-${crypto.randomUUID()}.tmp`;
    const backupPath = `${context.filePath}.compact-backup-${process.pid}-${crypto.randomUUID()}`;
    let swapped = false;
    try {
      const usageBefore = await currentWurstFsUsage(context);
      if (usageBefore.reclaimableBytes <= 0) return { compacted: false, reason: 'already-compact', ...usageBefore };

      const result = await writeCompactedWurstFile(tempPath, originalReader, callbacks);

      // No writer may have published another generation while the compact copy
      // was being prepared. Reads remain available throughout the long copy.
      await originalReader.refreshWurstFs();
      if ((originalReader.wurstFsCommitOffset ?? null) !== originalCommit || context.wurstFsStore?.sessions?.size) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        return { compacted: false, reason: 'changed-during-compaction' };
      }

      if (context.wurstFsStore?.closeFile) await context.wurstFsStore.closeFile();
      else if (context.wurstFsStore?.close) await context.wurstFsStore.close();
      context.wurstFsStore = null;
      await originalReader.close();

      try {
        await fs.rename(context.filePath, backupPath);
        await fs.rename(tempPath, context.filePath);
        swapped = true;
      } catch (error) {
        if (!swapped) {
          const backupExists = await fs.stat(backupPath).then(() => true).catch(() => false);
          const originalExists = await fs.stat(context.filePath).then(() => true).catch(() => false);
          if (backupExists && !originalExists) await fs.rename(backupPath, context.filePath).catch(() => {});
        }
        throw error;
      }

      const replacement = await openWurstFile(context.filePath);
      context.reader = replacement;
      context.pkg = null;
      await fs.rm(backupPath, { force: true }).catch(() => {});

      return {
        compacted: true,
        reason,
        oldSize: result.oldSize,
        newSize: result.newSize,
        reclaimedBytes: result.reclaimedBytes,
        generation: replacement.wurstFsRoot?.generation ?? 0
      };
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      if (!context.reader || context.reader === originalReader) {
        const usable = await fs.stat(context.filePath).then(() => true).catch(() => false);
        if (usable) {
          try { context.reader = await openWurstFile(context.filePath); } catch {}
        }
      }
      throw error;
    } finally {
      context.wurstFsMaintenance = null;
    }
  })();
  context.wurstFsMaintenance = task;
  return task;
}

function scheduleWurstFsHygiene(context, delay = 1800) {
  if (!context || !realmDataMode(context.manifest) || context.reader.carrier || !context.manifest.data?.writable) return;
  if (context.reader.wurstFsRoot?.format === 'wurst/fs-2' && context.reader.wurstFsRoot.historyMode === 'integrity') return;
  if (context.wurstFsHygieneTimer) clearTimeout(context.wurstFsHygieneTimer);
  context.wurstFsHygieneTimer = setTimeout(async () => {
    context.wurstFsHygieneTimer = null;
    try {
      if (context !== currentContext || context.wurstFsMaintenance || context.wurstFsStore?.sessions?.size) return;
      if (Object.values(context.reader.wurstFsRoot?.realms ?? {}).some((realm) => realm.protection === 'sealed' && !context.wurstFsStore?.realmKeys?.has(realm.id))) return;
      const usage = await currentWurstFsUsage(context);
      const enoughWaste = usage.reclaimableBytes >= 32 * 1024 * 1024;
      const wasteRatio = usage.physicalBytes > 0 ? usage.reclaimableBytes / usage.physicalBytes : 0;
      if (enoughWaste && wasteRatio >= 0.25) await compactCurrentWurstFs(context, { reason: 'runtime-hygiene' });
    } catch {
      // Hygiene must never make a healthy Wurst fail to run. Manual compact()
      // still surfaces errors to the application when it wants explicit control.
    }
  }, delay);
}

async function refreshWurstFsContext(context) {
  await context.reader.refreshWurstFs();
  context.pkg = null;
}

function assertRuntimeCapability(context, name) {
  const capabilities = normalizeCapabilities(context.manifest.capabilities);
  if (!capabilities[name] || !SUPPORTED_CAPABILITIES.has(name)) throw new Error(`Wurst capability not available: ${name}`);
}

function sanitizedDialogExtensions(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value ?? '').trim().replace(/^\./, '').toLowerCase())
    .filter((value) => /^[a-z0-9][a-z0-9._+-]{0,15}$/.test(value)))].slice(0, 12);
}

function userFileDialogFilters(options = {}) {
  const extensions = sanitizedDialogExtensions(options.extensions);
  if (!extensions.length) return undefined;
  const label = String(options.label ?? 'Files').trim().slice(0, 80) || 'Files';
  return [{ name: label, extensions }];
}

function contextProtectionStatus(context) {
  const protectedEntries = context.reader.entries().filter((entry) => Boolean(entry.encryption));
  const protectedAppEntries = protectedEntries.filter((entry) => (entry.scope ?? 'app') === 'app');
  return {
    application: context.manifest?.application?.protection ?? 'public',
    hasProtectedContent: protectedEntries.length > 0,
    protectedAppResources: protectedAppEntries.length,
    applicationUnlocked: Boolean(activeApplicationProtectionHandle(context)),
    storedIdentityAllowed: context.manifest?.protection?.storedIdentity !== false
  };
}

ipcMain.handle('wurst:auth:status', async (event, rawPurpose = 'identity') => {
  const context = assertWurstSender(event);
  const purpose = String(rawPurpose || 'identity').toLowerCase();
  if (purpose === 'application') {
    const required = fullySealedApplication(context.manifest) || Boolean(context.manifest?.security?.applicationKeyWrap);
    const state = required ? unlockSessions.status(protectionSessionBinding(context), 'application') : { state: 'not-required', session: null };
    return {
      purpose: 'application',
      state: state.state,
      protection: required ? 'wurstkey' : 'public',
      identity: null,
      session: state.session
    };
  }
  if (!['identity', 'filesystem', 'realm'].includes(purpose)) throw new Error(`Unsupported Wurster Auth purpose: ${purpose}`);
  activeFilesystemIdentity(context);
  const state = unlockSessions.status(protectionSessionBinding(context), 'filesystem-identity');
  return {
    purpose,
    state: state.state,
    protection: 'wurster-identity',
    identity: context.identitySession ? structuredClone(context.identitySession) : null,
    session: state.session
  };
});

ipcMain.handle('wurst:identity:session', async (event) => {
  const context = assertWurstSender(event);
  if (realmDataMode(context.manifest)) activeFilesystemIdentity(context);
  return context.identitySession ? structuredClone(context.identitySession) : null;
});

ipcMain.handle('wurst:window:close', async (event) => {
  assertWurstSender(event);
  currentWindow?.close();
  return true;
});

ipcMain.handle('wurst:window:minimize', async (event) => {
  assertWurstSender(event);
  currentWindow?.minimize();
  return true;
});

ipcMain.handle('wurst:files:open', async (event, options = {}) => {
  const context = assertWurstSender(event);
  assertRuntimeCapability(context, 'files.open');
  const result = await dialog.showOpenDialog(currentWindow, {
    title: String(options.title ?? 'Open file').slice(0, 120),
    properties: ['openFile'],
    filters: userFileDialogFilters(options)
  });
  if (result.canceled || !result.filePaths?.[0]) return { opened: false };
  const filePath = path.resolve(result.filePaths[0]);
  const stat = await fs.stat(filePath);
  const maxBytes = Math.min(256 * 1024 * 1024, Math.max(1, Number(options.maxBytes) || 64 * 1024 * 1024));
  if (!stat.isFile()) throw new Error('Selected path is not a regular file');
  if (stat.size > maxBytes) throw new Error(`Selected file is too large (${stat.size} bytes; limit ${maxBytes})`);
  const data = await fs.readFile(filePath);
  return { opened: true, name: path.basename(filePath), size: data.length, data };
});

ipcMain.handle('wurst:files:save', async (event, options = {}, payload) => {
  const context = assertWurstSender(event);
  assertRuntimeCapability(context, 'files.save');
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload instanceof Uint8Array ? payload : new Uint8Array(payload ?? []));
  if (bytes.length > 256 * 1024 * 1024) throw new Error('Refusing to save more than 256 MiB in one Wurst file operation');
  const requestedName = path.basename(String(options.suggestedName ?? 'wurst-output.bin')).slice(0, 180) || 'wurst-output.bin';
  const result = await dialog.showSaveDialog(currentWindow, {
    title: String(options.title ?? 'Save file').slice(0, 120),
    defaultPath: requestedName,
    filters: userFileDialogFilters(options)
  });
  if (result.canceled || !result.filePath) return { saved: false };
  const destination = path.resolve(result.filePath);
  const tempPath = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(tempPath, bytes, { flag: 'wx' });
  try {
    await fs.rm(destination, { force: true });
    await fs.rename(tempPath, destination);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return { saved: true, name: path.basename(destination), bytes: bytes.length };
});

ipcMain.handle('wurst:snapshot:export', async (event) => {
  const context = assertWurstSender(event);
  const safeName = String(context.manifest.name ?? 'snapshot')
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'snapshot';
  const result = await dialog.showSaveDialog(currentWindow, {
    title: 'Export Wurst Snapshot',
    defaultPath: `${safeName}.wurst`,
    filters: [{ name: 'Wurst', extensions: ['wurst', 'wrst'] }]
  });
  if (result.canceled || !result.filePath) return { saved: false };

  const destination = path.resolve(result.filePath);
  const sourcePath = path.resolve(context.filePath);
  if (!context.reader.carrier && destination === sourcePath) {
    // The current raw file already *is* the committed standalone snapshot.
    return { saved: true };
  }
  if (context.reader.carrier && destination === sourcePath) {
    throw new Error('Choose a different path when exporting a carrier Wurst as standalone .wurst');
  }

  // Export the committed virtual WRST stream in bounded slices. This works for
  // raw local Wursts and read-only carriers without materializing the complete
  // package in RAM. A future remote source can use the exact same path.
  const tempPath = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const target = await fs.open(tempPath, 'wx');
  let completed = false;
  try {
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < context.reader.source.size; offset += chunkSize) {
      const length = Math.min(chunkSize, context.reader.source.size - offset);
      const chunk = await context.reader.source.read(offset, length);
      let written = 0;
      while (written < chunk.length) {
        const step = await target.write(chunk, written, chunk.length - written, null);
        if (step.bytesWritten <= 0) throw new Error('Could not write Wurst snapshot');
        written += step.bytesWritten;
      }
    }
    await target.sync();
    completed = true;
  } finally {
    await target.close();
    if (!completed) await fs.rm(tempPath, { force: true }).catch(() => {});
  }
  // Save dialog already handled overwrite intent. Rename only after the complete
  // snapshot is durable so a failed export never leaves half a Wurst behind.
  await fs.rm(destination, { force: true });
  await fs.rename(tempPath, destination);
  return { saved: true };
});

ipcMain.handle('wurst:info', async (event) => {
  const context = assertWurstSender(event);
  return {
    id: context.manifest.id,
    name: context.manifest.name,
    version: context.manifest.version,
    type: context.manifest.type,
    risk: context.risk.level,
    capabilities: normalizeCapabilities(context.manifest.capabilities),
    capabilityRuntime: runtimeCapabilityStates(context.manifest),
    application: context.manifest.application ?? { protection: 'public' },
    protection: contextProtectionStatus(context),
    presentation: context.manifest.presentation ?? null,
    interface: context.manifest.interface ? {
      format: context.manifest.interface.format,
      headless: Boolean(context.manifest.interface.headless),
      actions: context.manifest.interface.actions ?? {},
      events: context.manifest.interface.events ?? {}
    } : null,
    signature: {
      status: context.signature.status,
      publisher: context.signature.publisher ?? null,
      trusted: Boolean(context.publisherTrust?.trusted),
      trust: context.publisherTrust ? {
        kind: context.publisherTrust.kind,
        authority: context.publisherTrust.authority ?? null,
        domain: context.publisherTrust.domain ?? null,
        development: Boolean(context.publisherTrust.development)
      } : null
    }
  };
});

ipcMain.handle('wurst:capabilities:query', async (event, name) => {
  const context = assertWurstSender(event);
  return runtimeCapabilityState(context.manifest, name);
});

ipcMain.handle('wurst:capabilities:list', async (event) => {
  const context = assertWurstSender(event);
  return runtimeCapabilityStates(context.manifest);
});

ipcMain.handle('wurst:interface:describe', async (event) => {
  const context = assertWurstSender(event);
  return context.manifest.interface ?? null;
});

async function invokeContextInterfaceAction(context, rawName, payload = {}) {
  const declaration = context.manifest.interface;
  const name = String(rawName ?? '');
  const spec = declaration?.actions?.[name];
  if (!spec) throw new Error(`Unknown Wurst action: ${name}`);
  validateJsonValue(payload, spec.input, '$input');
  if (!currentWindow || currentWindow.isDestroyed() || currentContext !== context) throw new Error('Wurst renderer is not available');
  const requestId = `wi-${nextInterfaceRequestId++}`;
  const timeoutMs = Math.min(Number(spec.timeoutMs ?? 5000), 60000);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingInterfaceInvocations.delete(requestId);
      reject(new Error(`Wurst action exceeded ${timeoutMs} ms: ${name}`));
    }, timeoutMs);
    pendingInterfaceInvocations.set(requestId, { context, name, spec, resolve, reject, timer });
    currentWindow.webContents.send('wurst:interface:invoke-request', { requestId, name, input: payload });
  });
}

ipcMain.handle('wurst:interface:invoke', async (event, name, payload = {}) => {
  const context = assertWurstSender(event);
  return invokeContextInterfaceAction(context, name, payload);
});

ipcMain.on('wurst:interface:invoke-result', (event, message = {}) => {
  const context = assertWurstSender(event);
  const requestId = String(message.requestId ?? '');
  const pending = pendingInterfaceInvocations.get(requestId);
  if (!pending || pending.context !== context) return;
  pendingInterfaceInvocations.delete(requestId);
  clearTimeout(pending.timer);
  if (!message.ok) {
    pending.reject(new Error(String(message.error ?? `Wurst action failed: ${pending.name}`)));
    return;
  }
  try {
    const result = message.result == null ? null : structuredClone(message.result);
    if (pending.spec.output) validateJsonValue(result, pending.spec.output, '$output');
    pending.resolve(result);
  } catch (error) {
    pending.reject(error);
  }
});

ipcMain.on('wurst:interface:event', (event, rawName, payload) => {
  const context = assertWurstSender(event);
  const name = String(rawName ?? '');
  const spec = context.manifest.interface?.events?.[name];
  if (!spec) return;
  try {
    if (spec.payload) validateJsonValue(payload, spec.payload, '$event');
    context.lastInterfaceEvent = { name, payload: structuredClone(payload), at: Date.now() };
  } catch {
    // Invalid events never cross the runtime boundary.
  }
});

async function fsReadOptions(context, fsPath = '/data') {
  if (!realmDataMode(context.manifest)) throw new Error('This Wurst has no /data filesystem');
  return realmReadOptions(context, dataFsPath(fsPath));
}

function realmTemplateGovernance(template = {}) {
  const governance = String(template?.governance ?? '').trim().toLowerCase();
  if (!governance) return 'ordinary';
  if (!['personal', 'shared'].includes(governance)) throw new Error(`Unsupported WurstFS realm governance: ${governance}`);
  return governance;
}

function realmTemplatesNeedIdentity(context) {
  // Personal realms can ship empty/unclaimed. Only shared genesis needs an
  // authenticated owner up front.
  return (context.manifest.data?.realms ?? []).some((template) => realmTemplateGovernance(template) === 'shared');
}

function realmTemplatesForRuntime(context, actor) {
  const actorId = actor?.publicRecord?.identityId ?? null;
  const templates = Array.isArray(context.manifest.data?.realms) ? context.manifest.data.realms : [];
  if (!templates.length) throw new Error('This Wurst declares no initial WurstFS realm templates');
  return templates.map((template) => {
    const governance = realmTemplateGovernance(template);
    if (governance === 'shared' && !actorId) {
      const error = new Error(`Shared WurstFS realm ${template.id} requires an authenticated Wurster Identity`);
      error.code = 'WURST_AUTH_REQUIRED';
      throw error;
    }
    if (governance === 'ordinary') {
      return { id: template.id, label: template.label ?? template.id };
    }
    if (governance === 'personal') {
      return { id: template.id, label: template.label ?? template.id, governance: 'personal' };
    }
    const protection = String(template.protection ?? 'public');
    const read = String(template.read ?? (protection === 'sealed' ? 'owner' : 'public'));
    const write = String(template.write ?? 'owner');
    return {
      id: template.id,
      label: template.label ?? template.id,
      governance: 'shared',
      audit: String(template.audit ?? 'none'),
      protection,
      access: {
        read: read === 'public' ? { mode: 'public' } : { mode: 'members', identities: [actorId] },
        write: write === 'authenticated'
          ? { mode: 'authenticated' }
          : { mode: 'members', identities: [actorId] },
        admins: [actorId]
      }
    };
  });
}

function realmRuntimeSummary(context) {
  const root = context.reader.wurstFsRoot?.format === 'wurst/fs-2' ? context.reader.wurstFsRoot : null;
  const identity = activeFilesystemIdentity(context);
  const identityId = identity?.publicRecord?.identityId ?? null;
  if (!root) {
    return (context.manifest.data?.realms ?? []).map((template) => ({
      id: template.id,
      label: template.label ?? template.id,
      governance: realmTemplateGovernance(template),
      audit: realmTemplateGovernance(template) === 'shared' ? String(template.audit ?? 'none') : 'none',
      protection: realmTemplateGovernance(template) === 'personal' ? 'sealed' : (template.protection ?? 'public'),
      claimed: realmTemplateGovernance(template) === 'personal' ? false : true,
      initialized: false,
      locked: realmTemplateGovernance(template) === 'personal' || template.protection === 'sealed',
      capabilities: { read: false, write: false, admin: false }
    }));
  }
  return Object.values(root.realms ?? {}).sort((a, b) => a.id.localeCompare(b.id)).map((realm) => {
    const capabilities = wurstFsRealmCapabilities(realm, identityId, { signedIdentity: Boolean(identityId) });
    return {
      id: realm.id,
      label: realm.label ?? realm.id,
      governance: wurstFsRealmGovernance(realm),
      claimed: wurstFsRealmGovernance(realm) === 'personal' ? Boolean(realm.claimed) : true,
      audit: realm.audit ?? 'none',
      protection: realm.protection,
      initialized: true,
      locked: realm.protection === 'sealed' && !context.wurstFsStore?.realmKeys?.has(realm.id),
      capabilities,
      readers: realm.access?.read?.mode === 'members' ? [...realm.access.read.identities] : null,
      writers: realm.access?.write?.mode === 'members' ? [...realm.access.write.identities] : realm.access?.write?.mode ?? 'members',
      admins: [...(realm.access?.admins ?? [])]
    };
  });
}

ipcMain.handle('wurst:fs:capabilities', async (event) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) {
    return {
      read: false,
      write: false,
      persistent: false,
      snapshot: false,
      mediaUrls: false,
      compact: false,
      protection: 'none',
      format: null,
      realms: false,
      signedMutations: false,
      root: '/data'
    };
  }
  return {
    read: true,
    write: Boolean(context.manifest.data?.writable && !context.reader.carrier),
    persistent: true,
    snapshot: true,
    mediaUrls: true,
    compact: !context.reader.carrier && ((context.reader.wurstFsRoot?.historyMode ?? null) === 'none' || (!context.reader.wurstFsRoot && !(context.manifest.data?.realms ?? []).some((realm) => realmTemplateGovernance(realm) === 'shared'))),
    protection: 'realms',
    format: 'wurst/fs-2',
    realms: true,
    signedMutations: (context.reader.wurstFsRoot?.historyMode ?? null) === 'integrity',
    defaultStorage: 'ordinary',
    root: '/data'
  };
});

ipcMain.handle('wurst:fs:realms', async (event) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) return [];
  return realmRuntimeSummary(context);
});

ipcMain.handle('wurst:fs:initialize', async (event) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) throw new Error('This Wurst does not declare WurstFS realms');
  if (context.reader.wurstFsRoot) return { initialized: false, generation: context.reader.wurstFsRoot.generation, realms: realmRuntimeSummary(context) };
  const actor = activeFilesystemIdentity(context);
  if (!actor && realmTemplatesNeedIdentity(context)) {
    const error = new Error('Authenticate a Wurster Identity before initializing shared WurstFS realms');
    error.code = 'WURST_AUTH_REQUIRED';
    throw error;
  }
  const store = await ensureWurstFsStore(context);
  await store.initialize({
    actor,
    rootAdmins: actor ? [actor.publicRecord.identityId] : [],
    realms: realmTemplatesForRuntime(context, actor)
  });
  await refreshWurstFsContext(context);
  return { initialized: true, generation: context.reader.wurstFsRoot?.generation ?? 1, realms: realmRuntimeSummary(context) };
});

ipcMain.handle('wurst:fs:unlock-realm', async (event, rawRealmId) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) throw new Error('This Wurst does not use WurstFS realms');
  const material = activeFilesystemIdentity(context);
  if (!material) {
    const error = new Error('Authenticate a Wurster Identity before unlocking a realm');
    error.code = 'WURST_AUTH_REQUIRED';
    throw error;
  }
  const result = await ensureRealmUnlockedForIdentity(context, String(rawRealmId ?? ''), material);
  return { ...result, realms: realmRuntimeSummary(context) };
});

ipcMain.handle('wurst:fs:lock-realm', async (event, rawRealmId) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) return { locked: false, realms: [] };
  const store = await ensureWurstFsStore(context);
  const locked = store.lockRealm(String(rawRealmId ?? ''));
  return { locked: Boolean(locked), realms: realmRuntimeSummary(context) };
});

ipcMain.handle('wurst:fs:history', async (event) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest) || !context.reader.wurstFsRoot) return null;
  return context.reader.fsHistory();
});

ipcMain.handle('wurst:fs:usage', async (event) => {
  const context = assertWurstSender(event);
  return currentWurstFsUsage(context);
});

ipcMain.handle('wurst:fs:compact', async (event) => {
  const context = assertWurstSender(event);
  return compactCurrentWurstFs(context, { reason: 'wurst-request' });
});

ipcMain.handle('wurst:fs:stat', async (event, rawPath) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) return null;
  const target = dataFsPath(rawPath);
  if (target === 'data') return { path: '/data', name: 'data', type: 'directory', size: 0, mime: null, revision: context.reader.wurstFsRoot?.generation ?? 0 };
  if (!context.reader.wurstFsRoot) return null;
  const entry = await context.reader.fsStat(target, await fsReadOptions(context, target));
  if (!entry) return null;
  return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
});

ipcMain.handle('wurst:fs:list', async (event, rawPath = '/data') => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest) || !context.reader.wurstFsRoot) return [];
  const target = dataFsPath(rawPath || '/data');
  const entries = await context.reader.fsList(target, await fsReadOptions(context, target));
  return entries.map((entry) => entry.path?.startsWith('/') ? entry : ({ ...entry, path: `/${entry.path}` }));
});

ipcMain.handle('wurst:fs:read', async (event, rawPath, options = {}) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest) || !context.reader.wurstFsRoot) return null;
  const target = dataFsPath(rawPath);
  const cryptoOptions = await fsReadOptions(context, target);
  const stat = await context.reader.fsStat(target, cryptoOptions);
  if (!stat || stat.type !== 'file') return null;
  const offset = Number(options?.offset ?? 0);
  const requested = options?.length == null ? MAX_WURST_FS_SLICE_BYTES : Number(options.length);
  const length = Math.min(requested, MAX_WURST_FS_SLICE_BYTES);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid WurstFS read offset');
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid WurstFS read length');
  const result = await context.reader.fsReadRange(target, offset, length, cryptoOptions);
  return {
    path: stat.path?.startsWith('/') ? stat.path : `/${target}`,
    mime: stat.mime,
    size: stat.size,
    offset: result.offset,
    length: result.length,
    eof: result.eof,
    data: result.data
  };
});

ipcMain.handle('wurst:fs:begin-write', async (event, rawPath, options = {}) => {
  const context = assertWurstSender(event);
  await waitForWurstFsMaintenance(context);
  if (!realmDataMode(context.manifest) || !context.manifest.data?.writable || context.reader.carrier) throw new Error('This Wurst data filesystem is not writable');
  const target = dataFsPath(rawPath);
  if (target === 'data') throw new Error('Cannot write the WurstFS root');
  const mime = typeof options?.mime === 'string' && options.mime.length <= 160 && !/[\r\n]/.test(options.mime)
    ? options.mime
    : mimeFor(target);
  const store = await ensureWurstFsInitializedForWrite(context);
  const actor = activeFilesystemIdentity(context);
  const writeId = store.beginWrite(target, { actor, mime });
  return { id: writeId, path: `/${target}`, chunkSize: MAX_WURST_FS_CHUNK_BYTES, signedBy: actor?.publicRecord?.identityId ?? null };
});

ipcMain.handle('wurst:fs:write-chunk', async (event, rawId, payload) => {
  const context = assertWurstSender(event);
  const store = await ensureWurstFsStore(context);
  const bytes = Buffer.isBuffer(payload)
    ? payload
    : payload instanceof Uint8Array
      ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
      : payload instanceof ArrayBuffer
        ? Buffer.from(payload)
        : Buffer.from(payload ?? []);
  if (bytes.length > MAX_WURST_FS_CHUNK_BYTES) throw new Error('WurstFS chunks may not exceed 4 MiB');
  return store.writeChunk(rawId, bytes);
});

ipcMain.handle('wurst:fs:commit-write', async (event, rawId) => {
  const context = assertWurstSender(event);
  const store = await ensureWurstFsStore(context);
  const result = await store.commitWrite(rawId);
  await refreshWurstFsContext(context);
  scheduleWurstFsHygiene(context);
  const entry = result.entry;
  return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
});

ipcMain.handle('wurst:fs:abort-write', async (event, rawId) => {
  const context = assertWurstSender(event);
  return (await ensureWurstFsStore(context)).abortWrite(rawId);
});

ipcMain.handle('wurst:fs:remove', async (event, rawPath, options = {}) => {
  const context = assertWurstSender(event);
  await waitForWurstFsMaintenance(context);
  if (!realmDataMode(context.manifest) || !context.manifest.data?.writable || context.reader.carrier) throw new Error('This Wurst data filesystem is not writable');
  const store = await ensureWurstFsInitializedForWrite(context);
  const removed = await store.remove(dataFsPath(rawPath), { actor: activeFilesystemIdentity(context), recursive: Boolean(options?.recursive) });
  if (removed) { await refreshWurstFsContext(context); scheduleWurstFsHygiene(context, 700); }
  return removed;
});

ipcMain.handle('wurst:fs:mkdir', async (event, rawPath, options = {}) => {
  const context = assertWurstSender(event);
  await waitForWurstFsMaintenance(context);
  if (!realmDataMode(context.manifest) || !context.manifest.data?.writable || context.reader.carrier) throw new Error('This Wurst data filesystem is not writable');
  const store = await ensureWurstFsInitializedForWrite(context);
  const entry = await store.mkdir(dataFsPath(rawPath), { actor: activeFilesystemIdentity(context), recursive: options?.recursive !== false });
  await refreshWurstFsContext(context);
  scheduleWurstFsHygiene(context);
  return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
});

ipcMain.handle('wurst:fs:rename', async (event, rawFrom, rawTo) => {
  const context = assertWurstSender(event);
  await waitForWurstFsMaintenance(context);
  if (!realmDataMode(context.manifest) || !context.manifest.data?.writable || context.reader.carrier) throw new Error('This Wurst data filesystem is not writable');
  const store = await ensureWurstFsInitializedForWrite(context);
  const entry = await store.rename(dataFsPath(rawFrom), dataFsPath(rawTo), { actor: activeFilesystemIdentity(context) });
  if (!entry) return null;
  await refreshWurstFsContext(context);
  scheduleWurstFsHygiene(context);
  return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
});

function localStorageLabel() {
  if (!meatLockerAvailable()) return 'Unavailable';
  if (process.platform === 'darwin') return 'macOS Keychain';
  if (process.platform === 'win32') return 'Windows protected storage';
  try {
    const backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : null;
    return backend ? `Linux secure storage (${backend})` : 'OS secure storage';
  } catch {
    return 'OS secure storage';
  }
}

async function totpQrDataUrl(uri) {
  const module = await import('qrcode');
  const QRCode = module.default ?? module;
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 220,
    color: { dark: '#2d2431', light: '#fffafa' }
  });
}

async function settingsContext() {
  const settings = await readWursterSettings();
  return {
    meatLockerAvailable: meatLockerAvailable(),
    storageLabel: localStorageLabel(),
    devicePresenceAvailable: devicePresenceAvailable(),
    devicePresenceLabel: process.platform === 'darwin' ? 'Touch ID' : process.platform === 'win32' ? 'Windows Security' : 'device presence',
    totpConfigured: Boolean(settings.totp?.protectedSecret),
    identities: await listMeatIdentities(),
    publisherSigners: await listPublisherSigners()
  };
}

function assertSettingsSender(event) {
  if (!launcherWindow || launcherWindow.isDestroyed() || launcherView !== 'settings' || event.sender.id !== launcherWindow.webContents.id) {
    throw new Error('Invalid Wurster Settings caller');
  }
}

ipcMain.handle('wurster:settings:context', async (event) => { assertSettingsSender(event); return settingsContext(); });
ipcMain.handle('wurster:settings:generate-meatphrase', async (event) => { assertSettingsSender(event); return generateMeatphrase(12); });
ipcMain.handle('wurster:settings:identity:add', async (event, payload = {}) => {
  assertSettingsSender(event);
  return saveMeatIdentity(payload.name, payload.meatphrase, payload.protection ?? {}, payload.emoji);
});
ipcMain.handle('wurster:settings:identity:update', async (event, id, payload = {}) => {
  assertSettingsSender(event);
  return updateMeatIdentity(id, payload);
});
ipcMain.handle('wurster:settings:identity:delete', async (event, id) => {
  assertSettingsSender(event);
  return deleteMeatIdentity(id);
});
ipcMain.handle('wurster:settings:identity:reveal', async (event, id, authorization = {}) => {
  assertSettingsSender(event);
  const identity = await revealMeatIdentity(id, authorization);
  return { id: identity.id, name: identity.name, meatphrase: identity.meatphrase };
});
ipcMain.handle('wurster:settings:identity:public-copy', async (event, id) => {
  assertSettingsSender(event);
  const identities = await listMeatIdentities();
  const identity = identities.find((item) => item.id === String(id));
  if (!identity?.wursterIdentity) throw new Error('Wurster public identity is not available');
  const value = encodeWursterIdentityString(identity.wursterIdentity);
  clipboard.writeText(value);
  return { copied: true, identityId: identity.wursterIdentity.identityId };
});
ipcMain.handle('wurster:settings:identity:public-save', async (event, id) => {
  assertSettingsSender(event);
  const identities = await listMeatIdentities();
  const identity = identities.find((item) => item.id === String(id));
  if (!identity?.wursterIdentity) throw new Error('Wurster public identity is not available');
  const safeName = String(identity.name || 'wurster-identity').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'wurster-identity';
  const result = await dialog.showSaveDialog(launcherWindow, {
    title: 'Save public Wurster Identity',
    defaultPath: `${safeName}.wurstid`,
    filters: [{ name: 'Wurster Identity', extensions: ['wurstid'] }]
  });
  if (result.canceled || !result.filePath) return { saved: false };
  await fs.writeFile(result.filePath, `${JSON.stringify(identity.wursterIdentity, null, 2)}\n`, { mode: 0o644 });
  return { saved: true, filePath: result.filePath, identityId: identity.wursterIdentity.identityId };
});
ipcMain.handle('wurster:settings:publisher:add', async (event, payload = {}) => {
  assertSettingsSender(event);
  return savePublisherSigner(payload);
});
ipcMain.handle('wurster:settings:publisher:verify', async (event, id) => {
  assertSettingsSender(event);
  return verifyPublisherSignerDns(id);
});
ipcMain.handle('wurster:settings:publisher:authority-domain-begin', async (event, id) => {
  assertSettingsSender(event);
  return beginPublisherAuthorityDomain(id);
});
ipcMain.handle('wurster:settings:publisher:authority-domain-complete', async (event, id) => {
  assertSettingsSender(event);
  return completePublisherAuthorityDomain(id);
});
ipcMain.handle('wurster:settings:publisher:authority-email-begin', async (event, id) => {
  assertSettingsSender(event);
  return beginPublisherAuthorityEmail(id);
});
ipcMain.handle('wurster:settings:publisher:authority-email-complete', async (event, id, code) => {
  assertSettingsSender(event);
  return completePublisherAuthorityEmail(id, code);
});
ipcMain.handle('wurster:settings:publisher:reveal', async (event, id) => {
  assertSettingsSender(event);
  return revealPublisherSignerMeatphrase(id);
});
ipcMain.handle('wurster:settings:publisher:import', async (event, meatphrase) => {
  assertSettingsSender(event);
  const result = await dialog.showOpenDialog(launcherWindow, {
    title: 'Import MeatGrinder signing key',
    properties: ['openFile'],
    filters: [{ name: 'Wurst Publisher Key', extensions: ['wurstkey'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const bundle = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'));
  return importPublisherSigner({ bundle, meatphrase: String(meatphrase ?? '') });
});
ipcMain.handle('wurster:settings:publisher:export', async (event, id) => {
  assertSettingsSender(event);
  const material = await loadPublisherSignerMaterial(id, { prompt: true });
  const stem = String(material.summary.domain ?? material.summary.email ?? material.summary.label ?? 'publisher').replace(/[^a-z0-9._-]+/gi, '_');
  const result = await dialog.showSaveDialog(launcherWindow, {
    title: 'Export MeatGrinder signing key',
    defaultPath: `${stem}.wurstkey`,
    filters: [{ name: 'Wurst Publisher Key', extensions: ['wurstkey'] }]
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, `${JSON.stringify(material.bundle, null, 2)}\n`, { mode: 0o600 });
  return result.filePath;
});
ipcMain.handle('wurster:settings:publisher:delete', async (event, id) => {
  assertSettingsSender(event);
  return deletePublisherSigner(id);
});
ipcMain.handle('wurster:settings:totp:begin', async (event) => {
  assertSettingsSender(event);
  if (!meatLockerAvailable()) throw new Error('Secure local storage is required before Authenticator protection can be configured');
  const secret = generateTotpSecret();
  const uri = totpUri(secret, { issuer: 'Wurster', account: 'Meat Locker' });
  pendingTotpSetup = { secret, createdAt: Date.now() };
  return { secret, uri, qrDataUrl: await totpQrDataUrl(uri) };
});
ipcMain.handle('wurster:settings:totp:confirm', async (event, code) => {
  assertSettingsSender(event);
  if (!pendingTotpSetup || Date.now() - pendingTotpSetup.createdAt > 10 * 60 * 1000) throw new Error('Authenticator setup expired. Start again.');
  if (!verifyTotp(pendingTotpSetup.secret, code)) throw new Error('Invalid authenticator code');
  const settings = await readWursterSettings();
  settings.totp = {
    protectedSecret: safeStorage.encryptString(pendingTotpSetup.secret).toString('base64'),
    enabledAt: new Date().toISOString()
  };
  pendingTotpSetup = null;
  await writeWursterSettings(settings);
  return true;
});
ipcMain.handle('wurster:settings:totp:disable', async (event, code) => {
  assertSettingsSender(event);
  await verifyLockerTotp(code);
  const settings = await readWursterSettings();
  settings.totp = null;
  await writeWursterSettings(settings);
  const locker = await readMeatLocker();
  for (const identity of locker.identities) {
    identity.protection = { ...(identity.protection ?? {}), totp: false };
  }
  await writeMeatLocker(locker);
  return true;
});

function identityVerificationPayload({ manifest = {}, signature = {}, publisherTrust = {}, filePath = null, error = null } = {}) {
  if (error) {
    return {
      name: manifest?.name ?? path.basename(String(filePath || 'Unknown file')),
      id: manifest?.id ?? null,
      version: manifest?.version ?? null,
      filePath: filePath ? path.resolve(filePath) : null,
      publisher: null,
      trust: {
        level: 'danger',
        label: 'INVALID WURST',
        detail: error?.message || String(error),
        publisher: null,
        fingerprint: null
      },
      trustRoute: 'Verification failed before publisher identity could be established',
      integrity: 'Invalid or unreadable Wurst package',
      explain: 'Wurster inspected the file without opening its application. The package could not pass the Wurst identity check.'
    };
  }
  const trust = secureTrustPresentation({ signature, publisherTrust });
  const publisher = signature?.publisher ? {
    label: publisherDisplayName(signature.publisher),
    domain: signature.publisher.domain ?? null,
    email: signature.publisher.email ?? null,
    fingerprint: signature.publisher.fingerprint ?? null
  } : null;
  return {
    name: manifest?.name ?? 'Unknown Wurst',
    id: manifest?.id ?? null,
    version: manifest?.version ?? null,
    filePath: filePath ? path.resolve(filePath) : null,
    publisher,
    trust,
    trustRoute: verificationTrustRoute(publisherTrust),
    integrity: signature?.status === 'signed' && signature?.valid
      ? 'Ed25519 package signature valid'
      : signature?.status === 'unsigned'
        ? 'Unsigned package · no publisher integrity signature'
        : signature?.status === 'invalid'
          ? `Signature invalid${signature?.error ? ` · ${signature.error}` : ''}`
          : 'No signed publisher integrity result',
    explain: trust.level === 'verified'
      ? 'You did not trust the label. Sensible. Wurster independently checked the package signature and its configured publisher trust route.'
      : 'A Wurst can imitate a badge in ordinary HTML. This Wurster-owned window is the authoritative check outside the Wurst renderer.'
  };
}

async function inspectIdentityForFile(filePath) {
  const resolved = path.resolve(filePath);
  let reader = null;
  try {
    reader = await openWurstFile(resolved);
    const manifest = reader.manifest ?? {};
    if (manifest.format !== 'wurst/7') throw new Error(`Unsupported manifest format: ${manifest.format}`);
    const signature = await verifyPackageSignatureFromReader(reader);
    const publisherTrust = await resolvePublisherTrust(signature);
    return identityVerificationPayload({ manifest, signature, publisherTrust, filePath: resolved });
  } catch (error) {
    return identityVerificationPayload({ filePath: resolved, error });
  } finally {
    if (reader) await reader.close().catch(() => {});
  }
}

async function leaveIdentityVerificationView() {
  if (!launcherWindow || launcherWindow.isDestroyed()) return false;
  const returnMode = verificationReturnMode;
  verificationPayload = null;
  if (returnMode === 'hide' && currentWindow && !currentWindow.isDestroyed()) {
    await showLauncherHome({ focus: false });
    launcherWindow.hide();
    currentWindow.show();
    currentWindow.focus();
    return true;
  }
  if (returnMode === 'quit') {
    launcherWindow.hide();
    app.quit();
    return true;
  }
  await showLauncherHome({ focus: true });
  return true;
}

async function showIdentityVerification(payload, { returnMode = null } = {}) {
  const hadVisibleLauncher = Boolean(launcherWindow && !launcherWindow.isDestroyed() && launcherWindow.isVisible() && launcherView === 'launcher');
  if (!launcherWindow || launcherWindow.isDestroyed()) openLauncherWindow({ show: false });
  verificationPayload = payload;
  verificationReturnMode = returnMode ?? (currentWindow && !currentWindow.isDestroyed() ? 'hide' : hadVisibleLauncher ? 'launcher' : 'quit');
  launcherView = 'verification';
  launcherWindow.setMinimumSize(560, 570);
  launcherWindow.setMaximumSize(820, 840);
  launcherWindow.setSize(620, 660, true);
  launcherWindow.setTitle('Wurster · Verify Wurst Identity');
  await launcherWindow.loadFile(IDENTITY_VERIFICATION_HTML, { query: {} });
  launcherWindow.show();
  launcherWindow.focus();
  return launcherWindow;
}

async function showIdentityVerificationForContext(context) {
  return showIdentityVerification(identityVerificationPayload({
    manifest: context.manifest,
    signature: context.signature,
    publisherTrust: context.publisherTrust,
    filePath: context.filePath
  }), { returnMode: 'hide' });
}

async function showIdentityVerificationForFile(filePath, options = {}) {
  if (!isWurstCandidate(filePath)) throw new Error('Identity verification expects a .wurst, .wrst or Undercover PNG');
  const payload = await inspectIdentityForFile(filePath);
  return showIdentityVerification(payload, options);
}

ipcMain.handle('wurster:verification:context', async (event) => {
  if (!launcherWindow || launcherWindow.isDestroyed() || launcherView !== 'verification' || event.sender.id !== launcherWindow.webContents.id || !verificationPayload) {
    throw new Error('Invalid Wurster verification caller');
  }
  return verificationPayload;
});

ipcMain.handle('wurster:verification:close', async (event) => {
  if (!launcherWindow || launcherWindow.isDestroyed() || launcherView !== 'verification' || event.sender.id !== launcherWindow.webContents.id) {
    throw new Error('Invalid Wurster verification caller');
  }
  return leaveIdentityVerificationView();
});

async function showLauncherHome({ focus = true } = {}) {
  if (!launcherWindow || launcherWindow.isDestroyed()) return openLauncherWindow();
  launcherView = 'launcher';
  launcherWindow.setMinimumSize(374, 430);
  launcherWindow.setMaximumSize(980, 860);
  launcherWindow.setSize(374, 430, true);
  launcherWindow.setTitle('Wurster');
  await launcherWindow.loadFile(LAUNCHER_HTML);
  if (focus) {
    launcherWindow.show();
    launcherWindow.focus();
  }
  return launcherWindow;
}

async function showSettingsInLauncher() {
  if (!launcherWindow || launcherWindow.isDestroyed()) openLauncherWindow({ show: false });
  launcherReturnMode = currentWindow && !currentWindow.isDestroyed() ? 'hide' : 'launcher';
  launcherView = 'settings';
  launcherWindow.setMinimumSize(680, 600);
  launcherWindow.setMaximumSize(1100, 980);
  launcherWindow.setSize(820, 720, true);
  launcherWindow.setTitle('Wurster Settings');
  await launcherWindow.loadFile(SETTINGS_HTML);
  launcherWindow.show();
  launcherWindow.focus();
  return launcherWindow;
}

async function leaveSettingsView() {
  if (!launcherWindow || launcherWindow.isDestroyed()) return false;
  if (launcherReturnMode === 'hide' && currentWindow && !currentWindow.isDestroyed()) {
    await showLauncherHome({ focus: false });
    launcherWindow.hide();
    currentWindow.focus();
    return true;
  }
  await showLauncherHome({ focus: true });
  return true;
}

async function openProtectedSettingsWindow() {
  try {
    await promptWursterAdministrationPresence();
    return showSettingsInLauncher();
  } catch (error) {
    if (launcherWindow && !launcherWindow.isDestroyed()) {
      await dialog.showMessageBox(launcherWindow, {
        type: 'warning',
        title: 'Wurster Security',
        message: 'Wurster Settings stayed locked.',
        detail: error?.message || 'Local user verification was not completed.'
      });
    }
    return null;
  }
}

function assertLauncherSender(event) {
  if (!launcherWindow || launcherWindow.isDestroyed() || event.sender.id !== launcherWindow.webContents.id) {
    throw new Error('Invalid Wurster launcher caller');
  }
}

async function openFromLauncher(filePath) {
  if (!isWurstCandidate(filePath)) throw new Error('Drop a .wurst, .wrst or Undercover .png file');
  const opened = await openRequestedWurst(filePath);
  if (opened && launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.hide();
  return opened;
}

function sendGrinderState(state = {}) {
  if (!launcherWindow || launcherWindow.isDestroyed() || launcherView !== 'launcher') return;
  launcherWindow.webContents.send('wurster:grinder:state', {
    sourcePath: grinderSourcePath,
    carrierPath: grinderCarrierPath,
    lastOutput: grinderLastOutput,
    busy: grinderBusy,
    ...state
  });
}

async function grinderStatKind(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile() && path.extname(filePath).toLowerCase() === '.zip') return 'zip';
  throw new Error('Feed MeatGrinder a project folder or .zip');
}

async function grinderValidateCarrier(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) throw new Error('Carrier image must be PNG or JPEG');
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) throw new Error('Carrier image could not be read');
  return path.resolve(filePath);
}

async function grinderExtractZip(zipPath) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'meatgrinder-'));
  if (process.platform === 'darwin') {
    await runProcess('/usr/bin/ditto', ['-x', '-k', zipPath, temp]);
  } else if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${temp.replaceAll("'", "''")}' -Force`;
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  } else {
    await runProcess('unzip', ['-q', zipPath, '-d', temp]);
  }
  const entries = (await fs.readdir(temp, { withFileTypes: true }))
    .filter((entry) => entry.name !== '__MACOSX' && entry.name !== '.DS_Store');
  if (entries.length === 1 && entries[0].isDirectory()) return { temp, root: path.join(temp, entries[0].name) };
  return { temp, root: temp };
}

async function grinderPrepareCarrier(filePath, tempDir) {
  if (!filePath) return null;
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) throw new Error('Carrier image could not be read');
  const target = path.join(tempDir, 'carrier.png');
  await fs.writeFile(target, image.toPNG());
  return target;
}

function grinderOutputFor(input, undercover) {
  const ext = undercover ? '.png' : '.wurst';
  const parsed = path.parse(input);
  if (parsed.ext.toLowerCase() === '.zip') return path.join(parsed.dir, `${parsed.name}${ext}`);
  return path.join(path.dirname(input), `${path.basename(input)}${ext}`);
}

async function setGrinderSource(filePath) {
  await grinderStatKind(filePath);
  grinderSourcePath = path.resolve(filePath);
  grinderLastOutput = null;
  sendGrinderState({ phase: 'ready', progress: 0, message: 'Meat acquired.' });
  return grinderSourcePath;
}

async function setGrinderCarrier(filePath) {
  grinderCarrierPath = await grinderValidateCarrier(filePath);
  grinderLastOutput = null;
  sendGrinderState({ phase: 'ready', progress: 0, message: 'PNG camouflage loaded.' });
  return grinderCarrierPath;
}

ipcMain.handle('wurster:launcher:choose', async (event) => {
  assertLauncherSender(event);
  const file = await chooseWurst();
  if (!file) return false;
  return openFromLauncher(file);
});
ipcMain.handle('wurster:launcher:open', async (event, filePath) => {
  assertLauncherSender(event);
  return openFromLauncher(String(filePath ?? ''));
});
ipcMain.handle('wurster:launcher:identities', async (event) => {
  assertLauncherSender(event);
  return Boolean(await openProtectedSettingsWindow());
});
ipcMain.handle('wurster:launcher:back', async (event) => {
  assertLauncherSender(event);
  return leaveSettingsView();
});
ipcMain.handle('wurster:grinder:signers', async (event) => {
  assertLauncherSender(event);
  const signers = await listPublisherSigners();
  if (grinderSignerId && !signers.some((item) => item.id === grinderSignerId)) grinderSignerId = null;
  return { selectedId: grinderSignerId, signers };
});
ipcMain.handle('wurster:grinder:signer-select', async (event, id) => {
  assertLauncherSender(event);
  if (id == null || id === '') { grinderSignerId = null; return null; }
  const signers = await listPublisherSigners();
  const signer = signers.find((item) => item.id === String(id));
  if (!signer) throw new Error('Signing identity not found');
  grinderSignerId = signer.id;
  return signer;
});
ipcMain.handle('wurster:grinder:signer-add', async (event, payload = {}) => {
  assertLauncherSender(event);
  const signer = await savePublisherSigner(payload);
  grinderSignerId = signer.id;
  return signer;
});
ipcMain.handle('wurster:grinder:signer-verify', async (event, id) => {
  assertLauncherSender(event);
  return verifyPublisherSignerDns(id);
});
ipcMain.handle('wurster:grinder:authority-domain-begin', async (event, id) => {
  assertLauncherSender(event);
  return beginPublisherAuthorityDomain(id);
});
ipcMain.handle('wurster:grinder:authority-domain-complete', async (event, id) => {
  assertLauncherSender(event);
  return completePublisherAuthorityDomain(id);
});
ipcMain.handle('wurster:grinder:authority-email-begin', async (event, id) => {
  assertLauncherSender(event);
  return beginPublisherAuthorityEmail(id);
});
ipcMain.handle('wurster:grinder:authority-email-complete', async (event, id, code) => {
  assertLauncherSender(event);
  return completePublisherAuthorityEmail(id, code);
});
ipcMain.handle('wurster:grinder:choose-source', async (event) => {
  assertLauncherSender(event);
  const result = await dialog.showOpenDialog(launcherWindow, {
    title: 'Choose project folder or ZIP',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Web project or ZIP', extensions: ['zip', 'html'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return setGrinderSource(result.filePaths[0]);
});
ipcMain.handle('wurster:grinder:choose-carrier', async (event) => {
  assertLauncherSender(event);
  const result = await dialog.showOpenDialog(launcherWindow, {
    title: 'Optional Undercover PNG carrier',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return setGrinderCarrier(result.filePaths[0]);
});
ipcMain.handle('wurster:grinder:set-source', async (event, filePath) => {
  assertLauncherSender(event);
  return setGrinderSource(String(filePath || ''));
});
ipcMain.handle('wurster:grinder:set-carrier', async (event, filePath) => {
  assertLauncherSender(event);
  return setGrinderCarrier(String(filePath || ''));
});
ipcMain.handle('wurster:grinder:build', async (event) => {
  assertLauncherSender(event);
  if (grinderBusy) throw new Error('The grinder is already chewing');
  if (!grinderSourcePath) throw new Error('Feed MeatGrinder a project first');
  grinderBusy = true;
  let extracted = null;
  let scratch = null;
  try {
    sendGrinderState({ phase: 'grinding', progress: .03, message: 'Waking the grinder…' });
    const kind = await grinderStatKind(grinderSourcePath);
    let root = grinderSourcePath;
    if (kind === 'zip') {
      sendGrinderState({ phase: 'grinding', progress: .08, message: 'Unpacking the meat crate…' });
      extracted = await grinderExtractZip(grinderSourcePath);
      root = extracted.root;
    }
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'meatgrinder-carrier-'));
    const carrier = await grinderPrepareCarrier(grinderCarrierPath, scratch);
    const output = grinderOutputFor(grinderSourcePath, Boolean(carrier));
    let signerMaterial = null;
    if (grinderSignerId) {
      sendGrinderState({ phase: 'grinding', progress: .12, message: 'Waiting for publisher approval…' });
      signerMaterial = await loadPublisherSignerMaterial(grinderSignerId, { prompt: true });
      sendGrinderState({ phase: 'grinding', progress: .16, message: `Signing as ${publisherSignerName(signerMaterial.summary)}…` });
    }
    const result = await buildWurst(root, output, {
      carrier,
      publisherKeyBundle: signerMaterial?.bundle ?? null,
      publisherMeatphrase: signerMaterial?.meatphrase ?? null,
      publisherCertificate: signerMaterial?.certificate ?? null,
      onProgress: (step) => sendGrinderState({ phase: 'grinding', progress: step.progress, message: step.message })
    });
    grinderLastOutput = result.output;
    const signerNote = signerMaterial ? ` Signed as ${publisherSignerName(signerMaterial.summary)}.` : ' Unsigned.';
    sendGrinderState({ phase: 'done', progress: 1, message: (result.carrier ? 'Undercover Wurst pressed. Nobody saw anything.' : 'Wurst ready. Still warm.') + signerNote });
    return { output: result.output, generatedManifest: result.generatedManifest, carrier: Boolean(result.carrier), signature: result.signature, signer: signerMaterial?.summary ?? null };
  } catch (error) {
    sendGrinderState({ phase: 'error', progress: 0, message: error.message || String(error) });
    throw error;
  } finally {
    grinderBusy = false;
    if (extracted?.temp) await fs.rm(extracted.temp, { recursive: true, force: true }).catch(() => {});
    if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
});
ipcMain.handle('wurster:grinder:reveal', async (event) => {
  assertLauncherSender(event);
  if (grinderLastOutput) shell.showItemInFolder(grinderLastOutput);
  return Boolean(grinderLastOutput);
});
ipcMain.on('wurster:launcher:minimize', (event) => {
  assertLauncherSender(event);
  launcherWindow.minimize();
});
ipcMain.on('wurster:launcher:close', (event) => {
  assertLauncherSender(event);
  if (currentWindow && !currentWindow.isDestroyed()) {
    void showLauncherHome({ focus: false }).then(() => launcherWindow?.hide());
  } else {
    app.quit();
  }
});

function openLauncherWindow({ show = true } = {}) {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    if (show) {
      launcherWindow.show();
      launcherWindow.focus();
    }
    return launcherWindow;
  }
  const win = new BrowserWindow({
    title: 'Wurster',
    width: 374,
    height: 430,
    minWidth: 374,
    minHeight: 430,
    maxWidth: 1100,
    maxHeight: 980,
    transparent: true,
    frame: false,
    hasShadow: true,
    resizable: false,
    backgroundColor: '#00000000',
    icon: WURSTER_ICON,
    show: false,
    webPreferences: {
      preload: LAUNCHER_PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      webviewTag: false
    }
  });
  launcherWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('closed', () => { if (launcherWindow === win) launcherWindow = null; });
  launcherView = 'launcher';
  void win.loadFile(LAUNCHER_HTML);
  return win;
}

function closeDetachedDevTools() {
  try { currentWindow?.webContents?.closeDevTools(); } catch {}
  if (devToolsWindow && !devToolsWindow.isDestroyed()) {
    const win = devToolsWindow;
    devToolsWindow = null;
    try { win.destroy(); } catch {}
  }
}

function openDetachedWurstDevTools() {
  if (!currentWindow || currentWindow.isDestroyed()) return;
  if (devToolsWindow && !devToolsWindow.isDestroyed()) {
    devToolsWindow.show();
    devToolsWindow.focus();
    return;
  }
  const inspected = currentWindow.webContents;
  const tools = new BrowserWindow({
    title: `${currentContext?.manifest?.name ?? 'Wurst'} · Developer Tools`,
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: true,
    backgroundColor: '#202124',
    autoHideMenuBar: true,
    webPreferences: { devTools: false }
  });
  tools.setMenuBarVisibility(false);
  devToolsWindow = tools;
  inspected.setDevToolsWebContents(tools.webContents);
  tools.on('closed', () => {
    if (devToolsWindow === tools) devToolsWindow = null;
    try { inspected.closeDevTools(); } catch {}
  });
  inspected.once('devtools-opened', () => {
    // With a custom DevTools WebContents the inspector lives in this top-level
    // BrowserWindow regardless of the Wurst window's own dimensions.
    if (!tools.isDestroyed()) {
      tools.show();
      tools.focus();
    }
  });
  // Electron remembers the last dock state. With a custom DevTools WebContents
  // that can produce a comical half-blank "window containing a docked inspector".
  // Force detach so this BrowserWindow is the DevTools surface itself.
  inspected.openDevTools({ mode: 'detach', activate: true });
  setTimeout(() => {
    if (tools.isDestroyed()) return;
    const actual = inspected.devToolsWebContents;
    if (!actual || actual.id !== tools.webContents.id) {
      try {
        inspected.closeDevTools();
        inspected.setDevToolsWebContents(tools.webContents);
        inspected.openDevTools({ mode: 'detach', activate: true });
      } catch {}
    }
  }, 120);
}

async function openWurstFromMenu() {
  const file = await chooseWurst();
  if (!file) return;
  try { await loadPackage(path.resolve(file)); } catch (error) { await showWurstError(error); }
}

async function verifyWurstFromMenu() {
  const file = await chooseWurst();
  if (!file) return;
  try {
    await showIdentityVerificationForFile(path.resolve(file), {
      returnMode: currentWindow && !currentWindow.isDestroyed() ? 'hide' : 'launcher'
    });
  } catch (error) {
    await showWurstError(error);
  }
}

function installApplicationMenu() {
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => void openProtectedSettingsWindow() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }
  template.push({ label: 'File', submenu: [
    { label: 'Open Wurst…', accelerator: 'CommandOrControl+O', click: () => void openWurstFromMenu() },
    { label: 'Verify Wurst Identity…', click: () => void verifyWurstFromMenu() },
    ...(process.platform === 'darwin' ? [{ role: 'close' }] : [{ type: 'separator' }, { role: 'quit' }])
  ] });
  template.push({ label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] });
  template.push({ label: 'View', submenu: [
    {
      label: 'Toggle Wurst Developer Tools',
      accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
      click: () => {
        if (!currentWindow || currentWindow.isDestroyed()) return;
        if (devToolsWindow && !devToolsWindow.isDestroyed()) closeDetachedDevTools();
        else openDetachedWurstDevTools();
      }
    },
    { label: 'Reload Wurst', accelerator: 'CommandOrControl+R', click: () => currentWindow?.webContents.reload() }
  ] });
  template.push({ label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ role: 'front' }] : [])] });
  if (process.platform !== 'darwin') template.push({ label: 'Wurster', submenu: [{ label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => void openProtectedSettingsWindow() }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function presentationIconFor(reader, manifest) {
  const iconPath = manifest?.presentation?.icon;
  if (!iconPath || !reader.has(iconPath)) return WURSTER_ICON;
  try {
    const entry = reader.entry(iconPath);
    if ((entry.scope ?? 'app') !== 'meta' || entry.encryption) return WURSTER_ICON;
    const loaded = await reader.read(iconPath, { verify: true });
    const image = nativeImage.createFromBuffer(loaded.data);
    return image.isEmpty() ? WURSTER_ICON : image;
  } catch {
    return WURSTER_ICON;
  }
}

async function loadPackage(filePath) {
  isOpeningPackage = true;
  let reader = null;
  try {
    reader = await openWurstFile(filePath);
    const manifest = reader.manifest;

    if (manifest.format !== 'wurst/7') throw new Error(`Unsupported manifest format: ${manifest.format}`);
    if (fullySealedApplication(manifest)) {
      const sealedIndex = manifest.application?.sealedIndex ?? SEALED_APP_INDEX_PATH;
      const sealedIndexEntry = reader.entry(sealedIndex);
      if (!sealedIndexEntry?.encryption) throw new Error('Fully sealed Wurst is missing its protected application index');
    } else if (!reader.has(manifest.entry)) {
      throw new Error(`Wurst entry missing: ${manifest.entry}`);
    }

    const signature = await verifyPackageSignatureFromReader(reader);
    const risk = classifyRisk(manifest);
    const authorization = await authorizePackage(manifest, risk, signature);
    const packageIcon = await presentationIconFor(reader, manifest);

    closeDetachedDevTools();
    await clearCurrentContext();
    currentFile = filePath;
    if (currentWindow && !currentWindow.isDestroyed()) currentWindow.destroy();

    const context = {
      filePath,
      reader,
      pkg: null,
      manifest,
      signature,
      risk,
      publisherTrust: authorization.publisherTrust,
      runtimeBinding: `wurst:${manifest.id}:${crypto.randomUUID()}`,
      applicationProtectionHandle: null,
      applicationSessionTimer: null,
      wurstFsStore: null,
      wurstFsMaintenance: null,
      wurstFsHygieneTimer: null,
      sealedAppMap: null,
      identitySession: null,
      wurstIdentityMaterial: null,
      filesystemIdentityTimer: null,
      bootstrapWindow: null
    };
    reader = null;
    currentContext = context;

    const wurstSession = session.fromPartition(partitionFor(manifest), { cache: false });
    configureSession(wurstSession, context);

    const w = manifest.window ?? {};
    const capabilities = normalizeCapabilities(manifest.capabilities);
    const newWindow = new BrowserWindow({
      title: manifest.name ?? 'Wurst',
      width: Math.max(240, Number(w.width) || 720),
      height: Math.max(160, Number(w.height) || 480),
      transparent: Boolean(w.transparent),
      hasShadow: w.shadow == null ? !Boolean(w.transparent) : Boolean(w.shadow),
      frame: w.frame !== false,
      resizable: w.resizable !== false,
      alwaysOnTop: Boolean(capabilities['window.alwaysOnTop']),
      backgroundColor: w.transparent ? '#00000000' : '#111111',
      icon: packageIcon,
      show: false,
      webPreferences: {
        session: wurstSession,
        preload: WURST_PRELOAD,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: true,
        spellcheck: false,
        webviewTag: false
      }
    });
    currentWindow = newWindow;
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.hide();

    newWindow.setMenuBarVisibility(false);
    newWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    newWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('wurst://app/')) event.preventDefault();
    });
    newWindow.once('ready-to-show', () => newWindow.show());
    newWindow.on('closed', () => {
      if (currentWindow !== newWindow) return;
      closeDetachedDevTools();
      currentWindow = null;
      void clearCurrentContext();
      // A Wurst is a document/app session, not a launcher workflow. Closing
      // the Wurst ends Wurster completely. The launcher only exists when the
      // user starts Wurster itself without a document.
      if (!isOpeningPackage) app.quit();
    });

    if (fullySealedApplication(manifest)) {
      context.bootstrapWindow = newWindow;
      const bootstrapHtml = await fs.readFile(SEALED_BOOTSTRAP_HTML, 'utf8');
      await newWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bootstrapHtml)}`);
    } else {
      await newWindow.loadURL(`wurst://app/${manifest.entry}`);
    }
  } finally {
    if (reader) await reader.close().catch(() => {});
    isOpeningPackage = false;
  }
}

async function chooseWurst() {
  const result = await dialog.showOpenDialog({
    title: 'Choose a Wurst',
    filters: [
      { name: 'Wurst packages', extensions: ['wurst', 'wrst', 'png'] },
      { name: 'Native Wurst', extensions: ['wurst', 'wrst'] },
      { name: 'Undercover Wurst PNG', extensions: ['png'] }
    ],
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
}

async function showWurstError(error) {
  if (String(error?.message).includes('cancelled')) return;
  await dialog.showMessageBox({
    type: 'error',
    title: 'Invalid Wurst',
    message: 'This Wurst could not be eaten.',
    detail: error.stack ?? error.message
  });
}

async function openInitialWurst() {
  // Finder document launches on macOS arrive via app.open-file rather than argv.
  // Give that event a short chance to arrive before showing the chooser.
  if (process.platform === 'darwin' && !pendingMacOpenFile) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  let file = pendingMacOpenFile ?? findWurstArgument(process.argv);
  pendingMacOpenFile = null;
  if (!file) {
    openLauncherWindow();
    return;
  }
  await openRequestedWurst(file);
}

app.whenReady().then(async () => {
  installApplicationMenu();
  try {
    const startupVerification = findIdentityVerificationArgument(process.argv);
    const startupHandoff = pendingRuntimeHandoff ?? findRuntimeHandoffArgument(process.argv);
    if (startupVerification) {
      await showIdentityVerificationForFile(startupVerification, { returnMode: 'quit' });
    } else if (startupHandoff) {
      pendingRuntimeHandoff = null;
      openLauncherWindow();
      await handleRuntimeHandoff(startupHandoff);
    } else {
      await openInitialWurst();
    }
  } finally {
    initialOpenComplete = true;
    if (pendingMacOpenFile) {
      const requested = pendingMacOpenFile;
      pendingMacOpenFile = null;
      await openRequestedWurst(requested);
    }
  }
});
app.on('window-all-closed', () => {
  if (!isOpeningPackage && process.platform !== 'darwin') app.quit();
});
app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length !== 0) return;
  if (currentFile) {
    try { await loadPackage(currentFile); } catch (error) { await showWurstError(error); }
    return;
  }
  openLauncherWindow();
});
app.on('before-quit', () => { closeDetachedDevTools(); void clearCurrentContext(); void protectionClient.shutdown(); });
