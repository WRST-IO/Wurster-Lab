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
  systemPreferences,
  webContents as electronWebContents
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
import { UnlockSessionBroker } from '@wurster/session';
import { generateTotpSecret, totpUri, verifyTotp } from './identity-core.mjs';
import { publisherDisplayName, secureTrustPresentation, verificationTrustRoute } from './publisher-trust-presentation.mjs';
import { pigFsPath } from './pig-fs-paths.mjs';
import { createDesktopPigLinkRuntime, loadPigLinkEntry } from './piglink-runtime.mjs';
import { pigletChildren, createDesktopPigletRuntime } from './piglet-runtime.mjs';
import { createPigletStorageAdapter } from './piglet-storage-runtime.mjs';
import { createPigletEmbedRuntime } from './piglet-embed-runtime.mjs';
import { bindPigletPigFsPersistence } from './piglet-pigfs-runtime.mjs';
import { createTrustedSurfaceRuntime } from './trusted-surface-runtime.mjs';
import { createDesktopPigstyRuntime } from './pigsty-runtime.mjs';
import { createDesktopDevToolsRuntime, isWurstDevToolsShortcut } from './devtools-runtime.mjs';
import { runStartupAutoUpdate } from './update-runtime.mjs';
import { cspFor, networkRequestAllowed, parseHttpRange, partitionFor, responseFor, safeRequestPath } from './web-sandbox-runtime.mjs';
import {
  SEALED_APP_INDEX_PATH,
  classifyRisk,
  createPublisherKeyBundle,
  deriveWursterIdentityMaterial,
  encodeWursterIdentityString,
  createPublisherCertificateRequest,
  generateMeatphrase,
  mimeFor,
  measurePigFsStorage,
  normalizeCapabilities,
  normalizeMeatphrase,
  normalizeWurstKey,
  normalizeWurstPath,
  publisherDnsRecordName,
  publisherDnsTxtValue,
  publisherIdentityFromBundle,
  verifyPublisherDomainRecords,
  unlockPublisherPrivateKey,
  openLocalPigFsStore,
  pigFsRealmCapabilities,
  pigFsRealmGovernance,
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
const MAX_PIG_FS_SLICE_BYTES = 2 * 1024 * 1024;
const MAX_PIG_FS_CHUNK_BYTES = 4 * 1024 * 1024;
const SUPPORTED_CAPABILITIES = new Set(['storage.local', 'network', 'window.alwaysOnTop', 'code.unsafeEval', 'files.open', 'files.save']);
const MEAT_LOCKER_FORMAT = 'wurster/meat-locker-5';
const WURSTER_SETTINGS_FORMAT = 'wurster/settings-1';
const SETTINGS_HTML = path.join(HERE, 'settings.html');
const UPDATE_HTML = path.join(HERE, 'update.html');
const LAUNCHER_PRELOAD = path.join(HERE, 'launcher-preload.cjs');
const LAUNCHER_HTML = path.join(HERE, 'launcher.html');
const WRST_AUTHORITY_URL = 'https://authority.wrst.io';
const WEB_RUNTIME_SRC = app.isPackaged ? path.join(process.resourcesPath, 'web-runtime') : path.resolve(HERE, '../../web/dist');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'wurst',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      allowServiceWorkers: true,
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
const runtimeContextByWebContents = new Map();
let lastFocusedRuntimeWebContentsId = null;
const devToolsRuntime = createDesktopDevToolsRuntime({ BrowserWindow });
let launcherWindow = null;
let launcherReturnMode = 'launcher';
let launcherView = 'launcher';
let verificationPayload = null;
let verificationReturnMode = 'launcher';
let pendingTotpSetup = null;
let pendingMacOpenFile = null;
let pendingRuntimeHandoff = null;
let initialOpenComplete = false;
let isOpeningPackage = false;
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
      if (parsedUrl.hostname === 'pigfs') {
        if (!realmDataMode(context.manifest)) return new Response('PigFS not declared', { status: 404 });
        const requested = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
        const fsPath = pigFsPath(requested);
        const options = realmReadOptions(context, fsPath);
        let entry;
        try { entry = await context.reader.pigFsStat(fsPath, options); }
        catch (error) { if (error?.code === 'PIG_FS_LOCKED') return new Response('Protected PigFS realm is locked', { status: 423 }); throw error; }
        if (!entry || entry.type !== 'file') return new Response('PigFS resource not found', { status: 404 });
        const total = entry.size;
        const requestedRange = parseHttpRange(request.headers.get('range'), total);
        const offset = requestedRange?.offset ?? 0;
        const length = requestedRange?.length ?? total;
        const loaded = await context.reader.pigFsReadRange(fsPath, offset, length, options);
        if (!loaded) return new Response('PigFS resource not found', { status: 404 });
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
      if (parsedUrl.hostname === 'app' && decodeURIComponent(parsedUrl.pathname) === '/__wurst/runtime/wurster-embed.mjs') {
        const data = await fs.readFile(path.join(WEB_RUNTIME_SRC, 'wurster-embed.mjs'));
        return new Response(data, { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (parsedUrl.hostname === 'runtime') {
        const requested = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
        const allowed = new Map([
          ['wurster-embed.mjs', ['wurster-embed.mjs', 'text/javascript; charset=utf-8']],
          ['wurster-embed-host.html', ['wurster-embed-host.html', 'text/html; charset=utf-8']],
          ['wurster-web.mjs', ['wurster.js', 'text/javascript; charset=utf-8']],
          ['wurster.js', ['wurster.js', 'text/javascript; charset=utf-8']],
          ['wurster.min.js', ['wurster.min.js', 'text/javascript; charset=utf-8']],
          ['wurster-sw.js', ['wurster-sw.js', 'text/javascript; charset=utf-8']],
          ['trust-data.mjs', ['trust-data.mjs', 'text/javascript; charset=utf-8']]
        ]);
        const asset = allowed.get(requested);
        if (!asset) return new Response('Wurster runtime asset not found', { status: 404 });
        const data = await fs.readFile(path.join(WEB_RUNTIME_SRC, asset[0]));
        return new Response(data, { status: 200, headers: { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (parsedUrl.hostname === 'piglink') {
        const requested = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
        const data = await loadPigLinkEntry(context, requested);
        if (!data) return new Response('PigLink resource not found', { status: 404 });
        return new Response(data, {
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
    return { ...parsed, updates: { ...parsed.updates, autoUpdate: parsed.updates?.autoUpdate !== false } };
  } catch {
    return { format: WURSTER_SETTINGS_FORMAT, totp: null, updates: { autoUpdate: true } };
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

function runtimeRenderer(context) {
  if (context === currentContext && currentWindow && !currentWindow.isDestroyed()) return currentWindow.webContents;
  return null;
}

function runtimeViewport(_context) {
  const bounds = currentWindow?.getContentBounds?.() ?? { width: 800, height: 600 };
  return { x: 0, y: 0, width: bounds.width, height: bounds.height };
}

const trustedSurfaceRuntime = createTrustedSurfaceRuntime({
  ipcMain,
  createView: (webPreferences) => new WebContentsView({ webPreferences }),
  getHostWindow: () => currentWindow,
  getRuntimeRenderer: runtimeRenderer,
  getRuntimeViewport: runtimeViewport,
  assertWurstSender,
  authControlPreload: AUTH_CONTROL_PRELOAD,
  authControlHtml: AUTH_CONTROL_HTML,
  identityControlPreload: IDENTITY_CONTROL_PRELOAD,
  identityControlHtml: IDENTITY_CONTROL_HTML,
  secureTrustPresentation,
  showIdentityVerificationForContext
});
const {
  authSurfaceForEvent,
  identitySurfaceForEvent,
  sendAuthResultToWurst,
  applyAuthSurfaceLayout
} = trustedSurfaceRuntime;
function destroyAllAuthSurfaces() { trustedSurfaceRuntime.destroyAll(); }
function destroyAllIdentitySurfaces() {}
function destroyContextTrustedSurfaces(context) { trustedSurfaceRuntime.cleanupContext(context); }

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
    if (fullySealedApplication(surface.context.manifest)) {
      const renderer = runtimeRenderer(surface.context);
      if (renderer && surface.context.bootstrapWebContents === renderer) {
        const map = await sealedApplicationMap(surface.context);
        surface.context.bootstrapWebContents = null;
        await renderer.loadURL(`wurst://app/${map.entry}`);
      }
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
  const context = currentContext;
  if (!context) return;

  // Claim the context before any asynchronous teardown. `closed` and
  // `before-quit` may both request cleanup during the same shutdown turn;
  // only the first caller owns this context.
  currentContext = null;
  context.closing = true;

  pigLinkRuntime.closeContext(context);
  await pigletRuntime.closeContext(context);
  if (currentWindow && !currentWindow.isDestroyed()) {
    const renderer = currentWindow.webContents;
    if (renderer && !renderer.isDestroyed()) unbindRuntimeContext(renderer);
  }

  destroyAllAuthSurfaces();
  destroyAllIdentitySurfaces();
  if (context.pigFsHygieneTimer) clearTimeout(context.pigFsHygieneTimer);
  if (context.applicationSessionTimer) clearTimeout(context.applicationSessionTimer);
  if (context.filesystemIdentityTimer) clearTimeout(context.filesystemIdentityTimer);
  if (context.runtimeBinding) unlockSessions.revokeBinding(context.runtimeBinding);
  if (context.pigFsStore?.closeFile) await context.pigFsStore.closeFile().catch(() => {});
  else if (context.pigFsStore?.close) await context.pigFsStore.close().catch(() => {});
  if (context.applicationProtectionHandle) await protectionClient.destroy(context.applicationProtectionHandle);
  if (context.reader) await context.reader.close().catch(() => {});
}

function metadataPackage(context) {
  return { manifest: context.manifest, index: context.reader.index, pigFsRoot: context.reader.pigFsRoot };
}

function bindRuntimeContext(webContents, context) {
  const webContentsId = webContents.id;
  runtimeContextByWebContents.set(webContentsId, context);
  lastFocusedRuntimeWebContentsId = webContentsId;
  webContents.on('focus', () => {
    if (runtimeContextByWebContents.has(webContentsId)) lastFocusedRuntimeWebContentsId = webContentsId;
  });
  webContents.on('before-input-event', (event, input) => {
    if (!runtimeContextByWebContents.has(webContentsId) || !isWurstDevToolsShortcut(input)) return;
    event.preventDefault();
    lastFocusedRuntimeWebContentsId = webContentsId;
    void toggleWurstDevTools();
  });
  webContents.once('destroyed', () => unbindRuntimeContextById(webContentsId));
}

function unbindRuntimeContextById(webContentsId) {
  if (!Number.isInteger(webContentsId)) return;
  runtimeContextByWebContents.delete(webContentsId);
  if (lastFocusedRuntimeWebContentsId === webContentsId) lastFocusedRuntimeWebContentsId = null;
}

function unbindRuntimeContext(webContents) {
  if (webContents) unbindRuntimeContextById(webContents.id);
}

function assertWurstSender(event) {
  const context = runtimeContextByWebContents.get(event.sender.id);
  if (!context) throw new Error('Invalid Wurst runtime caller');
  return context;
}

let pigletRuntime = null;
let pigLinkRuntime = null;

async function invokeDelegatedParentPigFs(context, method, args = []) {
  const name = String(method ?? '');
  if (name === 'pigfs.capabilities') {
    if (!realmDataMode(context.manifest)) return { read: false, write: false, persistent: false, root: '/' };
    return {
      read: true,
      write: Boolean(context.manifest.pigfs?.writable && !context.reader.carrier),
      persistent: true, snapshot: true, mediaUrls: false, compact: false, protection: 'realms',
      format: 'wurst/pigfs-1', realms: true, root: '/'
    };
  }
  if (name === 'pigfs.realms') return realmDataMode(context.manifest) ? realmRuntimeSummary(context) : [];
  if (name === 'pigfs.usage') return currentWurstFsUsage(context);
  if (name === 'pigfs.stat') {
    if (!realmDataMode(context.manifest)) return null;
    const target = pigFsPath(args[0]);
    if (target === 'data') return { path: '/', name: 'pigfs', type: 'directory', size: 0, mime: null, revision: context.reader.pigFsRoot?.generation ?? 0 };
    if (!context.reader.pigFsRoot) return null;
    const entry = await context.reader.pigFsStat(target, await fsReadOptions(context, target));
    return entry ? (entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` }) : null;
  }
  if (name === 'pigfs.list') {
    if (!realmDataMode(context.manifest) || !context.reader.pigFsRoot) return [];
    const target = pigFsPath(args[0] || '/');
    const entries = await context.reader.pigFsList(target, await fsReadOptions(context, target));
    return entries.map((entry) => entry.path?.startsWith('/') ? entry : ({ ...entry, path: `/${entry.path}` }));
  }
  if (name === 'pigfs.read') {
    if (!realmDataMode(context.manifest) || !context.reader.pigFsRoot) return null;
    const target = pigFsPath(args[0]);
    const options = args[1] || {};
    const cryptoOptions = await fsReadOptions(context, target);
    const stat = await context.reader.pigFsStat(target, cryptoOptions);
    if (!stat || stat.type !== 'file') return null;
    const offset = Number(options.offset ?? 0);
    const requested = options.length == null ? MAX_PIG_FS_SLICE_BYTES : Number(options.length);
    const length = Math.min(requested, MAX_PIG_FS_SLICE_BYTES);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error('Invalid delegated PigFS read range');
    const result = await context.reader.pigFsReadRange(target, offset, length, cryptoOptions);
    return { path: stat.path?.startsWith('/') ? stat.path : `/${target}`, mime: stat.mime, size: stat.size, offset: result.offset, length: result.length, eof: result.eof, data: result.data };
  }
  if (!realmDataMode(context.manifest) || !context.manifest.pigfs?.writable || context.reader.carrier) throw new Error('Parent PigFS is not writable');
  await waitForWurstFsMaintenance(context);
  const store = await ensureWurstFsInitializedForWrite(context);
  const actor = activeFilesystemIdentity(context);
  if (name === 'pigfs.write') {
    const target = pigFsPath(args[0]);
    const value = args[1]; const options = args[2] || {};
    const bytes = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(typeof value === 'string' ? value : value ?? []);
    const id = store.beginWrite(target, { actor, mime: typeof options.mime === 'string' ? options.mime : mimeFor(target) });
    try {
      for (let offset = 0; offset < bytes.length || (bytes.length === 0 && offset === 0); offset += MAX_PIG_FS_CHUNK_BYTES) {
        await store.writeChunk(id, bytes.subarray(offset, Math.min(bytes.length, offset + MAX_PIG_FS_CHUNK_BYTES)));
        if (bytes.length === 0) break;
      }
      const result = await store.commitWrite(id);
      await refreshWurstFsContext(context); scheduleWurstFsHygiene(context);
      const entry = result.entry; return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
    } catch (error) { store.abortWrite(id); throw error; }
  }
  if (name === 'pigfs.beginWrite') {
    const target = pigFsPath(args[0]); const options = args[1] || {};
    const id = store.beginWrite(target, { actor, mime: typeof options.mime === 'string' ? options.mime : mimeFor(target) });
    return { id, path: `/${target}`, chunkSize: MAX_PIG_FS_CHUNK_BYTES };
  }
  if (name === 'pigfs.writeChunk') {
    const value = args[1];
    const bytes = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value ?? []);
    if (bytes.length > MAX_PIG_FS_CHUNK_BYTES) throw new Error('PigFS chunks may not exceed 4 MiB');
    return store.writeChunk(String(args[0] ?? ''), bytes);
  }
  if (name === 'pigfs.commitWrite') {
    const result = await store.commitWrite(String(args[0] ?? '')); await refreshWurstFsContext(context); scheduleWurstFsHygiene(context);
    const entry = result.entry; return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
  }
  if (name === 'pigfs.abortWrite') return store.abortWrite(String(args[0] ?? ''));
  if (name === 'pigfs.remove') {
    const removed = await store.remove(pigFsPath(args[0]), { actor, recursive: Boolean(args[1]?.recursive) });
    if (removed) { await refreshWurstFsContext(context); scheduleWurstFsHygiene(context, 700); } return removed;
  }
  if (name === 'pigfs.mkdir') {
    const entry = await store.mkdir(pigFsPath(args[0]), { actor, recursive: args[1]?.recursive !== false });
    await refreshWurstFsContext(context); scheduleWurstFsHygiene(context); return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
  }
  if (name === 'pigfs.rename') {
    const entry = await store.rename(pigFsPath(args[0]), pigFsPath(args[1]), { actor });
    if (!entry) return null; await refreshWurstFsContext(context); scheduleWurstFsHygiene(context); return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
  }
  throw new Error(`Unsupported delegated Parent PigFS method: ${name}`);
}

async function invokeDelegatedParentService(context, method, args = []) {
  const name = String(method ?? '');
  if (name.startsWith('pigfs.')) return invokeDelegatedParentPigFs(context, name, args);
  if (name === 'piglink.describe') return context.manifest.piglink ?? null;
  if (name === 'piglink.invoke') {
    if (!pigLinkRuntime) throw new Error('Parent PigLink runtime is unavailable');
    return pigLinkRuntime.invoke(context, args[0], args[1] ?? {});
  }
  if (name === 'piglet.children') {
    if (!pigletRuntime) throw new Error('Parent Piglet runtime is unavailable');
    return pigletRuntime.list(context);
  }
  if (name === 'piglet.inspect') {
    if (!pigletRuntime) throw new Error('Parent Piglet runtime is unavailable');
    return (await pigletRuntime.resolve(context, args[0])).descriptor;
  }
  if (name === 'piglet.install') {
    if (!pigletRuntime) throw new Error('Parent Piglet runtime is unavailable');
    return pigletRuntime.install(context, args[0], args[1], args[2] ?? {});
  }
  if (name === 'piglet.remove') {
    if (!pigletRuntime) throw new Error('Parent Piglet runtime is unavailable');
    return pigletRuntime.remove(context, args[0]);
  }
  throw new Error(`Unsupported delegated parent service: ${name}`);
}

const pigletStorage = createPigletStorageAdapter({
  realmDataMode,
  realmRuntimeSummary,
  readOptions: fsReadOptions,
  ensureInitializedStore: ensureWurstFsInitializedForWrite,
  activeActor: activeFilesystemIdentity,
  refreshContext: refreshWurstFsContext,
  scheduleHygiene: scheduleWurstFsHygiene,
  normalizeDataPath: pigFsPath,
  waitForMaintenance: waitForWurstFsMaintenance
});
const pigletEmbeds = createPigletEmbedRuntime({
  storage: pigletStorage,
  invokeParent: invokeDelegatedParentService,
  onSessionChanged: (context, detail) => {
    const target = context === currentContext ? currentWindow?.webContents : null;
    if (target && !target.isDestroyed()) target.send('wurst:piglet:session-changed', detail);
  },
  onMachineEvent: (context, detail) => {
    const target = context === currentContext ? currentWindow?.webContents : null;
    if (target && !target.isDestroyed()) target.send('wurst:piglet:machine-event', detail);
  },
  relationshipOptions: (context) => ({
    parentPigFs: realmDataMode(context.manifest)
      ? (context.manifest.pigfs?.writable && !context.reader.carrier ? 'read-write' : 'read')
      : null,
    parentPiglets: context.manifest.pigfs?.writable && !context.reader.carrier ? 'manage' : 'read'
  })
});
pigletRuntime = createDesktopPigletRuntime({
  ipcMain,
  assertWurstSender,
  storage: pigletStorage,
  embeds: pigletEmbeds
});
pigLinkRuntime = createDesktopPigLinkRuntime({
  ipcMain,
  assertWurstSender,
  getWebContents: (context) => context === currentContext ? currentWindow?.webContents : null
});
const pigstyRuntime = createDesktopPigstyRuntime({ app, ipcMain, assertWurstSender });

function realmDataMode(manifest) {
  return manifest?.pigfs?.format === 'wurst/pigfs-policy-1';
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
  if (context.pigFsStore?.realmKeys) {
    for (const realmId of [...context.pigFsStore.realmKeys.keys()]) context.pigFsStore.lockRealm(realmId);
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
    if (context.pigFsStore?.realmKeys) {
      for (const realmId of [...context.pigFsStore.realmKeys.keys()]) context.pigFsStore.lockRealm(realmId);
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
  if (!realmDataMode(context.manifest)) throw new Error('This Wurst does not use PigFS realms');
  if (context.pigFsStore) return context.pigFsStore;
  if (context.reader.carrier) throw new Error('PigFS realm writes are not available for carrier Wursts');
  if (!context.filePath && context.ensurePigletBacking) await context.ensurePigletBacking();
  if (!context.filePath) throw new Error('Writable PigFS needs a local runtime backing file');
  context.pigFsStore = bindPigletPigFsPersistence(
    await openLocalPigFsStore(context.filePath, context.reader),
    context.pigletPersistence
  );
  return context.pigFsStore;
}

async function ensureWurstFsInitializedForWrite(context) {
  const store = await ensureWurstFsStore(context);
  if (store.root) return store;
  const actor = activeFilesystemIdentity(context);
  if (!actor && realmTemplatesNeedIdentity(context)) {
    const error = new Error('Authenticate a Wurster Identity before initializing identity-backed PigFS realms');
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
  if (!realm) throw new Error(`Unknown PigFS realm ${realmId}`);
  if (realm.protection === 'public') return { realm: realm.id, unlocked: true, public: true };
  if (!material) {
    const error = new Error(`PigFS realm ${realm.id} requires a Wurster Identity`);
    error.code = 'WURST_AUTH_REQUIRED';
    throw error;
  }
  if (pigFsRealmGovernance(realm) === 'personal' && !realm.claimed) {
    await store.claimPersonalRealm(realm.id, { actor: material });
    await refreshWurstFsContext(context);
    return { realm: realm.id, unlocked: true, claimed: true, identity: material.publicRecord.identityId };
  }
  return store.unlockRealm(realm.id, material);
}

function realmReadOptions(context, fsPath) {
  if (!realmDataMode(context.manifest) || context.reader.pigFsRoot?.format !== 'wurst/pigfs-1') return {};
  const normalized = String(fsPath ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts[0] !== 'data' || parts.length < 2) return { realmKeys: context.pigFsStore?.realmKeys ?? new Map() };
  const realmId = parts[1].toLowerCase();
  const realmKey = context.pigFsStore?.realmKeys?.get(realmId) ?? null;
  return { realmKey, realmKeys: context.pigFsStore?.realmKeys ?? new Map() };
}

function packageHasProtectedApp(context) {
  return context.reader.entries().some((entry) => (entry.scope ?? 'app') === 'app' && Boolean(entry.encryption));
}

async function waitForWurstFsMaintenance(context) {
  if (context.pigFsMaintenance) await context.pigFsMaintenance;
}

async function currentWurstFsUsage(context) {
  const root = context.reader.pigFsRoot;
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
  return measurePigFsStorage(context.reader.source, root, {
    baseOffset: context.reader.baseLength,
    commitOffset: context.reader.pigFsCommitOffset,
    realmKeys: context.pigFsStore?.realmKeys ?? new Map()
  });
}

async function compactCurrentWurstFs(context, { reason = 'manual' } = {}) {
  if (context.reader.carrier) return { compacted: false, reason: 'carrier-read-only' };
  if (!realmDataMode(context.manifest)) return { compacted: false, reason: 'no-data' };
  if (context.reader.pigFsRoot?.historyMode === 'integrity') return { compacted: false, reason: 'integrity-history-retained' };
  if (!context.manifest.pigfs?.writable) return { compacted: false, reason: 'read-only' };
  if (context.pigFsMaintenance) return context.pigFsMaintenance;
  if (context.pigFsStore?.sessions?.size) return { compacted: false, reason: 'write-in-progress' };

  const task = (async () => {
    const originalReader = context.reader;
    const originalCommit = originalReader.pigFsCommitOffset ?? null;
    const store = await ensureWurstFsStore(context);
    for (const realm of Object.values(store.root?.realms ?? {})) {
      if (realm.protection !== 'sealed' || store.realmKeys.has(realm.id)) continue;
      if (pigFsRealmGovernance(realm) === 'personal' && realm.claimed === false && !(realm.catalogPages?.length)) continue;
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
      if ((originalReader.pigFsCommitOffset ?? null) !== originalCommit || context.pigFsStore?.sessions?.size) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        return { compacted: false, reason: 'changed-during-compaction' };
      }

      if (context.pigFsStore?.closeFile) await context.pigFsStore.closeFile();
      else if (context.pigFsStore?.close) await context.pigFsStore.close();
      context.pigFsStore = null;
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
        generation: replacement.pigFsRoot?.generation ?? 0
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
      context.pigFsMaintenance = null;
    }
  })();
  context.pigFsMaintenance = task;
  return task;
}

function scheduleWurstFsHygiene(context, delay = 1800) {
  if (!context || !realmDataMode(context.manifest) || context.reader.carrier || !context.manifest.pigfs?.writable) return;
  if (context.reader.pigFsRoot?.format === 'wurst/pigfs-1' && context.reader.pigFsRoot.historyMode === 'integrity') return;
  if (context.pigFsHygieneTimer) clearTimeout(context.pigFsHygieneTimer);
  context.pigFsHygieneTimer = setTimeout(async () => {
    context.pigFsHygieneTimer = null;
    try {
      if (context !== currentContext || context.pigFsMaintenance || context.pigFsStore?.sessions?.size) return;
      if (Object.values(context.reader.pigFsRoot?.realms ?? {}).some((realm) => realm.protection === 'sealed' && !context.pigFsStore?.realmKeys?.has(realm.id))) return;
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
  const context = assertWurstSender(event);
  currentWindow?.close();
  return true;
});

ipcMain.handle('wurst:window:minimize', async (event) => {
  const context = assertWurstSender(event);
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
  const sourcePath = context.filePath ? path.resolve(context.filePath) : null;
  if (sourcePath && !context.reader.carrier && destination === sourcePath) {
    // The current raw file already *is* the committed standalone snapshot.
    return { saved: true };
  }
  if (sourcePath && context.reader.carrier && destination === sourcePath) {
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
    piglink: context.manifest.piglink ? {
      format: context.manifest.piglink.format,
      headless: Boolean(context.manifest.piglink.headless),
      actions: context.manifest.piglink.actions ?? {},
      events: context.manifest.piglink.events ?? {}
    } : null,
    piglet: context.manifest.piglet ? {
      format: context.manifest.piglet.format,
      children: pigletChildren(context)
    } : null,
    pigsty: await pigstyRuntime.status(context),
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

async function fsReadOptions(context, fsPath = '/') {
  if (!realmDataMode(context.manifest)) throw new Error('This Wurst declares no PigFS filesystem');
  return realmReadOptions(context, pigFsPath(fsPath));
}

function realmTemplateGovernance(template = {}) {
  const governance = String(template?.governance ?? '').trim().toLowerCase();
  if (!governance) return 'ordinary';
  if (!['personal', 'shared'].includes(governance)) throw new Error(`Unsupported PigFS realm governance: ${governance}`);
  return governance;
}

function realmTemplatesNeedIdentity(context) {
  // Personal realms can ship empty/unclaimed. Only shared genesis needs an
  // authenticated owner up front.
  return (context.manifest.pigfs?.realms ?? []).some((template) => realmTemplateGovernance(template) === 'shared');
}

function realmTemplatesForRuntime(context, actor) {
  const actorId = actor?.publicRecord?.identityId ?? null;
  const templates = Array.isArray(context.manifest.pigfs?.realms) ? context.manifest.pigfs.realms : [];
  if (!templates.length) throw new Error('This Wurst declares no initial PigFS realm templates');
  return templates.map((template) => {
    const governance = realmTemplateGovernance(template);
    if (governance === 'shared' && !actorId) {
      const error = new Error(`Shared PigFS realm ${template.id} requires an authenticated Wurster Identity`);
      error.code = 'WURST_AUTH_REQUIRED';
      throw error;
    }
    if (governance === 'ordinary') {
      return { id: template.id, label: template.label ?? template.id, mount: template.mount ?? `/${template.id}`, ...(template.quotaBytes == null ? {} : { quotaBytes: template.quotaBytes }) };
    }
    if (governance === 'personal') {
      return { id: template.id, label: template.label ?? template.id, mount: template.mount ?? `/${template.id}`, governance: 'personal', ...(template.quotaBytes == null ? {} : { quotaBytes: template.quotaBytes }) };
    }
    const protection = String(template.protection ?? 'public');
    const read = String(template.read ?? (protection === 'sealed' ? 'owner' : 'public'));
    const write = String(template.write ?? 'owner');
    return {
      id: template.id,
      label: template.label ?? template.id,
      mount: template.mount ?? `/${template.id}`,
      governance: 'shared',
      audit: String(template.audit ?? 'none'),
      protection,
      ...(template.quotaBytes == null ? {} : { quotaBytes: template.quotaBytes }),
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
  const root = context.reader.pigFsRoot?.format === 'wurst/pigfs-1' ? context.reader.pigFsRoot : null;
  const identity = activeFilesystemIdentity(context);
  const identityId = identity?.publicRecord?.identityId ?? null;
  if (!root) {
    return (context.manifest.pigfs?.realms ?? []).map((template) => ({
      id: template.id,
      label: template.label ?? template.id,
      mount: template.mount ?? `/${template.id}`,
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
    const capabilities = pigFsRealmCapabilities(realm, identityId, { signedIdentity: Boolean(identityId) });
    return {
      id: realm.id,
      label: realm.label ?? realm.id,
      mount: realm.mount ?? context.manifest.pigfs?.realms?.find((item) => item.id === realm.id)?.mount ?? `/${realm.id}`,
      governance: pigFsRealmGovernance(realm),
      claimed: pigFsRealmGovernance(realm) === 'personal' ? Boolean(realm.claimed) : true,
      audit: realm.audit ?? 'none',
      protection: realm.protection,
      initialized: true,
      locked: realm.protection === 'sealed' && !context.pigFsStore?.realmKeys?.has(realm.id),
      capabilities,
      readers: realm.access?.read?.mode === 'members' ? [...realm.access.read.identities] : null,
      writers: realm.access?.write?.mode === 'members' ? [...realm.access.write.identities] : realm.access?.write?.mode ?? 'members',
      admins: [...(realm.access?.admins ?? [])]
    };
  });
}

ipcMain.handle('wurst:pigfs:capabilities', async (event) => {
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
      root: '/'
    };
  }
  return {
    read: true,
    write: Boolean(context.manifest.pigfs?.writable && !context.reader.carrier),
    persistent: true,
    snapshot: true,
    mediaUrls: true,
    compact: !context.reader.carrier && ((context.reader.pigFsRoot?.historyMode ?? null) === 'none' || (!context.reader.pigFsRoot && !(context.manifest.pigfs?.realms ?? []).some((realm) => realmTemplateGovernance(realm) === 'shared'))),
    protection: 'realms',
    format: 'wurst/pigfs-1',
    realms: true,
    signedMutations: (context.reader.pigFsRoot?.historyMode ?? null) === 'integrity',
    defaultStorage: 'ordinary',
    root: '/'
  };
});

ipcMain.handle('wurst:pigfs:realms', async (event) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) return [];
  return realmRuntimeSummary(context);
});

ipcMain.handle('wurst:pigfs:initialize', async (event) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) throw new Error('This Wurst does not declare PigFS realms');
  if (context.reader.pigFsRoot) return { initialized: false, generation: context.reader.pigFsRoot.generation, realms: realmRuntimeSummary(context) };
  const actor = activeFilesystemIdentity(context);
  if (!actor && realmTemplatesNeedIdentity(context)) {
    const error = new Error('Authenticate a Wurster Identity before initializing shared PigFS realms');
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
  return { initialized: true, generation: context.reader.pigFsRoot?.generation ?? 1, realms: realmRuntimeSummary(context) };
});

ipcMain.handle('wurst:pigfs:unlock-realm', async (event, rawRealmId) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) throw new Error('This Wurst does not use PigFS realms');
  const material = activeFilesystemIdentity(context);
  if (!material) {
    const error = new Error('Authenticate a Wurster Identity before unlocking a realm');
    error.code = 'WURST_AUTH_REQUIRED';
    throw error;
  }
  const result = await ensureRealmUnlockedForIdentity(context, String(rawRealmId ?? ''), material);
  return { ...result, realms: realmRuntimeSummary(context) };
});

ipcMain.handle('wurst:pigfs:lock-realm', async (event, rawRealmId) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) return { locked: false, realms: [] };
  const store = await ensureWurstFsStore(context);
  const locked = store.lockRealm(String(rawRealmId ?? ''));
  return { locked: Boolean(locked), realms: realmRuntimeSummary(context) };
});

ipcMain.handle('wurst:pigfs:history', async (event) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest) || !context.reader.pigFsRoot) return null;
  return context.reader.pigFsHistory();
});

ipcMain.handle('wurst:pigfs:usage', async (event) => {
  const context = assertWurstSender(event);
  return currentWurstFsUsage(context);
});

ipcMain.handle('wurst:pigfs:compact', async (event) => {
  const context = assertWurstSender(event);
  return compactCurrentWurstFs(context, { reason: 'wurst-request' });
});

ipcMain.handle('wurst:pigfs:stat', async (event, rawPath) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest)) return null;
  const target = pigFsPath(rawPath);
  if (target === 'data') return { path: '/', name: 'data', type: 'directory', size: 0, mime: null, revision: context.reader.pigFsRoot?.generation ?? 0 };
  if (!context.reader.pigFsRoot) return null;
  const entry = await context.reader.pigFsStat(target, await fsReadOptions(context, target));
  if (!entry) return null;
  return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
});

ipcMain.handle('wurst:pigfs:list', async (event, rawPath = '/') => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest) || !context.reader.pigFsRoot) return [];
  const target = pigFsPath(rawPath || '/');
  const entries = await context.reader.pigFsList(target, await fsReadOptions(context, target));
  return entries.map((entry) => entry.path?.startsWith('/') ? entry : ({ ...entry, path: `/${entry.path}` }));
});

ipcMain.handle('wurst:pigfs:read', async (event, rawPath, options = {}) => {
  const context = assertWurstSender(event);
  if (!realmDataMode(context.manifest) || !context.reader.pigFsRoot) return null;
  const target = pigFsPath(rawPath);
  const cryptoOptions = await fsReadOptions(context, target);
  const stat = await context.reader.pigFsStat(target, cryptoOptions);
  if (!stat || stat.type !== 'file') return null;
  const offset = Number(options?.offset ?? 0);
  const requested = options?.length == null ? MAX_PIG_FS_SLICE_BYTES : Number(options.length);
  const length = Math.min(requested, MAX_PIG_FS_SLICE_BYTES);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid PigFS read offset');
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid PigFS read length');
  const result = await context.reader.pigFsReadRange(target, offset, length, cryptoOptions);
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

ipcMain.handle('wurst:pigfs:begin-write', async (event, rawPath, options = {}) => {
  const context = assertWurstSender(event);
  await waitForWurstFsMaintenance(context);
  if (!realmDataMode(context.manifest) || !context.manifest.pigfs?.writable || context.reader.carrier) throw new Error('This Wurst PigFS is not writable');
  const target = pigFsPath(rawPath);
  if (target === 'data') throw new Error('Cannot write the PigFS root');
  const mime = typeof options?.mime === 'string' && options.mime.length <= 160 && !/[\r\n]/.test(options.mime)
    ? options.mime
    : mimeFor(target);
  const store = await ensureWurstFsInitializedForWrite(context);
  const actor = activeFilesystemIdentity(context);
  const writeId = store.beginWrite(target, { actor, mime });
  return { id: writeId, path: `/${target}`, chunkSize: MAX_PIG_FS_CHUNK_BYTES, signedBy: actor?.publicRecord?.identityId ?? null };
});

ipcMain.handle('wurst:pigfs:write-chunk', async (event, rawId, payload) => {
  const context = assertWurstSender(event);
  const store = await ensureWurstFsStore(context);
  const bytes = Buffer.isBuffer(payload)
    ? payload
    : payload instanceof Uint8Array
      ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
      : payload instanceof ArrayBuffer
        ? Buffer.from(payload)
        : Buffer.from(payload ?? []);
  if (bytes.length > MAX_PIG_FS_CHUNK_BYTES) throw new Error('PigFS chunks may not exceed 4 MiB');
  return store.writeChunk(rawId, bytes);
});

ipcMain.handle('wurst:pigfs:commit-write', async (event, rawId) => {
  const context = assertWurstSender(event);
  const store = await ensureWurstFsStore(context);
  const result = await store.commitWrite(rawId);
  await refreshWurstFsContext(context);
  scheduleWurstFsHygiene(context);
  const entry = result.entry;
  return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
});

ipcMain.handle('wurst:pigfs:abort-write', async (event, rawId) => {
  const context = assertWurstSender(event);
  return (await ensureWurstFsStore(context)).abortWrite(rawId);
});

ipcMain.handle('wurst:pigfs:remove', async (event, rawPath, options = {}) => {
  const context = assertWurstSender(event);
  await waitForWurstFsMaintenance(context);
  if (!realmDataMode(context.manifest) || !context.manifest.pigfs?.writable || context.reader.carrier) throw new Error('This Wurst PigFS is not writable');
  const store = await ensureWurstFsInitializedForWrite(context);
  const removed = await store.remove(pigFsPath(rawPath), { actor: activeFilesystemIdentity(context), recursive: Boolean(options?.recursive) });
  if (removed) { await refreshWurstFsContext(context); scheduleWurstFsHygiene(context, 700); }
  return removed;
});

ipcMain.handle('wurst:pigfs:mkdir', async (event, rawPath, options = {}) => {
  const context = assertWurstSender(event);
  await waitForWurstFsMaintenance(context);
  if (!realmDataMode(context.manifest) || !context.manifest.pigfs?.writable || context.reader.carrier) throw new Error('This Wurst PigFS is not writable');
  const store = await ensureWurstFsInitializedForWrite(context);
  const entry = await store.mkdir(pigFsPath(rawPath), { actor: activeFilesystemIdentity(context), recursive: options?.recursive !== false });
  await refreshWurstFsContext(context);
  scheduleWurstFsHygiene(context);
  return entry.path?.startsWith('/') ? entry : { ...entry, path: `/${entry.path}` };
});

ipcMain.handle('wurst:pigfs:rename', async (event, rawFrom, rawTo) => {
  const context = assertWurstSender(event);
  await waitForWurstFsMaintenance(context);
  if (!realmDataMode(context.manifest) || !context.manifest.pigfs?.writable || context.reader.carrier) throw new Error('This Wurst PigFS is not writable');
  const store = await ensureWurstFsInitializedForWrite(context);
  const entry = await store.rename(pigFsPath(rawFrom), pigFsPath(rawTo), { actor: activeFilesystemIdentity(context) });
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
    version: app.getVersion(),
    autoUpdate: settings.updates.autoUpdate,
    autoUpdateSupported: ['darwin', 'win32'].includes(process.platform),
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
ipcMain.handle('wurster:settings:update:auto', async (event, enabled) => { assertSettingsSender(event); const settings = await readWursterSettings(); settings.updates = { ...settings.updates, autoUpdate: Boolean(enabled) }; await writeWursterSettings(settings); return settingsContext(); });
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

function openLauncherWindow({ show = true, loadHome = true } = {}) {
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
  if (loadHome) {
    launcherView = 'launcher';
    void win.loadFile(LAUNCHER_HTML);
  }
  return win;
}

function inspectedWurstWebContents() {
  const focused = electronWebContents.getFocusedWebContents?.();
  if (focused && !focused.isDestroyed() && runtimeContextByWebContents.has(focused.id)) {
    lastFocusedRuntimeWebContentsId = focused.id;
    return focused;
  }

  if (Number.isInteger(lastFocusedRuntimeWebContentsId)) {
    const recent = electronWebContents.fromId(lastFocusedRuntimeWebContentsId);
    if (recent && !recent.isDestroyed() && runtimeContextByWebContents.has(recent.id)) return recent;
    lastFocusedRuntimeWebContentsId = null;
  }

  if (currentWindow && !currentWindow.isDestroyed()) {
    const renderer = currentWindow.webContents;
    if (renderer && !renderer.isDestroyed() && runtimeContextByWebContents.has(renderer.id)) return renderer;
  }

  for (const webContentsId of [...runtimeContextByWebContents.keys()].reverse()) {
    const renderer = electronWebContents.fromId(webContentsId);
    if (renderer && !renderer.isDestroyed()) return renderer;
    unbindRuntimeContextById(webContentsId);
  }
  return null;
}

function closeDetachedDevTools() {
  devToolsRuntime.close();
}

async function toggleWurstDevTools() {
  const inspected = inspectedWurstWebContents();
  if (!inspected) {
    dialog.showErrorBox('Wurst Developer Tools', 'No active Wurst renderer is available to inspect.');
    return false;
  }
  const context = runtimeContextByWebContents.get(inspected.id);
  const name = context?.manifest?.name ? String(context.manifest.name) : 'Wurst';
  try {
    await devToolsRuntime.toggle(inspected, { title: `${name} Developer Tools` });
    return true;
  } catch (error) {
    console.error('[Wurster DevTools]', error);
    dialog.showErrorBox('Wurst Developer Tools', error?.message || String(error));
    return false;
  }
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
        void toggleWurstDevTools();
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
      pigFsStore: null,
      pigFsMaintenance: null,
      pigFsHygieneTimer: null,
      sealedAppMap: null,
      identitySession: null,
      wurstIdentityMaterial: null,
      filesystemIdentityTimer: null,
      bootstrapWindow: null,
      bootstrapWebContents: null
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
    const newWindowWebContents = newWindow.webContents;
    const newWindowWebContentsId = newWindowWebContents.id;
    currentWindow = newWindow;
    bindRuntimeContext(newWindowWebContents, context);
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.hide();

    newWindow.setMenuBarVisibility(false);
    newWindowWebContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    newWindowWebContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('wurst://app/')) event.preventDefault();
    });
    newWindow.once('ready-to-show', () => {
      if (!newWindow.isDestroyed()) newWindow.show();
    });
    newWindow.on('closed', () => {
      // BrowserWindow.webContents throws after the native window has been
      // destroyed. Use the id captured while the renderer was alive.
      unbindRuntimeContextById(newWindowWebContentsId);
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
      context.bootstrapWebContents = newWindowWebContents;
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

async function loadDesktopAutoUpdater() {
  const module = await import('electron-updater');
  return module.autoUpdater ?? module.default?.autoUpdater ?? null;
}

async function runAutomaticStartupUpdate() {
  const settings = await readWursterSettings();
  let updateVisible = false;
  const result = await runStartupAutoUpdate({
    isPackaged: app.isPackaged,
    platform: process.platform,
    settings,
    loadUpdater: loadDesktopAutoUpdater,
    onState: async (state) => {
      if (state.phase === 'error' && !updateVisible) return;
      if (!updateVisible) {
        if (!launcherWindow || launcherWindow.isDestroyed()) openLauncherWindow({ show: false, loadHome: false });
        launcherView = 'update';
        launcherWindow.setMinimumSize(480, 350);
        launcherWindow.setMaximumSize(620, 460);
        launcherWindow.setSize(520, 380, true);
        launcherWindow.setTitle('Wurster Update');
        await launcherWindow.loadFile(UPDATE_HTML);
        launcherWindow.show();
        launcherWindow.focus();
        updateVisible = true;
      }
      launcherWindow.webContents.send('wurster:update:state', state);
    }
  });
  if (result.status === 'error') {
    console.warn('[Wurster Update]', result.error?.message || result.error);
    if (updateVisible) {
      await new Promise((resolve) => setTimeout(resolve, 1400));
      await showLauncherHome({ focus: false });
      launcherWindow?.hide();
    }
  }
  return result.status === 'installing';
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
  if (await runAutomaticStartupUpdate()) return;
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
