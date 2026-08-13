import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SIGNATURE_PATH,
  SEALED_APP_INDEX_PATH,
  classifyRisk,
  createPackageSignature,
  createPublisherCertificateRequest,
  createPublisherKeyBundle,
  publisherDnsRecordName,
  publisherDnsTxtValue,
  decodeWurst,
  descriptorsFromPackage,
  encodeWurst,
  embedWurstInPng,
  generateMeatphrase,
  generateWurstKey,
  normalizeCapabilities,
  openWurstFile,
  sealApplicationFiles,
  verifyPackageSignature,
  verifyPackageSignatureFromReader,
  verifyPublisherCertificate,
  verifyPublisherCertificateRequest
} from '@wurster/format';
import { normalizeWurstInterface, publicInterfaceManifest } from '@wurster/interface';
import { TRUSTED_AUTHORITIES, TRUST_BUNDLE } from './trust-data.mjs';

function withOfficialCertificateTrust(signature, additionalRoots = []) {
  if (!signature?.certificate?.record) return signature;
  const roots = [...TRUSTED_AUTHORITIES, ...(additionalRoots ?? [])];
  const certificate = verifyPublisherCertificate(signature.certificate.record, roots, new Date(), TRUST_BUNDLE);
  return { ...signature, certificate: { ...certificate, record: signature.certificate.record } };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(root, current = root, options = {}) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (options.skipDirs?.has(entry.name) || options.skipPaths?.has(relative)) continue;
      files.push(...await walk(root, absolute, options));
    } else if (entry.isFile()) {
      if (options.skipFiles?.has(entry.name) || options.skipPaths?.has(relative)) continue;
      files.push(absolute);
    }
  }
  return files;
}

async function collectDirectory(sourceDir, scope, prefix = '', options = {}) {
  if (!await exists(sourceDir)) return [];
  const all = await walk(sourceDir, sourceDir, options);
  const files = [];
  for (const absolute of all) {
    const relative = path.relative(sourceDir, absolute).split(path.sep).join('/');
    files.push({
      path: prefix ? `${prefix}/${relative}` : relative,
      data: await fs.readFile(absolute),
      scope
    });
  }
  return files;
}

function slug(value) {
  return String(value ?? 'wurst')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'wurst';
}

async function defaultProjectConfig(root) {
  const name = path.basename(root) || 'Wurst';
  const htmlFiles = (await walk(root, root, {
    skipDirs: new Set(['.git', 'node_modules', 'dist', 'build', '.cache', '.DS_Store']),
    skipFiles: new Set(['wurst.json'])
  }))
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((file) => file.toLowerCase().endsWith('.html'));
  const entry = htmlFiles.includes('index.html') ? 'index.html' : htmlFiles[0];
  if (!entry) throw new Error('No wurst.json and no HTML entry found. Add index.html or provide a wurst.json.');
  return {
    id: `local.wurst.${slug(name)}`,
    name,
    version: '0.0.0',
    entry,
    source: '.',
    outputName: slug(name),
    type: 'app',
    application: { protection: 'public' },
    protection: { storedIdentity: true },
    capabilities: {},
    window: { width: 900, height: 640, transparent: false, frame: true, resizable: true },
    versionedOutput: false,
    __generated: true
  };
}

function securityConfig(config) {
  return config.security && typeof config.security === 'object' ? config.security : {};
}

function realmDataConfig(config) {
  return config.data && typeof config.data === 'object' ? config.data : null;
}

function normalizeRealmDataPolicy(raw) {
  if (!raw) return null;
  if (raw.format !== 'wurst/data-realms-1') throw new Error('data.format must be wurst/data-realms-1');
  if (raw.writable === false) throw new Error('data.writable must be true; immutable resources belong in the signed application package');
  const realms = Array.isArray(raw.realms) ? raw.realms.map((realm) => {
    if (!realm || typeof realm !== 'object') throw new Error('WurstFS realm must be an object');
    if (Object.hasOwn(realm, 'mode')) throw new Error('WurstFS realm mode was removed; omit governance for ordinary storage or use governance: personal/shared');
    const governance = realm.governance == null ? '' : String(realm.governance).trim().toLowerCase();
    if (governance && !['personal', 'shared'].includes(governance)) throw new Error(`Unsupported WurstFS realm governance: ${governance}`);
    const audit = String(realm.audit ?? 'none').trim().toLowerCase();
    if (!['none', 'signed'].includes(audit)) throw new Error(`Unsupported WurstFS realm audit mode: ${audit}`);
    if (governance !== 'shared' && audit !== 'none') throw new Error('Only shared WurstFS realms can enable signed audit history');

    const base = {
      id: String(realm.id ?? ''),
      ...(realm.label == null ? {} : { label: String(realm.label).slice(0, 120) })
    };
    if (!governance) {
      for (const field of ['protection', 'read', 'write']) if (Object.hasOwn(realm, field)) throw new Error(`Ordinary WurstFS realm ${base.id} must omit ${field}`);
      return base;
    }
    if (governance === 'personal') {
      for (const field of ['protection', 'read', 'write']) if (Object.hasOwn(realm, field)) throw new Error(`Personal WurstFS realm ${base.id} must omit ${field}; it is sealed owner-only by definition`);
      return { ...base, governance: 'personal' };
    }
    const protection = String(realm.protection ?? 'public').trim().toLowerCase();
    const read = String(realm.read ?? (protection === 'sealed' ? 'owner' : 'public')).trim().toLowerCase();
    const write = String(realm.write ?? 'owner').trim().toLowerCase();
    if (!['public', 'sealed'].includes(protection)) throw new Error(`Unsupported shared WurstFS realm protection: ${protection}`);
    if (!['public', 'owner'].includes(read)) throw new Error('Shared WurstFS realm read must be public or owner');
    if (!['authenticated', 'owner'].includes(write)) throw new Error('Shared WurstFS realm write must be authenticated or owner');
    if (protection === 'sealed' && (read !== 'owner' || write !== 'owner')) throw new Error('Sealed shared realms begin owner-only; sharing is an explicit Wurster operation');
    return { ...base, governance: 'shared', protection, read, write, audit };
  }) : [];
  return { format: 'wurst/data-realms-1', writable: true, realms };
}

export async function buildWurst(projectDir, explicitOutput, options = {}) {
  const root = path.resolve(projectDir);
  const configPath = path.join(root, 'wurst.json');
  const hasConfig = await exists(configPath);
  const config = hasConfig
    ? JSON.parse(await fs.readFile(configPath, 'utf8'))
    : await defaultProjectConfig(root);
  options.onProgress?.({ stage: 'scan', progress: 0.08, message: hasConfig ? 'Reading wurst.json' : 'No manifest. Sniffing project defaults.' });
  const sourceDir = path.resolve(root, config.source ?? 'src');
  const interfaceCfg = normalizeWurstInterface(config.interface ?? null);
  const sealedDir = path.resolve(root, config.sealedSource ?? 'sealed');
  const appCfg = config.application && typeof config.application === 'object' ? config.application : {};
  const appProtection = appCfg.protection ?? 'public';
  if (!['public', 'partial', 'sealed'].includes(appProtection)) throw new Error('application.protection must be public, partial or sealed');

  let files = await collectDirectory(sourceDir, 'app', '', config.__generated ? {
    skipDirs: new Set(['.git', 'node_modules', 'dist', 'build', '.cache']),
    skipFiles: new Set(['wurst.json', '.DS_Store'])
  } : {});
  if (files.length === 0) throw new Error('Pig entered the Meat Grinder, but there was no meat in src/.');

  let interfaceManifest = null;
  if (interfaceCfg) {
    const interfaceSource = path.resolve(root, interfaceCfg.source);
    const relativeInterfaceSource = path.relative(root, interfaceSource);
    if (relativeInterfaceSource.startsWith('..') || path.isAbsolute(relativeInterfaceSource)) throw new Error('interface.source must stay inside the Wurst project');
    if (!await exists(interfaceSource)) throw new Error(`Wurst Interface source not found: ${interfaceCfg.source}`);
    const interfaceEntry = '__wurst/interface/entry.js';
    files.push({
      path: interfaceEntry,
      data: await fs.readFile(interfaceSource),
      scope: 'interface',
      mime: 'text/javascript; charset=utf-8'
    });
    interfaceManifest = publicInterfaceManifest(interfaceCfg, interfaceEntry);
  }

  options.onProgress?.({ stage: 'grind', progress: 0.28, message: `Grinding ${files.length} project files` });

  const hasSealedDir = hasConfig && await exists(sealedDir);
  if (hasSealedDir) {
    if (appProtection === 'public') throw new Error('sealed/ exists, but application.protection is public. Use partial or sealed.');
    const privateAppFiles = (await collectDirectory(sealedDir, 'app')).map((file) => ({ ...file, sealed: true }));
    files.push(...privateAppFiles);
  }

  if (Object.hasOwn(config, 'vault')) throw new Error('vault was removed before Wurster 1.0; use data.realms');
  const realmDataCfg = realmDataConfig(config);
  const dataDir = path.join(root, 'data');
  if (hasConfig && await exists(dataDir)) throw new Error('Top-level data/ factory content is not part of WurstFS. Runtime data starts empty; immutable seed data belongs in src/ or sealed/.');
  const realmDataPolicy = normalizeRealmDataPolicy(realmDataCfg);

  const presentationCfg = config.presentation && typeof config.presentation === 'object' ? config.presentation : {};
  const presentation = {};
  for (const field of ['icon', 'thumbnail']) {
    if (!presentationCfg[field]) continue;
    const source = path.resolve(root, presentationCfg[field]);
    if (path.extname(source).toLowerCase() !== '.png') throw new Error(`presentation.${field} must be a PNG`);
    const target = `__wurst/presentation/${field}.png`;
    files.push({ path: target, data: await fs.readFile(source), scope: 'meta', mime: 'image/png' });
    presentation[field] = target;
  }

  const secConfig = securityConfig(config);
  const signKeyPath = options.signKey ?? secConfig.signKey ?? null;
  const publisherKeyBundle = options.publisherKeyBundle ?? null;
  const certificatePath = options.certificatePath ?? secConfig.certificate ?? null;
  const publisherCertificate = options.publisherCertificate ?? null;
  const signingEnabled = Boolean(signKeyPath || publisherKeyBundle);
  const protectionCfg = config.protection && typeof config.protection === 'object' ? config.protection : {};
  if (Object.hasOwn(config, 'secureSurface')) {
    throw new Error('secureSurface was removed. Wurster Auth is runtime-owned and cannot be styled by a Wurst.');
  }
  const unknownProtectionKeys = Object.keys(protectionCfg).filter((key) => key !== 'storedIdentity');
  if (unknownProtectionKeys.length) {
    throw new Error(`Wurst protection policy is runtime-independent. Unsupported protection field(s): ${unknownProtectionKeys.join(', ')}. Only storedIdentity is currently portable policy.`);
  }

  let manifest = {
    format: 'wurst/7',
    id: config.id,
    name: config.name,
    version: config.version ?? '0.0.0',
    entry: config.entry ?? 'index.html',
    type: config.type ?? 'widget',
    application: {
      protection: appProtection
    },
    protection: {
      storedIdentity: protectionCfg.storedIdentity !== false
    },
    presentation: Object.keys(presentation).length ? presentation : null,
    interface: interfaceManifest,
    window: {
      width: 720,
      height: 480,
      transparent: false,
      frame: true,
      resizable: true,
      shadow: null,
      ...(config.window ?? {})
    },
    capabilities: normalizeCapabilities(config.capabilities),
    data: realmDataPolicy,
    security: {
      signed: signingEnabled
    },
    build: {
      meatGrinder: '0.20.0',
      generatedManifest: Boolean(config.__generated),
      createdAt: new Date().toISOString()
    }
  };

  if (!manifest.id || !manifest.name) throw new Error('wurst.json requires "id" and "name"');
  const configuredEntry = manifest.entry;
  const entryFile = files.find((file) => file.scope === 'app' && file.path === configuredEntry);
  if (!entryFile) throw new Error(`Entry file not found: ${configuredEntry}`);
  if (appProtection === 'partial' && entryFile.sealed) throw new Error('A partial application requires a public entry file in src/. Put only protected secondary resources in sealed/.');

  if (appProtection === 'sealed') {
    const appFiles = files.filter((file) => file.scope === 'app');
    const otherFiles = files.filter((file) => file.scope !== 'app');
    const map = {
      format: 'wurst/sealed-app-map-1',
      entry: configuredEntry,
      files: []
    };
    const opaqueFiles = appFiles.map((file, index) => {
      const resource = `__wurst/sealed-app/r${String(index).padStart(6, '0')}.wres`;
      map.files.push({ path: file.path, resource, mime: file.mime ?? null });
      return {
        path: resource,
        data: file.data,
        scope: 'app',
        mime: 'application/octet-stream',
        sealed: true
      };
    });
    files = [
      ...opaqueFiles,
      {
        path: SEALED_APP_INDEX_PATH,
        data: Buffer.from(JSON.stringify(map)),
        scope: 'app',
        mime: 'application/octet-stream',
        sealed: true
      },
      ...otherFiles
    ];
    manifest.entry = null;
    manifest.application.sealedIndex = SEALED_APP_INDEX_PATH;
  }

  options.onProgress?.({ stage: 'pack', progress: 0.56, message: 'Packing Wurst slices' });

  let generatedWurstKey = null;
  const hasProtectedApplicationPayload = files.some((file) => Boolean(file.sealed) && (file.scope ?? 'app') === 'app');
  if (hasProtectedApplicationPayload) {
    let wurstKey = options.wurstKey ?? process.env.WURST_APP_KEY ?? null;
    if (!wurstKey) {
      const generated = generateWurstKey();
      wurstKey = generated.wurstKey;
      generatedWurstKey = generated;
    }
    const sealed = sealApplicationFiles({ manifest, files, wurstKey });
    manifest = sealed.manifest;
    files = sealed.files;
  }

  let binary = encodeWurst({ manifest, files });

  let signature = null;
  if (signingEnabled) {
    const keyBundle = publisherKeyBundle ?? JSON.parse(await fs.readFile(path.resolve(root, signKeyPath), 'utf8'));
    const publisherPhrase = options.publisherMeatphrase ?? process.env.WURST_KEY_MEATPHRASE;
    if (!publisherPhrase) {
      throw new Error('Signing requires WURST_KEY_MEATPHRASE or --key-meatphrase-file. The private publisher key never leaves its encrypted .wurstkey file.');
    }
    const unsignedPkg = decodeWurst(binary, { verify: true });
    const certificate = publisherCertificate ?? (certificatePath
      ? JSON.parse(await fs.readFile(path.resolve(root, certificatePath), 'utf8'))
      : null);
    signature = createPackageSignature(unsignedPkg, keyBundle, publisherPhrase, { certificate });
    files = [
      ...files.filter((file) => file.path !== SIGNATURE_PATH),
      {
        path: SIGNATURE_PATH,
        data: Buffer.from(JSON.stringify(signature)),
        scope: 'signature',
        mime: 'application/json; charset=utf-8'
      }
    ];
    binary = encodeWurst({ manifest, files });
  }

  options.onProgress?.({ stage: 'seal', progress: 0.76, message: hasProtectedApplicationPayload ? 'Sealing protected content' : 'Checking the casing' });

  const finalPkg = decodeWurst(binary, { verify: true });
  const risk = classifyRisk(manifest);
  const signatureStatus = withOfficialCertificateTrust(verifyPackageSignature(finalPkg));
  if (signingEnabled && !signatureStatus.valid) throw new Error(`Internal signing verification failed: ${signatureStatus.error ?? 'unknown error'}`);

  const carrierPath = options.carrier ?? config.carrier ?? null;
  let outputBytes = binary;
  let carrier = null;
  if (carrierPath) {
    const absoluteCarrier = path.resolve(root, carrierPath);
    const carrierPng = await fs.readFile(absoluteCarrier);
    outputBytes = embedWurstInPng(carrierPng, binary);
    carrier = { type: 'png', source: absoluteCarrier };
  }

  const defaultExt = carrier ? '.png' : '.wurst';
  const outputBase = config.outputName ?? config.id.split('.').at(-1);
  const versionedBase = config.versionedOutput ? `${outputBase}-${manifest.version}` : outputBase;
  const defaultOutput = config.__generated
    ? path.join(path.dirname(root), `${versionedBase}${defaultExt}`)
    : path.join(root, 'dist', `${versionedBase}${defaultExt}`);
  const output = path.resolve(explicitOutput ?? defaultOutput);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, outputBytes);
  options.onProgress?.({ stage: 'done', progress: 1, message: carrier ? 'Undercover Wurst pressed into PNG' : 'Wurst ready' });
  return {
    output,
    manifest,
    bytes: outputBytes.length,
    wurstBytes: binary.length,
    carrier,
    fileCount: finalPkg.files().length,
    risk,
    signature: signatureStatus,
    generatedWurstKey,
    generatedManifest: Boolean(config.__generated),
    wurstFs: summarizeWurstFsRoot(finalPkg.wurstFsRoot)
  };
}

function summarizeWurstFsRoot(root) {
  if (!root) return null;
  const realms = Object.values(root.realms ?? {});
  const publicStats = realms.reduce((stats, realm) => {
    if (realm.protection !== 'public') return stats;
    stats.files += Number(realm.stats?.files ?? 0);
    stats.directories += Number(realm.stats?.directories ?? 0);
    stats.logicalBytes += Number(realm.stats?.logicalBytes ?? 0);
    return stats;
  }, { files: 0, directories: 0, logicalBytes: 0 });
  return {
    format: root.format,
    generation: root.generation,
    historyMode: root.historyMode,
    realmCount: realms.length,
    stats: publicStats,
    sealedMetadata: realms.some((realm) => realm.protection === 'sealed' || (realm.catalogPages ?? []).some((page) => Boolean(page.encryption)))
  };
}

export async function inspectWurst(filePath) {
  const absolute = path.resolve(filePath);
  const reader = await openWurstFile(absolute);
  try {
    const signature = withOfficialCertificateTrust(await verifyPackageSignatureFromReader(reader));
    return {
      path: absolute,
      bytes: reader.size,
      wurstBytes: reader.wurstSize ?? reader.size,
      carrier: reader.carrier ?? null,
      manifest: reader.manifest,
      risk: classifyRisk(reader.manifest),
      signature,
      wurstFs: summarizeWurstFsRoot(reader.wurstFsRoot),
      files: reader.entries().map(({ path: p, length, sha256, mime, scope, encryption, integrity }) => ({
        path: p,
        length,
        sha256,
        mime,
        scope,
        encrypted: Boolean(encryption),
        chunks: encryption?.chunks?.length ?? integrity?.chunks?.length ?? 1,
        plainLength: encryption?.plainLength ?? length
      }))
    };
  } finally {
    await reader.close();
  }
}

export async function verifyWurst(filePath, trustedRoots = []) {
  const absolute = path.resolve(filePath);
  const reader = await openWurstFile(absolute);
  try {
    const signature = withOfficialCertificateTrust(await verifyPackageSignatureFromReader(reader), trustedRoots);
    for (const entry of reader.entries()) await reader.read(entry.path, { verify: true });
    const sellerVerification = signature.certificate?.record ? signature.certificate : null;
    return {
      path: absolute,
      manifest: reader.manifest,
      risk: classifyRisk(reader.manifest),
      signature,
      sellerVerification,
      encrypted: reader.entries().some((entry) => Boolean(entry.encryption)),
      integrity: true
    };
  } finally {
    await reader.close();
  }
}

export async function createPublisher({ email = null, domain = null, label = null, output, meatphrase } = {}) {
  const created = createPublisherKeyBundle({ email, domain, label, meatphrase });
  const stem = domain || email || label || `publisher-${created.fingerprint.slice(0, 12)}`;
  const target = path.resolve(output ?? `${String(stem).replace(/[^a-z0-9._-]+/gi, '_')}.wurstkey`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(created.bundle, null, 2)}\n`, { mode: 0o600 });
  return {
    ...created,
    output: target,
    dns: created.bundle.domain ? {
      name: publisherDnsRecordName(created.bundle.domain),
      value: publisherDnsTxtValue(created.fingerprint)
    } : null
  };
}

export async function inspectPublisher(filePath) {
  const absolute = path.resolve(filePath);
  const bundle = JSON.parse(await fs.readFile(absolute, 'utf8'));
  return {
    path: absolute,
    format: bundle.format,
    algorithm: bundle.algorithm,
    label: bundle.label ?? null,
    email: bundle.email ?? null,
    domain: bundle.domain ?? null,
    fingerprint: bundle.fingerprint,
    dns: bundle.domain ? {
      name: publisherDnsRecordName(bundle.domain),
      value: publisherDnsTxtValue(bundle.fingerprint)
    } : null
  };
}


export async function createPublisherRequest({ publisherKey, publisherMeatphrase, output } = {}) {
  if (!publisherKey) throw new Error('publisherKey is required');
  if (!publisherMeatphrase) throw new Error('Publisher request requires the publisher Meatphrase');
  const keyPath = path.resolve(publisherKey);
  const bundle = JSON.parse(await fs.readFile(keyPath, 'utf8'));
  const request = createPublisherCertificateRequest(bundle, publisherMeatphrase);
  if (!bundle.email && !bundle.domain) throw new Error('Authority verification requires a publisher key with an email or domain claim');
  const identity = bundle.domain || bundle.email;
  const target = path.resolve(output ?? `${identity.replace(/[^a-z0-9._-]+/gi, '_')}.wurstreq`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(request, null, 2)}\n`);
  return { output: target, request, subject: request.statement.subject };
}

export async function requestRemoteAuthorityChallenge({ requestPath, authorityUrl = 'https://authority.wrst.io', output, fetchImpl = fetch } = {}) {
  if (!requestPath) throw new Error('requestPath is required');
  const request = JSON.parse(await fs.readFile(path.resolve(requestPath), 'utf8'));
  const requestStatus = verifyPublisherCertificateRequest(request);
  if (!requestStatus.valid) throw new Error(`Invalid publisher request: ${requestStatus.error}`);
  if (!requestStatus.subject.domain) throw new Error('WRST.IO domain verification requires a publisher domain claim');
  const endpoint = new URL('/v1/domain/challenge', authorityUrl).href;
  const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.challenge) throw new Error(body.message || `Authority domain challenge failed with HTTP ${response.status}`);
  const target = path.resolve(output ?? `${requestStatus.subject.domain.replace(/[^a-z0-9._-]+/gi, '_')}.wurstchallenge`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(body.challenge, null, 2)}
`);
  return { output: target, challenge: body.challenge, subject: requestStatus.subject };
}

async function readOptionalCertificate(certificatePath) {
  if (!certificatePath) return null;
  return JSON.parse(await fs.readFile(path.resolve(certificatePath), 'utf8'));
}
function defaultCertificateOutput(subject) {
  const identity = subject.domain || subject.email || subject.fingerprint.slice(0, 16);
  return `${identity.replace(/[^a-z0-9._-]+/gi, '_')}.wurstcert`;
}

export async function completeRemoteAuthorityChallenge({ requestPath, challengePath, certificatePath = null, authorityUrl = 'https://authority.wrst.io', output, fetchImpl = fetch } = {}) {
  if (!requestPath || !challengePath) throw new Error('requestPath and challengePath are required');
  const request = JSON.parse(await fs.readFile(path.resolve(requestPath), 'utf8'));
  const challenge = JSON.parse(await fs.readFile(path.resolve(challengePath), 'utf8'));
  const requestStatus = verifyPublisherCertificateRequest(request);
  if (!requestStatus.valid) throw new Error(`Invalid publisher request: ${requestStatus.error}`);
  const certificate = await readOptionalCertificate(certificatePath);
  const endpoint = new URL('/v1/domain/certificate', authorityUrl).href;
  const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request, challenge, certificate }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.certificate) throw new Error(body.message || `Authority domain certificate request failed with HTTP ${response.status}`);
  const target = path.resolve(output ?? defaultCertificateOutput(requestStatus.subject));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(body.certificate, null, 2)}
`);
  return { output: target, certificate: body.certificate, subject: requestStatus.subject, verification: verifyPublisherCertificate(body.certificate, TRUSTED_AUTHORITIES, new Date(), TRUST_BUNDLE) };
}

export async function requestRemoteAuthorityEmailChallenge({ requestPath, authorityUrl = 'https://authority.wrst.io', output, fetchImpl = fetch } = {}) {
  if (!requestPath) throw new Error('requestPath is required');
  const request = JSON.parse(await fs.readFile(path.resolve(requestPath), 'utf8'));
  const requestStatus = verifyPublisherCertificateRequest(request);
  if (!requestStatus.valid) throw new Error(`Invalid publisher request: ${requestStatus.error}`);
  if (!requestStatus.subject.email) throw new Error('WRST.IO email verification requires a publisher email claim');
  const endpoint = new URL('/v1/email/challenge', authorityUrl).href;
  const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.challenge) throw new Error(body.message || `Authority email challenge failed with HTTP ${response.status}`);
  const target = path.resolve(output ?? `${requestStatus.subject.email.replace(/[^a-z0-9._-]+/gi, '_')}.wurstmailchallenge`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(body.challenge, null, 2)}
`);
  return { output: target, challenge: body.challenge, subject: requestStatus.subject };
}

export async function completeRemoteAuthorityEmailChallenge({ requestPath, challengePath, code, certificatePath = null, authorityUrl = 'https://authority.wrst.io', output, fetchImpl = fetch } = {}) {
  if (!requestPath || !challengePath) throw new Error('requestPath and challengePath are required');
  if (!/^\d{6}$/.test(String(code ?? ''))) throw new Error('Email verification code must contain exactly six digits');
  const request = JSON.parse(await fs.readFile(path.resolve(requestPath), 'utf8'));
  const challenge = JSON.parse(await fs.readFile(path.resolve(challengePath), 'utf8'));
  const requestStatus = verifyPublisherCertificateRequest(request);
  if (!requestStatus.valid) throw new Error(`Invalid publisher request: ${requestStatus.error}`);
  const certificate = await readOptionalCertificate(certificatePath);
  const endpoint = new URL('/v1/email/certificate', authorityUrl).href;
  const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request, challenge, code: String(code), certificate }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.certificate) throw new Error(body.message || `Authority email certificate request failed with HTTP ${response.status}`);
  const target = path.resolve(output ?? defaultCertificateOutput(requestStatus.subject));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(body.certificate, null, 2)}
`);
  return { output: target, certificate: body.certificate, subject: requestStatus.subject, verification: verifyPublisherCertificate(body.certificate, TRUSTED_AUTHORITIES, new Date(), TRUST_BUNDLE) };
}


export async function inspectCertificate(filePath, trustedRoots = []) {
  const absolute = path.resolve(filePath);
  const certificate = JSON.parse(await fs.readFile(absolute, 'utf8'));
  return { path: absolute, certificate, verification: verifyPublisherCertificate(certificate, [...TRUSTED_AUTHORITIES, ...(trustedRoots ?? [])], new Date(), TRUST_BUNDLE) };
}

export { generateMeatphrase, generateWurstKey, descriptorsFromPackage };
