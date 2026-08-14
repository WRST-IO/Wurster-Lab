import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { domainToASCII } from 'node:url';
import {
  PNG_SIGNATURE,
  embedWurstInPng,
  extractWurstFromPng,
  isPngBuffer,
  openPngWurstSource
} from './png-carrier.js';
import {
  PIG_FS_DEFAULT_CHUNK_SIZE,
  PIG_FS_RECORD,
  decodeLatestFsRootFromBuffer,
  loadLatestFsRoot,
  readFsRecord
} from './pig-fs-records.js';
import {
  PIG_FS_FORMAT,
  PigFsStore,
  listPigFsDirectory,
  loadPigFsRealmCatalog,
  loadPigFsRealmChunks,
  measurePigFsStorage,
  normalizePigFsRealmId,
  normalizePigFsMount,
  readPigFsRange,
  statPigFsEntry,
  verifyPigFsHistory,
  computePigFsStateHash,
  computePigFsCommitHash,
  PIG_FS_HISTORY_NONE,
  pigFsRealmGovernance
} from './pig-fs.js';

export { PNG_SIGNATURE, embedWurstInPng, extractWurstFromPng, isPngBuffer } from './png-carrier.js';
export * from './pig-fs-records.js';
export * from './wurst-identity.js';
export * from './pig-fs.js';

export const MAGIC = Buffer.from('WRST');
export const FORMAT_VERSION = 7;
export const HEADER_SIZE = 24;
export const SIGNATURE_PATH = '__wurst/signature.json';
export const SEALED_APP_INDEX_PATH = '__wurst/sealed-app/index.json';
export const DEFAULT_INTEGRITY_CHUNK_SIZE = 4 * 1024 * 1024;
export const DEFAULT_PROTECTED_CHUNK_SIZE = PIG_FS_DEFAULT_CHUNK_SIZE;

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.wasm', 'application/wasm'],
  ['.sqlite', 'application/vnd.sqlite3'],
  ['.db', 'application/octet-stream'],
  ['.wurst', 'application/vnd.wrst.wurst'],
  ['.wrst', 'application/vnd.wrst.wurst']
]);

const MEATPHRASE_PREFIXES = [
  'smoked', 'cured', 'crispy', 'peppered', 'salted', 'roasted', 'grilled', 'seared',
  'charred', 'buttered', 'garlic', 'mustard', 'maple', 'hickory', 'oak', 'ember',
  'iron', 'copper', 'blackened', 'slowcook', 'hotpan', 'coldcut', 'brined', 'spiced',
  'juicy', 'lean', 'fatty', 'rustic', 'butcher', 'firepit', 'skillet', 'smoker'
];

const MEATPHRASE_NOUNS = [
  'wurst', 'bratwurst', 'sausage', 'bacon', 'ham', 'pork', 'brisket', 'rib',
  'steak', 'chop', 'cutlet', 'schnitzel', 'salami', 'pepperoni', 'prosciutto', 'pancetta',
  'jerky', 'meatball', 'tenderloin', 'sirloin', 'rump', 'belly', 'shank', 'hock',
  'roast', 'mince', 'patty', 'burger', 'butcher', 'cleaver', 'grinder', 'smoker',
  'skillet', 'griddle', 'skewer', 'marrow', 'bone', 'rind', 'lard', 'tallow',
  'crackling', 'casing', 'mustard', 'pepper', 'salt', 'garlic', 'onion', 'smoke',
  'ember', 'charcoal', 'hickory', 'oak', 'maple', 'grill', 'spit', 'hook',
  'apron', 'block', 'knife', 'fork', 'kettle', 'pan', 'rack', 'chiller'
];

if (MEATPHRASE_PREFIXES.length !== 32 || MEATPHRASE_NOUNS.length !== 64) {
  throw new Error('Meatphrase dictionary must provide exactly 2048 combinations');
}

const DEFAULT_SCRYPT = Object.freeze({
  name: 'scrypt',
  N: 65536,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 128 * 1024 * 1024
});

const AUTHORITY_ROOT_KDF = Object.freeze({
  name: 'scrypt',
  N: 65536,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 128 * 1024 * 1024
});
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function mimeFor(filePath) {
  return MIME.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function normalizeWurstPath(value) {
  const normalized = String(value).replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) throw new Error(`Invalid Wurst path: ${value}`);
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '.' || part === '')) throw new Error(`Unsafe Wurst path: ${value}`);
  return parts.join('/');
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

export function normalizeMeatphrase(value) {
  if (typeof value !== 'string') throw new Error('Meatphrase must be a string');
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('Meatphrase cannot be empty');
  return normalized;
}

export function generateMeatphrase(wordCount = 12) {
  const count = Number(wordCount);
  if (!Number.isInteger(count) || count < 6 || count > 32) throw new Error('Meatphrase word count must be between 6 and 32');
  const words = [];
  for (let i = 0; i < count; i += 1) {
    const prefix = MEATPHRASE_PREFIXES[crypto.randomInt(MEATPHRASE_PREFIXES.length)];
    const noun = MEATPHRASE_NOUNS[crypto.randomInt(MEATPHRASE_NOUNS.length)];
    words.push(`${prefix}-${noun}`);
  }
  const meatphrase = words.join(' ');
  return {
    meatphrase,
    tokens: words,
    words: words,
    entropyBits: count * 11,
    dictionarySize: 2048
  };
}


function scryptKey(meatphrase, metadata) {
  const normalized = normalizeMeatphrase(meatphrase);
  if (metadata?.name !== 'scrypt') throw new Error(`Unsupported Wurst KDF: ${metadata?.name}`);
  const salt = Buffer.from(metadata.salt, 'base64');
  return crypto.scryptSync(normalized, salt, metadata.keyLength, {
    N: metadata.N,
    r: metadata.r,
    p: metadata.p,
    maxmem: metadata.maxmem ?? DEFAULT_SCRYPT.maxmem
  });
}

function createScryptMetadata() {
  return {
    ...DEFAULT_SCRYPT,
    salt: crypto.randomBytes(16).toString('base64')
  };
}

function encryptAesGcm(plaintext, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext,
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decryptAesGcm(ciphertext, key, metadata, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(metadata.iv, 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(metadata.tag, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function normalizeCapabilities(input) {
  if (input == null) return {};
  if (Array.isArray(input)) return Object.fromEntries(input.map((name) => [String(name), true]));
  if (typeof input !== 'object') throw new Error('capabilities must be an array or object');
  return structuredClone(input);
}

const CAPABILITY_RISK = new Map([
  ['storage.local', 'yellow'],
  ['network', 'yellow'],
  ['pigsty', 'yellow'],
  ['piglet', 'yellow'],
  ['clipboard.write', 'yellow'],
  ['window.alwaysOnTop', 'green'],
  ['code.unsafeEval', 'yellow'],
  ['clipboard.read', 'red'],
  ['files.open', 'red'],
  ['files.save', 'red'],
  ['camera', 'red'],
  ['microphone', 'red'],
  ['geolocation', 'red'],
  ['screen.capture', 'red'],
  ['shell.openExternal', 'red']
]);

const RISK_SCORE = { green: 0, yellow: 1, red: 2 };

export function classifyRisk(manifest) {
  const capabilities = normalizeCapabilities(manifest?.capabilities);
  let level = 'green';
  const reasons = [];

  const raise = (next, reason) => {
    if (RISK_SCORE[next] > RISK_SCORE[level]) level = next;
    reasons.push({ level: next, reason });
  };

  if (manifest?.pigfs?.writable) {
    raise('yellow', 'Mutable PigFS data can modify the .wurst file itself.');
  }
  if (manifest?.piglet?.children?.length) {
    raise('yellow', `Piglet embeds ${manifest.piglet.children.length} child Wurst(s).`);
  }
  if (manifest?.pigsty) {
    raise('yellow', 'Pigsty internal computation requested.');
  }

  for (const [name, value] of Object.entries(capabilities)) {
    if (value === false || value == null) continue;
    const known = CAPABILITY_RISK.get(name);
    if (!known) {
      raise('red', `Unknown capability requested: ${name}`);
      continue;
    }

    if (name === 'network') {
      if (!Array.isArray(value) || value.length === 0) {
        raise('red', 'Network capability is not restricted to explicit HTTPS origins.');
        continue;
      }
      const invalid = value.some((origin) => {
        try {
          const url = new URL(origin);
          return url.protocol !== 'https:' || url.hostname.includes('*') || url.pathname !== '/' || url.search || url.hash || url.username || url.password;
        } catch {
          return true;
        }
      });
      raise(invalid ? 'red' : 'yellow', invalid
        ? 'Network allowlist contains an unsafe or invalid origin.'
        : `Network access to ${value.length} explicit HTTPS origin(s).`);
      continue;
    }

    raise(known, `${name} requested.`);
  }

  return {
    level,
    reasons,
    signaturePolicy: level === 'green' ? 'optional' : level === 'yellow' ? 'recommended' : 'required'
  };
}

export function networkOrigins(manifest) {
  const caps = normalizeCapabilities(manifest?.capabilities);
  return Array.isArray(caps.network) ? caps.network : [];
}

function normalizeFileDescriptor(file) {
  const safePath = normalizeWurstPath(file.path);
  const bytes = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
  return {
    path: safePath,
    data: bytes,
    mime: file.mime ?? mimeFor(safePath),
    scope: file.scope ?? 'app',
    encryption: file.encryption ? structuredClone(file.encryption) : undefined,
    integrity: file.integrity ? structuredClone(file.integrity) : undefined,
    sealed: Boolean(file.sealed)
  };
}

function chunkIntegrity(bytes, chunkSize = DEFAULT_INTEGRITY_CHUNK_SIZE) {
  const chunks = [];
  for (let offset = 0, index = 0; offset < bytes.length; offset += chunkSize, index += 1) {
    const length = Math.min(chunkSize, bytes.length - offset);
    const chunk = bytes.subarray(offset, offset + length);
    chunks.push({ index, offset, length, sha256: sha256(chunk) });
  }
  if (bytes.length === 0) chunks.push({ index: 0, offset: 0, length: 0, sha256: sha256(Buffer.alloc(0)) });
  return { format: 'wurst/integrity-chunks-1', chunkSize, chunks };
}

function assertWrst7Manifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest must be an object');
  if (manifest.format !== 'wurst/7') throw new Error('WRST v7 requires manifest.format = "wurst/7"');
  if (Object.hasOwn(manifest, 'vault')) throw new Error('WRST v7 no longer supports vault; mutable data uses pigfs: { format: "wurst/pigfs-policy-1" }');
  if (manifest.pigfs != null) {
    if (typeof manifest.pigfs !== 'object' || manifest.pigfs.format !== 'wurst/pigfs-policy-1') throw new Error('WRST v7 PigFS policy must use wurst/pigfs-policy-1');
    if (manifest.pigfs.writable !== true) throw new Error('WRST v7 PigFS policy requires writable: true');
    if (manifest.pigfs.realms != null) {
      if (!Array.isArray(manifest.pigfs.realms) || manifest.pigfs.realms.length > 32) throw new Error('WRST v7 pigfs.realms must be an array of at most 32 realm templates');
      const ids = new Set();
      const mounts = [];
      for (const rawRealm of manifest.pigfs.realms) {
        if (!rawRealm || typeof rawRealm !== 'object') throw new Error('WRST v7 PigFS realm template must be an object');
        if (Object.hasOwn(rawRealm, 'mode')) throw new Error('WRST v7 PigFS realm mode was removed; omit governance for ordinary storage or use governance: personal/shared');
        const id = normalizePigFsRealmId(rawRealm.id);
        if (ids.has(id)) throw new Error(`Duplicate WRST v7 PigFS realm template ${id}`);
        ids.add(id);
        const mount = normalizePigFsMount(rawRealm.mount, id);
        if (mounts.some((existing) => mount === existing || mount.startsWith(`${existing}/`) || existing.startsWith(`${mount}/`))) throw new Error(`Overlapping WRST v7 PigFS realm mount ${mount}`);
        mounts.push(mount);
        if (rawRealm.quotaBytes != null && (!Number.isSafeInteger(Number(rawRealm.quotaBytes)) || Number(rawRealm.quotaBytes) <= 0)) throw new Error(`Invalid WRST v7 PigFS quota for realm ${id}`);
        const governance = rawRealm.governance == null ? '' : String(rawRealm.governance).trim().toLowerCase();
        if (governance && !['personal', 'shared'].includes(governance)) throw new Error(`Unsupported WRST v7 PigFS realm governance ${governance}`);
        const audit = String(rawRealm.audit ?? 'none').trim().toLowerCase();
        if (!['none', 'signed'].includes(audit)) throw new Error(`Unsupported WRST v7 PigFS realm audit mode ${audit}`);
        if (governance !== 'shared' && audit !== 'none') throw new Error('Only shared WRST v7 PigFS realms can enable signed audit history');

        if (!governance) {
          for (const field of ['protection', 'read', 'write']) {
            if (Object.hasOwn(rawRealm, field)) throw new Error(`Ordinary WRST v7 PigFS realm ${id} must omit ${field}; ordinary storage is public/open by definition`);
          }
          continue;
        }

        if (governance === 'personal') {
          for (const field of ['protection', 'read', 'write']) {
            if (Object.hasOwn(rawRealm, field)) throw new Error(`Personal WRST v7 PigFS realm ${id} must omit ${field}; personal storage is sealed owner-only by definition`);
          }
          continue;
        }

        const protection = String(rawRealm.protection ?? 'public').trim().toLowerCase();
        const read = String(rawRealm.read ?? (protection === 'sealed' ? 'owner' : 'public')).trim().toLowerCase();
        const write = String(rawRealm.write ?? 'owner').trim().toLowerCase();
        if (!['public', 'sealed'].includes(protection)) throw new Error(`Unsupported WRST v7 shared realm protection ${protection}`);
        if (!['public', 'owner'].includes(read)) throw new Error('WRST v7 shared realm read template must be public or owner');
        if (!['authenticated', 'owner'].includes(write)) throw new Error('WRST v7 shared realm write template must be authenticated or owner');
        if (protection === 'sealed' && (read !== 'owner' || write !== 'owner')) throw new Error('Sealed shared WRST v7 realm templates begin owner-only; sharing is an explicit post-genesis operation');
      }
    }
  }
  if (manifest.piglet != null) {
    if (typeof manifest.piglet !== 'object' || manifest.piglet.format !== 'wurst/piglet-1') throw new Error('WRST v7 piglet policy must use wurst/piglet-1');
    if (!Array.isArray(manifest.piglet.children) || manifest.piglet.children.length > 64) throw new Error('WRST v7 piglet.children must be an array of at most 64 child Wursts');
    const ids = new Set();
    for (const child of manifest.piglet.children) {
      if (!child || typeof child !== 'object') throw new Error('WRST v7 piglet child must be an object');
      const id = String(child.id ?? '');
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(id)) throw new Error(`Invalid WRST v7 piglet child id: ${id}`);
      if (ids.has(id)) throw new Error(`Duplicate WRST v7 piglet child id: ${id}`);
      ids.add(id);
      if (!child.entry || typeof child.entry !== 'string') throw new Error(`WRST v7 piglet child ${id} requires an immutable entry path`);
      if (!child.sha256 || typeof child.sha256 !== 'string') throw new Error(`WRST v7 piglet child ${id} requires sha256`);
    }
  }
  if (manifest.pigsty != null) {
    if (typeof manifest.pigsty !== 'object' || manifest.pigsty.format !== 'wurst/pigsty-1') throw new Error('WRST v7 pigsty policy must use wurst/pigsty-1');
    if (manifest.pigsty.version !== 'node-lts-1') throw new Error('WRST v7 pigsty.version currently supports node-lts-1');
    if (manifest.pigsty.toolchain != null) {
      const toolchain = manifest.pigsty.toolchain;
      if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain) || toolchain.format !== 'wurst/pigsty-toolchain-1') throw new Error('WRST v7 pigsty.toolchain must use wurst/pigsty-toolchain-1');
      if (!toolchain.root || typeof toolchain.root !== 'string') throw new Error('WRST v7 pigsty.toolchain.root must be a path string');
      if (toolchain.root.startsWith('/') || toolchain.root.includes('..') || toolchain.root.startsWith('__wurst/')) throw new Error('WRST v7 pigsty.toolchain.root must stay inside the Wurst workspace');
    }
    if (manifest.pigsty.builds != null) {
      if (typeof manifest.pigsty.builds !== 'object' || Array.isArray(manifest.pigsty.builds)) throw new Error('WRST v7 pigsty.builds must be an object');
      for (const [name, build] of Object.entries(manifest.pigsty.builds)) {
        if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(name)) throw new Error(`Invalid WRST v7 pigsty build name: ${name}`);
        if (!build || typeof build !== 'object' || Array.isArray(build)) throw new Error(`WRST v7 pigsty build ${name} must be an object`);
        if (!build.source || typeof build.source !== 'string') throw new Error(`WRST v7 pigsty build ${name} requires source`);
        if (!/\.(?:js|mjs)$/i.test(build.source)) throw new Error(`WRST v7 pigsty build ${name}.source must be JavaScript`);
        if (build.mode != null) throw new Error(`WRST v7 pigsty build ${name}.mode is not supported; Pigsty engine selection is a runtime implementation detail`);
        if (build.outputs != null && (!Array.isArray(build.outputs) || build.outputs.some((item) => typeof item !== 'string'))) throw new Error(`WRST v7 pigsty build ${name}.outputs must be an array of paths`);
      }
    }
  }
  return manifest;
}

function assertFsPolicyMatchesRoot(manifest, root) {
  if (!root) return;
  if (root.format !== PIG_FS_FORMAT) throw new Error(`Unsupported PigFS root format ${root.format ?? 'missing'}`);
  if (manifest.pigfs?.format !== 'wurst/pigfs-policy-1') throw new Error('PigFS data exists but this Wurst declares no PigFS policy');
}

export function encodeWurst({ manifest, files }) {
  assertWrst7Manifest(manifest);
  if (!Array.isArray(files) || files.length === 0) throw new Error('files must be a non-empty array');

  let payloadOffset = 0;
  const seen = new Set();
  const immutableFiles = [];

  for (const file of files) {
    const normalized = normalizeFileDescriptor(file);
    if (normalized.scope === 'pigfs') {
      throw new Error('Mutable PigFS data is runtime state. Build immutable app/meta/PigLink resources, then initialize PigFS realms through PigFS.');
    }
    if (!['app', 'piglink', 'piglet', 'meta', 'signature'].includes(normalized.scope)) throw new Error(`Unsupported immutable Wurst scope: ${normalized.scope}`);
    const canonicalPath = normalized.path;
    const duplicateKey = `base:${canonicalPath}`;
    if (seen.has(duplicateKey)) throw new Error(`Duplicate Wurst path: ${canonicalPath}`);
    seen.add(duplicateKey);

    const entry = {
      path: canonicalPath,
      offset: payloadOffset,
      length: normalized.data.length,
      sha256: sha256(normalized.data),
      mime: normalized.mime,
      scope: normalized.scope,
      integrity: normalized.integrity ?? chunkIntegrity(normalized.data)
    };
    if (normalized.encryption) entry.encryption = normalized.encryption;
    payloadOffset += normalized.data.length;
    immutableFiles.push({ entry, bytes: normalized.data });
  }

  if (!immutableFiles.length) throw new Error('A Wurst requires at least one immutable application resource');
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const index = {
    format: 'wurst/index-7',
    files: immutableFiles.map(({ entry }) => entry)
  };
  const indexBytes = Buffer.from(JSON.stringify(index));
  const payload = Buffer.concat(immutableFiles.map(({ bytes }) => bytes));

  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt16LE(FORMAT_VERSION, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(manifestBytes.length, 8);
  header.writeUInt32LE(indexBytes.length, 12);
  // v7 length is the immutable payload only. Mutable PigFS records may follow it.
  header.writeBigUInt64LE(BigInt(payload.length), 16);

  const base = Buffer.concat([header, manifestBytes, indexBytes, payload]);
  return base;
}

export function decodeWurst(buffer, { verify = true } = {}) {
  let bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!bytes.subarray(0, 4).equals(MAGIC) && isPngBuffer(bytes)) bytes = extractWurstFromPng(bytes);
  if (bytes.length < HEADER_SIZE) throw new Error('File is too small to be a Wurst');
  if (!bytes.subarray(0, 4).equals(MAGIC)) throw new Error('Invalid Wurst magic');

  const version = bytes.readUInt16LE(4);
  if (version !== FORMAT_VERSION) throw new Error(`Unsupported Wurst format version ${version}`);

  const flags = bytes.readUInt16LE(6);
  const manifestLength = bytes.readUInt32LE(8);
  const indexLength = bytes.readUInt32LE(12);
  const payloadLengthBig = bytes.readBigUInt64LE(16);
  if (payloadLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Wurst payload is too large for this runtime');
  const payloadLength = Number(payloadLengthBig);
  const manifestStart = HEADER_SIZE;
  const indexStart = manifestStart + manifestLength;
  const payloadStart = indexStart + indexLength;
  const baseLength = payloadStart + payloadLength;

  if (baseLength > bytes.length) throw new Error('Corrupt Wurst length table');

  const manifest = JSON.parse(bytes.subarray(manifestStart, indexStart).toString('utf8'));
  assertWrst7Manifest(manifest);
  const index = JSON.parse(bytes.subarray(indexStart, payloadStart).toString('utf8'));
  if (index?.format !== 'wurst/index-7' || !Array.isArray(index.files)) throw new Error('Invalid Wurst file index');

  const fileMap = new Map();
  for (const rawEntry of index.files) {
    const safePath = normalizeWurstPath(rawEntry.path);
    if (fileMap.has(safePath)) throw new Error(`Duplicate Wurst path in index: ${safePath}`);
    if (!Number.isSafeInteger(rawEntry.offset) || !Number.isSafeInteger(rawEntry.length) || rawEntry.offset < 0 || rawEntry.length < 0) {
      throw new Error(`Invalid range metadata for ${safePath}`);
    }
    const start = payloadStart + rawEntry.offset;
    const end = start + rawEntry.length;
    if (start < payloadStart || end > baseLength || end < start) throw new Error(`Invalid range for ${safePath}`);
    const data = bytes.subarray(start, end);
    if (verify && sha256(data) !== rawEntry.sha256) throw new Error(`Integrity check failed for ${safePath}`);
    fileMap.set(safePath, {
      ...rawEntry,
      path: safePath,
      scope: rawEntry.scope ?? 'app',
      data
    });
  }

  const { root: pigFsRoot, commitOffset: pigFsCommitOffset } = decodeLatestFsRootFromBuffer(bytes, baseLength, PIG_FS_FORMAT);
  assertFsPolicyMatchesRoot(manifest, pigFsRoot);

  return {
    version,
    flags,
    manifest,
    index,
    baseLength,
    pigFsRoot,
    pigFsCommitOffset,
    raw: bytes,
    get(filePath) {
      return fileMap.get(normalizeWurstPath(filePath));
    },
    has(filePath) {
      return fileMap.has(normalizeWurstPath(filePath));
    },
    files() {
      return [...fileMap.values()];
    }
  };
}


async function readExact(fileHandle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error('Unexpected end of Wurst file');
    offset += bytesRead;
  }
  return buffer;
}

export async function openWurstFile(filePath) {
  const handle = await fs.open(filePath, 'r');
  let closed = false;
  try {
    const stat = await handle.stat();
    if (stat.size < HEADER_SIZE) throw new Error('File is too small to be a Wurst');

    const probeLength = Math.min(8, stat.size);
    const probe = await readExact(handle, probeLength, 0);
    let source;
    if (probe.length >= 4 && probe.subarray(0, 4).equals(MAGIC)) {
      source = {
        size: stat.size,
        carrier: null,
        read: (position, length) => readExact(handle, length, position)
      };
    } else if (probe.length >= PNG_SIGNATURE.length && probe.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      source = await openPngWurstSource(handle, stat.size);
    } else {
      throw new Error('Invalid Wurst magic and no supported Wurst carrier detected');
    }

    if (source.size < HEADER_SIZE) throw new Error('Embedded Wurst is too small');
    const header = await source.read(0, HEADER_SIZE);
    if (!header.subarray(0, 4).equals(MAGIC)) throw new Error('Invalid embedded Wurst magic');
    const version = header.readUInt16LE(4);
    if (version !== FORMAT_VERSION) throw new Error(`Unsupported Wurst format version ${version}`);
    const flags = header.readUInt16LE(6);
    const manifestLength = header.readUInt32LE(8);
    const indexLength = header.readUInt32LE(12);
    const payloadLengthBig = header.readBigUInt64LE(16);
    if (payloadLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Wurst payload is too large for this Node runtime');
    const payloadLength = Number(payloadLengthBig);
    const manifestStart = HEADER_SIZE;
    const indexStart = manifestStart + manifestLength;
    const payloadStart = indexStart + indexLength;
    const baseLength = payloadStart + payloadLength;
    if (baseLength > source.size) throw new Error('Corrupt Wurst length table');

    const metadata = await source.read(HEADER_SIZE, manifestLength + indexLength);
    const manifest = JSON.parse(metadata.subarray(0, manifestLength).toString('utf8'));
    assertWrst7Manifest(manifest);
    const index = JSON.parse(metadata.subarray(manifestLength).toString('utf8'));
    if (index?.format !== 'wurst/index-7' || !Array.isArray(index.files)) throw new Error('Invalid Wurst file index');

    const entries = new Map();
    for (const rawEntry of index.files) {
      const safePath = normalizeWurstPath(rawEntry.path);
      if (entries.has(safePath)) throw new Error(`Duplicate Wurst path in index: ${safePath}`);
      if (!Number.isSafeInteger(rawEntry.offset) || !Number.isSafeInteger(rawEntry.length) || rawEntry.offset < 0 || rawEntry.length < 0) {
        throw new Error(`Invalid range metadata for ${safePath}`);
      }
      const virtualOffset = payloadStart + rawEntry.offset;
      const resourceEnd = virtualOffset + rawEntry.length;
      if (virtualOffset < payloadStart || resourceEnd > baseLength || resourceEnd < virtualOffset) throw new Error(`Invalid range for ${safePath}`);
      entries.set(safePath, { ...rawEntry, path: safePath, scope: rawEntry.scope ?? 'app', virtualOffset });
    }

    const { root: pigFsRoot, commitOffset: pigFsCommitOffset } = await loadLatestFsRoot(source, baseLength, PIG_FS_FORMAT);
    assertFsPolicyMatchesRoot(manifest, pigFsRoot);

    return {
      version,
      flags,
      manifest,
      index,
      baseLength,
      pigFsRoot,
      pigFsCommitOffset,
      source,
      size: stat.size,
      wurstSize: source.size,
      payloadStart,
      carrier: source.carrier ? { ...source.carrier } : null,
      entries() {
        return [...entries.values()].map((entry) => ({ ...entry }));
      },
      has(resourcePath) {
        return entries.has(normalizeWurstPath(resourcePath));
      },
      entry(resourcePath) {
        const entry = entries.get(normalizeWurstPath(resourcePath));
        return entry ? { ...entry } : undefined;
      },
      async pigFsStat(fsPath, options = {}) {
        return this.pigFsRoot ? statPigFsEntry(source, this.pigFsRoot, fsPath, options) : null;
      },
      async pigFsList(fsPath = '/data', options = {}) {
        return this.pigFsRoot ? listPigFsDirectory(source, this.pigFsRoot, fsPath, options) : [];
      },
      async pigFsReadRange(fsPath, offset = 0, length = null, options = {}) {
        return this.pigFsRoot ? readPigFsRange(source, this.pigFsRoot, fsPath, offset, length, options) : null;
      },
      async pigFsHistory() {
        return this.pigFsRoot ? verifyPigFsHistory(source, this.baseLength) : { valid: true, format: PIG_FS_FORMAT, historyMode: PIG_FS_HISTORY_NONE, root: null, commitOffset: null, commits: [] };
      },
      async refreshWurstFs() {
        const loaded = await loadLatestFsRoot(source, baseLength, PIG_FS_FORMAT);
        assertFsPolicyMatchesRoot(manifest, loaded.root);
        this.pigFsRoot = loaded.root;
        this.pigFsCommitOffset = loaded.commitOffset;
        this.wurstSize = source.size;
        return { root: this.pigFsRoot, commitOffset: this.pigFsCommitOffset };
      },
      async read(resourcePath, { verify = true } = {}) {
        if (closed) throw new Error('Wurst file reader is closed');
        const entry = entries.get(normalizeWurstPath(resourcePath));
        if (!entry) return undefined;
        const data = await source.read(entry.virtualOffset, entry.length);
        if (verify && sha256(data) !== entry.sha256) throw new Error(`Integrity check failed for ${entry.path}`);
        return { ...entry, data };
      },
      async readRange(resourcePath, offset = 0, length = null, { verify = true } = {}) {
        if (closed) throw new Error('Wurst file reader is closed');
        const entry = entries.get(normalizeWurstPath(resourcePath));
        if (!entry) return undefined;
        const start = Number(offset);
        if (!Number.isSafeInteger(start) || start < 0 || start > entry.length) throw new Error(`Invalid resource range offset for ${entry.path}`);
        const wanted = length == null ? entry.length - start : Number(length);
        if (!Number.isSafeInteger(wanted) || wanted < 0) throw new Error(`Invalid resource range length for ${entry.path}`);
        const end = Math.min(entry.length, start + wanted);
        if (end < start) throw new Error(`Invalid resource range for ${entry.path}`);

        let data;
        if (verify) {
          const integrity = entry.integrity;
          if (!integrity || integrity.format !== 'wurst/integrity-chunks-1' || !Array.isArray(integrity.chunks)) {
            throw new Error(`Missing chunk integrity metadata for ${entry.path}`);
          }
          const pieces = [];
          let total = 0;
          for (const chunk of integrity.chunks) {
            const chunkStart = chunk.offset;
            const chunkEnd = chunk.offset + chunk.length;
            if (chunkEnd <= start || chunkStart >= end) continue;
            const chunkBytes = await source.read(entry.virtualOffset + chunk.offset, chunk.length);
            if (sha256(chunkBytes) !== chunk.sha256) throw new Error(`Integrity check failed for ${entry.path} chunk ${chunk.index}`);
            const sliceStart = Math.max(start, chunkStart) - chunkStart;
            const sliceEnd = Math.min(end, chunkEnd) - chunkStart;
            const piece = Buffer.from(chunkBytes.subarray(sliceStart, sliceEnd));
            total += piece.length;
            pieces.push(piece);
          }
          data = Buffer.concat(pieces, total);
        } else {
          data = await source.read(entry.virtualOffset + start, end - start);
        }
        return { ...entry, range: { offset: start, length: data.length, total: entry.length }, data };
      },
      async close() {
        if (closed) return;
        closed = true;
        await handle.close();
      }
    };
  } catch (error) {
    if (!closed) {
      closed = true;
      try { await handle.close(); } catch {}
    }
    throw error;
  }
}

function packageManifestProjection(manifest) {
  return structuredClone(manifest);
}

function packageDigestProjection(pkg) {
  const immutableFiles = pkg.index.files
    .filter((entry) => ['app', 'meta', 'piglink', 'piglet'].includes(entry.scope ?? 'app') && entry.path !== SIGNATURE_PATH)
    .map((entry) => ({
      path: entry.path,
      length: entry.length,
      sha256: entry.sha256,
      mime: entry.mime,
      scope: entry.scope ?? 'app',
      encryption: entry.encryption ?? null,
      integrity: entry.integrity ?? null
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    format: 'wurst/signing-projection-7',
    manifest: packageManifestProjection(pkg.manifest),
    immutableFiles
  };
}

export function packageDigest(pkg) {
  return sha256(Buffer.from(canonicalStringify(packageDigestProjection(pkg))));
}

export function normalizePublisherDomain(value) {
  const raw = String(value ?? '').trim().replace(/\.$/, '').toLowerCase();
  if (!raw) return null;
  if (raw.includes('://') || raw.includes('/') || raw.includes('@') || raw.includes('*')) {
    throw new Error('Publisher domain must be a bare DNS name');
  }
  const ascii = domainToASCII(raw).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.includes('.')) throw new Error('Publisher domain is invalid');
  for (const label of ascii.split('.')) {
    if (!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new Error('Publisher domain is invalid');
    }
  }
  return ascii;
}

export function publisherDnsRecordName(domain) {
  return `_wurst.${normalizePublisherDomain(domain)}`;
}

export function publisherDnsTxtValue(fingerprint) {
  const value = String(fingerprint ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Publisher fingerprint must be a SHA-256 hex value');
  return `wurst1 ed25519=${value}`;
}

export function parsePublisherDnsTxt(records) {
  const flattened = [];
  for (const record of records ?? []) {
    const text = Array.isArray(record) ? record.join('') : String(record ?? '');
    const match = text.trim().match(/^wurst1\s+ed25519=([a-f0-9]{64})$/i);
    if (match) flattened.push(match[1].toLowerCase());
  }
  return [...new Set(flattened)];
}

export function verifyPublisherDomainRecords({ domain, fingerprint, records } = {}) {
  const normalizedDomain = normalizePublisherDomain(domain);
  const expected = String(fingerprint ?? '').trim().toLowerCase();
  const authorized = parsePublisherDnsTxt(records);
  if (!authorized.length) return { status: 'unverified', verified: false, conflict: false, domain: normalizedDomain, authorized };
  if (authorized.includes(expected)) return { status: 'verified', verified: true, conflict: false, domain: normalizedDomain, authorized };
  return { status: 'conflict', verified: false, conflict: true, domain: normalizedDomain, authorized };
}

export function createPublisherKeyBundle({ email = null, domain = null, label = null, meatphrase } = {}) {
  const normalizedEmail = email == null || String(email).trim() === '' ? null : String(email).trim().toLowerCase();
  if (normalizedEmail && !/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw new Error('Publisher email is invalid');
  const normalizedDomain = domain == null || String(domain).trim() === '' ? null : normalizePublisherDomain(domain);
  const normalizedLabel = label == null || String(label).trim() === '' ? null : String(label).trim().slice(0, 120);
  const phraseInfo = meatphrase ? { meatphrase: normalizeMeatphrase(meatphrase), entropyBits: null } : generateMeatphrase(12);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const fingerprint = sha256(publicDer);
  const kdf = createScryptMetadata();
  const kek = scryptKey(phraseInfo.meatphrase, kdf);
  const aad = `wurst-publisher-key:${fingerprint}`;
  const encrypted = encryptAesGcm(privateDer, kek, aad);
  kek.fill(0);
  privateDer.fill(0);

  return {
    meatphrase: phraseInfo.meatphrase,
    entropyBits: phraseInfo.entropyBits,
    fingerprint,
    bundle: {
      format: 'wurst/publisher-key-1',
      algorithm: 'ed25519',
      label: normalizedLabel,
      email: normalizedEmail,
      domain: normalizedDomain,
      fingerprint,
      publicKeySpki: publicDer.toString('base64'),
      privateKey: {
        encryptedPkcs8: encrypted.ciphertext.toString('base64'),
        cipher: 'aes-256-gcm',
        iv: encrypted.iv,
        tag: encrypted.tag,
        aad,
        kdf
      }
    }
  };
}

export function publisherIdentityFromBundle(bundle) {
  if (bundle?.format !== 'wurst/publisher-key-1' || bundle.algorithm !== 'ed25519') {
    throw new Error('Unsupported publisher key format');
  }
  return {
    label: bundle.label ?? null,
    email: bundle.email ?? null,
    domain: bundle.domain ? normalizePublisherDomain(bundle.domain) : null,
    fingerprint: bundle.fingerprint,
    publicKeySpki: bundle.publicKeySpki
  };
}

function normalizeAuthorityId(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!raw || raw.includes('/') || raw.includes('@') || raw.includes('*')) throw new Error('Authority id must be a bare DNS name');
  return normalizePublisherDomain(raw);
}

function ed25519PrivateKeyFromSeed(seed) {
  const raw = Buffer.from(seed);
  if (raw.length !== 32) throw new Error('Ed25519 seed must contain exactly 32 bytes');
  try {
    return crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, raw]), type: 'pkcs8', format: 'der' });
  } finally {
    raw.fill(0);
  }
}

function deriveAuthorityRootPrivateKey(meatphrase, authorityId = 'wrst.io') {
  const normalized = normalizeMeatphrase(meatphrase);
  const authority = normalizeAuthorityId(authorityId);
  const salt = Buffer.from(`wurst-authority-root-v1:${authority}`, 'utf8');
  const seed = crypto.scryptSync(normalized, salt, AUTHORITY_ROOT_KDF.keyLength, {
    N: AUTHORITY_ROOT_KDF.N,
    r: AUTHORITY_ROOT_KDF.r,
    p: AUTHORITY_ROOT_KDF.p,
    maxmem: AUTHORITY_ROOT_KDF.maxmem
  });
  try {
    return ed25519PrivateKeyFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

export function deriveAuthorityRoot({ authority = 'wrst.io', name = 'WRST.IO Root Authority', meatphrase, createdAt = null } = {}) {
  if (!meatphrase) throw new Error('Root Authority Meatphrase is required');
  const authorityId = normalizeAuthorityId(authority);
  const privateKey = deriveAuthorityRootPrivateKey(meatphrase, authorityId);
  const publicKey = crypto.createPublicKey(privateKey);
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const fingerprint = sha256(publicDer);
  return {
    privateKey,
    fingerprint,
    publicRecord: {
      format: 'wurst/authority-root-1',
      authority: authorityId,
      algorithm: 'ed25519',
      name: String(name || 'Wurst Root Authority').trim(),
      fingerprint,
      publicKeySpki: publicDer.toString('base64'),
      ...(createdAt ? { createdAt: new Date(createdAt).toISOString() } : {})
    }
  };
}

export function createAuthorityRoot({ authority = 'wrst.io', name = 'WRST.IO Root Authority', meatphrase = null, createdAt = new Date().toISOString() } = {}) {
  const phraseInfo = meatphrase
    ? { meatphrase: normalizeMeatphrase(meatphrase), entropyBits: null }
    : generateMeatphrase(24);
  const derived = deriveAuthorityRoot({ authority, name, meatphrase: phraseInfo.meatphrase, createdAt });
  return {
    meatphrase: phraseInfo.meatphrase,
    entropyBits: phraseInfo.entropyBits,
    fingerprint: derived.fingerprint,
    publicRecord: derived.publicRecord
  };
}

function encryptAuthorityIssuerPrivateKey(privateDer, metadata, meatphrase) {
  const kdf = createScryptMetadata();
  const kek = scryptKey(meatphrase, kdf);
  const aad = `wurst-authority-issuer-key:${metadata.authority}:${metadata.issuerId}:${metadata.fingerprint}`;
  const encrypted = encryptAesGcm(privateDer, kek, aad);
  kek.fill(0);
  return {
    encryptedPkcs8: encrypted.ciphertext.toString('base64'),
    cipher: 'aes-256-gcm',
    iv: encrypted.iv,
    tag: encrypted.tag,
    aad,
    kdf
  };
}

export function createAuthorityIssuer({
  rootMeatphrase,
  rootPublic = null,
  authority = 'wrst.io',
  issuerId = null,
  name = null,
  issuerMeatphrase = null,
  issuedAt = new Date().toISOString(),
  expiresAt = null
} = {}) {
  if (!rootMeatphrase) throw new Error('Root Authority Meatphrase is required to create an issuer');
  const authorityId = normalizeAuthorityId(authority);
  const rootName = rootPublic?.name || (authorityId === 'wrst.io' ? 'WRST.IO Root Authority' : `${authorityId} Root Authority`);
  const root = deriveAuthorityRoot({ authority: authorityId, name: rootName, meatphrase: rootMeatphrase, createdAt: rootPublic?.createdAt ?? null });
  if (rootPublic && (root.publicRecord.fingerprint !== rootPublic.fingerprint || root.publicRecord.publicKeySpki !== rootPublic.publicKeySpki)) {
    throw new Error('Root Authority Meatphrase does not match the supplied public root');
  }

  const phraseInfo = issuerMeatphrase
    ? { meatphrase: normalizeMeatphrase(issuerMeatphrase), entropyBits: null }
    : generateMeatphrase(16);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const fingerprint = sha256(publicDer);
  const id = String(issuerId || `${authorityId}-issuer-${String(issuedAt).slice(0, 4)}-01`).trim();
  const issuerName = String(name || `${authorityId.toUpperCase()} Issuing Authority`).trim();
  const publicRecord = {
    format: 'wurst/authority-issuer-public-1',
    authority: authorityId,
    issuerId: id,
    algorithm: 'ed25519',
    name: issuerName,
    fingerprint,
    publicKeySpki: publicDer.toString('base64')
  };

  let encryptedPrivateKey;
  try {
    encryptedPrivateKey = encryptAuthorityIssuerPrivateKey(privateDer, publicRecord, phraseInfo.meatphrase);
  } finally {
    privateDer.fill(0);
  }
  const bundle = {
    ...publicRecord,
    format: 'wurst/authority-issuer-key-1',
    privateKey: encryptedPrivateKey
  };
  const statement = {
    format: 'wurst/authority-issuer-certificate-statement-1',
    serial: crypto.randomUUID(),
    authority: authorityId,
    root: root.publicRecord,
    issuer: publicRecord,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
  };
  const signature = crypto.sign(null, Buffer.from(canonicalStringify(statement)), root.privateKey);
  const certificate = {
    format: 'wurst/authority-issuer-certificate-1',
    algorithm: 'ed25519',
    statement,
    signature: signature.toString('base64')
  };
  return {
    meatphrase: phraseInfo.meatphrase,
    entropyBits: phraseInfo.entropyBits,
    fingerprint,
    bundle,
    certificate,
    publicRecord
  };
}

export function unlockAuthorityIssuerPrivateKey(bundle, meatphrase) {
  if (bundle?.format !== 'wurst/authority-issuer-key-1' || bundle.algorithm !== 'ed25519') {
    throw new Error('Unsupported Authority issuer key format');
  }
  const metadata = bundle.privateKey;
  const kek = scryptKey(meatphrase, metadata.kdf);
  let privateDer;
  try {
    privateDer = decryptAesGcm(Buffer.from(metadata.encryptedPkcs8, 'base64'), kek, metadata, metadata.aad);
  } catch {
    throw new Error('Wrong issuer Meatphrase or damaged issuer key file');
  } finally {
    kek.fill(0);
  }
  try {
    const privateKey = crypto.createPrivateKey({ key: privateDer, type: 'pkcs8', format: 'der' });
    const publicDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    if (sha256(publicDer) !== bundle.fingerprint) throw new Error('Issuer private key does not match its public fingerprint');
    return privateKey;
  } finally {
    privateDer.fill(0);
  }
}

function trustedRootMatches(root, trustedAuthorities) {
  return (trustedAuthorities ?? []).some((candidate) => {
    if (!candidate || candidate.algorithm !== 'ed25519') return false;
    return candidate.fingerprint === root.fingerprint && candidate.publicKeySpki === root.publicKeySpki;
  });
}

export function verifyAuthorityIssuerCertificate(certificate, trustedAuthorities = [], now = new Date()) {
  try {
    if (certificate?.format !== 'wurst/authority-issuer-certificate-1' || certificate.algorithm !== 'ed25519') {
      throw new Error('Unsupported Authority issuer certificate');
    }
    const statement = certificate.statement;
    const { root, issuer } = statement ?? {};
    if (root?.format !== 'wurst/authority-root-1' || issuer?.format !== 'wurst/authority-issuer-public-1') throw new Error('Issuer certificate chain is incomplete');
    if (root.authority !== issuer.authority || statement.authority !== root.authority) throw new Error('Issuer certificate authority mismatch');
    const rootDer = Buffer.from(root.publicKeySpki, 'base64');
    const issuerDer = Buffer.from(issuer.publicKeySpki, 'base64');
    if (sha256(rootDer) !== root.fingerprint) throw new Error('Authority root fingerprint mismatch');
    if (sha256(issuerDer) !== issuer.fingerprint) throw new Error('Authority issuer fingerprint mismatch');
    const rootKey = crypto.createPublicKey({ key: rootDer, type: 'spki', format: 'der' });
    if (!crypto.verify(null, Buffer.from(canonicalStringify(statement)), rootKey, Buffer.from(certificate.signature, 'base64'))) {
      throw new Error('Authority issuer certificate signature is invalid');
    }
    const current = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(current.getTime())) throw new Error('Invalid certificate verification time');
    if (statement.issuedAt && current < new Date(statement.issuedAt)) return { status: 'not-yet-valid', valid: true, trusted: false, root, issuer, statement };
    if (statement.expiresAt && current > new Date(statement.expiresAt)) return { status: 'expired', valid: true, trusted: false, root, issuer, statement };
    const trusted = trustedRootMatches(root, trustedAuthorities);
    return { status: trusted ? 'verified' : 'valid-untrusted', valid: true, trusted, root, issuer, statement };
  } catch (error) {
    return { status: 'invalid', valid: false, trusted: false, root: null, issuer: null, error: error.message };
  }
}

function normalizeCertificateClaim(claim) {
  if (!claim || typeof claim !== 'object') throw new Error('Publisher certificate claim is invalid');
  const type = String(claim.type ?? '').trim().toLowerCase();
  let value = String(claim.value ?? '').trim();
  if (type === 'domain') value = normalizePublisherDomain(value);
  else if (type === 'email') {
    value = value.toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(value)) throw new Error('Publisher certificate email claim is invalid');
  } else throw new Error(`Unsupported publisher certificate claim type: ${type || 'empty'}`);
  const verification = claim.verification && typeof claim.verification === 'object' ? structuredClone(claim.verification) : { method: 'authority-issued' };
  return { type, value, verification };
}

function dedupeCertificateClaims(claims = []) {
  const out = [];
  const seen = new Set();
  for (const raw of claims ?? []) {
    const claim = normalizeCertificateClaim(raw);
    const key = `${claim.type}:${claim.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

function certificateSubjectWithClaims(subject, claims) {
  const normalizedClaims = dedupeCertificateClaims(claims);
  const domain = normalizedClaims.find((claim) => claim.type === 'domain')?.value;
  const email = normalizedClaims.find((claim) => claim.type === 'email')?.value;
  return {
    ...subject,
    ...(domain ? { domain } : {}),
    ...(email ? { email } : {})
  };
}

export function createPublisherCertificateFromIssuer({
  request,
  issuerBundle,
  issuerMeatphrase,
  issuerCertificate,
  verification = null,
  claims = null,
  issuedAt = new Date().toISOString(),
  expiresAt = null
} = {}) {
  const requestStatus = verifyPublisherCertificateRequest(request);
  if (!requestStatus.valid) throw new Error(`Invalid publisher request: ${requestStatus.error}`);
  const chainStatus = verifyAuthorityIssuerCertificate(issuerCertificate);
  if (!chainStatus.valid) throw new Error(`Invalid Authority issuer certificate: ${chainStatus.error}`);
  if (issuerBundle?.fingerprint !== chainStatus.issuer.fingerprint || issuerBundle?.publicKeySpki !== chainStatus.issuer.publicKeySpki) {
    throw new Error('Authority issuer key does not match the issuer certificate');
  }
  const privateKey = unlockAuthorityIssuerPrivateKey(issuerBundle, issuerMeatphrase);
  if (!claims) throw new Error('Publisher certificate issuance requires explicit verified claims');
  const verifiedClaims = dedupeCertificateClaims(claims);
  if (!verifiedClaims.length) throw new Error('Publisher certificate requires at least one verified claim');
  for (const claim of verifiedClaims) {
    if (claim.type === 'domain' && claim.value !== requestStatus.subject.domain) throw new Error('Verified domain claim does not belong to publisher request');
    if (claim.type === 'email' && claim.value !== requestStatus.subject.email) throw new Error('Verified email claim does not belong to publisher request');
  }
  const statement = {
    format: 'wurst/publisher-certificate-statement-3',
    serial: crypto.randomUUID(),
    subject: {
      fingerprint: requestStatus.subject.fingerprint,
      publicKeySpki: requestStatus.subject.publicKeySpki
    },
    claims: verifiedClaims,
    issuer: chainStatus.issuer,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
  };
  const signature = crypto.sign(null, Buffer.from(canonicalStringify(statement)), privateKey);
  return {
    format: 'wurst/publisher-certificate-3',
    algorithm: 'ed25519',
    statement,
    issuerCertificate,
    signature: signature.toString('base64')
  };
}

export function createTrustBundle({
  rootMeatphrase,
  rootPublic,
  authority = 'wrst.io',
  version = 1,
  issuers = [],
  revokedIssuers = [],
  revokedPublishers = [],
  generatedAt = new Date().toISOString()
} = {}) {
  if (!rootMeatphrase) throw new Error('Root Authority Meatphrase is required to sign a trust bundle');
  const authorityId = normalizeAuthorityId(authority);
  const rootName = rootPublic?.name || (authorityId === 'wrst.io' ? 'WRST.IO Root Authority' : `${authorityId} Root Authority`);
  const root = deriveAuthorityRoot({ authority: authorityId, name: rootName, meatphrase: rootMeatphrase, createdAt: rootPublic?.createdAt ?? null });
  if (rootPublic && (root.publicRecord.fingerprint !== rootPublic.fingerprint || root.publicRecord.publicKeySpki !== rootPublic.publicKeySpki)) {
    throw new Error('Root Authority Meatphrase does not match the supplied public root');
  }
  const bundleVersion = Number(version);
  if (!Number.isSafeInteger(bundleVersion) || bundleVersion < 1) throw new Error('Trust bundle version must be a positive integer');
  const statement = {
    format: 'wurst/trust-bundle-statement-1',
    authority: authorityId,
    version: bundleVersion,
    generatedAt: new Date(generatedAt).toISOString(),
    root: root.publicRecord,
    issuers: structuredClone(issuers),
    revokedIssuers: [...new Set(revokedIssuers.map((value) => String(value).trim().toLowerCase()).filter(Boolean))],
    revokedPublishers: [...new Set(revokedPublishers.map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
  };
  const signature = crypto.sign(null, Buffer.from(canonicalStringify(statement)), root.privateKey);
  return { format: 'wurst/trust-bundle-1', algorithm: 'ed25519', statement, signature: signature.toString('base64') };
}

export function verifyTrustBundle(bundle, trustedAuthorities = [], now = new Date()) {
  try {
    if (bundle?.format !== 'wurst/trust-bundle-1' || bundle.algorithm !== 'ed25519') throw new Error('Unsupported Wurst trust bundle');
    const statement = bundle.statement;
    const root = statement?.root;
    if (statement?.format !== 'wurst/trust-bundle-statement-1' || root?.format !== 'wurst/authority-root-1') throw new Error('Trust bundle statement is incomplete');
    const rootDer = Buffer.from(root.publicKeySpki, 'base64');
    if (sha256(rootDer) !== root.fingerprint) throw new Error('Trust bundle root fingerprint mismatch');
    const rootKey = crypto.createPublicKey({ key: rootDer, type: 'spki', format: 'der' });
    if (!crypto.verify(null, Buffer.from(canonicalStringify(statement)), rootKey, Buffer.from(bundle.signature, 'base64'))) throw new Error('Trust bundle signature is invalid');
    const current = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(current.getTime())) throw new Error('Invalid trust bundle verification time');
    const trusted = trustedRootMatches(root, trustedAuthorities);
    return { status: trusted ? 'verified' : 'valid-untrusted', valid: true, trusted, statement, root };
  } catch (error) {
    return { status: 'invalid', valid: false, trusted: false, statement: null, root: null, error: error.message };
  }
}

function trustBundleRevocations(trustBundle, trustedAuthorities, now) {
  if (!trustBundle) return { revokedIssuers: new Set(), revokedPublishers: new Set(), status: null };
  const status = verifyTrustBundle(trustBundle, trustedAuthorities, now);
  if (!status.valid || !status.trusted) return { revokedIssuers: new Set(), revokedPublishers: new Set(), status };
  return {
    revokedIssuers: new Set((status.statement.revokedIssuers ?? []).map((value) => String(value).toLowerCase())),
    revokedPublishers: new Set((status.statement.revokedPublishers ?? []).map((value) => String(value).toLowerCase())),
    status
  };
}

export function createPublisherCertificateRequest(publisherBundle, publisherMeatphrase) {
  const subject = publisherIdentityFromBundle(publisherBundle);
  const privateKey = unlockPublisherPrivateKey(publisherBundle, publisherMeatphrase);
  const statement = {
    format: 'wurst/publisher-certificate-request-statement-1',
    subject,
    nonce: crypto.randomBytes(16).toString('base64')
  };
  const signature = crypto.sign(null, Buffer.from(canonicalStringify(statement)), privateKey);
  return {
    format: 'wurst/publisher-certificate-request-1',
    algorithm: 'ed25519',
    statement,
    signature: signature.toString('base64')
  };
}

export function verifyPublisherCertificateRequest(request) {
  try {
    if (request?.format !== 'wurst/publisher-certificate-request-1' || request.algorithm !== 'ed25519') {
      throw new Error('Unsupported publisher certificate request');
    }
    const { subject } = request.statement ?? {};
    if ((!subject?.email && !subject?.domain) || !subject?.publicKeySpki || !subject?.fingerprint) throw new Error('Publisher certificate request needs an email or domain identity plus key material');
    const publicDer = Buffer.from(subject.publicKeySpki, 'base64');
    if (sha256(publicDer) !== subject.fingerprint) throw new Error('Publisher request fingerprint mismatch');
    const publicKey = crypto.createPublicKey({ key: publicDer, type: 'spki', format: 'der' });
    const valid = crypto.verify(
      null,
      Buffer.from(canonicalStringify(request.statement)),
      publicKey,
      Buffer.from(request.signature, 'base64')
    );
    if (!valid) throw new Error('Publisher request proof-of-possession failed');
    return { valid: true, subject };
  } catch (error) {
    return { valid: false, error: error.message, subject: null };
  }
}

export function verifyPublisherCertificate(certificate, trustedAuthorities = [], now = new Date(), trustBundle = null) {
  try {
    if (certificate?.format !== 'wurst/publisher-certificate-3' || certificate.algorithm !== 'ed25519') throw new Error('Unsupported publisher certificate');
    const current = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(current.getTime())) throw new Error('Invalid certificate verification time');
    const statement = certificate.statement;
    const rawSubject = statement?.subject;
    const issuer = statement?.issuer;
    const claims = dedupeCertificateClaims(statement?.claims ?? []);
    if (statement?.format !== 'wurst/publisher-certificate-statement-3' || !rawSubject?.fingerprint || !rawSubject?.publicKeySpki || !claims.length) {
      throw new Error('Publisher certificate subject or claims are incomplete');
    }
    if (issuer?.format !== 'wurst/authority-issuer-public-1' || !issuer?.fingerprint || !issuer?.publicKeySpki) throw new Error('Publisher certificate issuer is incomplete');
    const chain = verifyAuthorityIssuerCertificate(certificate.issuerCertificate, trustedAuthorities, current);
    if (!chain.valid) throw new Error(`Publisher certificate issuer chain is invalid: ${chain.error}`);
    if (chain.issuer.fingerprint !== issuer.fingerprint || chain.issuer.publicKeySpki !== issuer.publicKeySpki || chain.issuer.issuerId !== issuer.issuerId) {
      throw new Error('Publisher certificate issuer does not match its Authority certificate');
    }
    const subjectDer = Buffer.from(rawSubject.publicKeySpki, 'base64');
    if (sha256(subjectDer) !== rawSubject.fingerprint) throw new Error('Publisher certificate subject fingerprint mismatch');
    const issuerDer = Buffer.from(issuer.publicKeySpki, 'base64');
    if (sha256(issuerDer) !== issuer.fingerprint) throw new Error('Publisher certificate issuer fingerprint mismatch');
    const issuerKey = crypto.createPublicKey({ key: issuerDer, type: 'spki', format: 'der' });
    if (!crypto.verify(null, Buffer.from(canonicalStringify(statement)), issuerKey, Buffer.from(certificate.signature, 'base64'))) {
      throw new Error('Publisher certificate signature is invalid');
    }
    const subject = certificateSubjectWithClaims(rawSubject, claims);
    if (statement.issuedAt && current < new Date(statement.issuedAt)) return { status: 'not-yet-valid', valid: true, trusted: false, subject, claims, issuer, statement, chain };
    if (statement.expiresAt && current > new Date(statement.expiresAt)) return { status: 'expired', valid: true, trusted: false, subject, claims, issuer, statement, chain };
    const revocations = trustBundleRevocations(trustBundle, trustedAuthorities, current);
    if (revocations.revokedIssuers.has(String(issuer.fingerprint).toLowerCase())) {
      return { status: 'revoked-issuer', valid: true, trusted: false, subject, claims, issuer, statement, chain, trustBundle: revocations.status };
    }
    if (revocations.revokedPublishers.has(String(subject.fingerprint).toLowerCase())) {
      return { status: 'revoked-publisher', valid: true, trusted: false, subject, claims, issuer, statement, chain, trustBundle: revocations.status };
    }
    const trusted = chain.trusted;
    return {
      status: trusted ? 'verified' : 'valid-untrusted',
      valid: true,
      trusted,
      subject,
      claims,
      issuer,
      root: chain.root,
      statement,
      chain,
      trustBundle: revocations.status
    };
  } catch (error) {
    return { status: 'invalid', valid: false, trusted: false, subject: null, issuer: null, error: error.message };
  }
}

export function unlockPublisherPrivateKey(bundle, meatphrase) {
  if (bundle?.format !== 'wurst/publisher-key-1' || bundle.algorithm !== 'ed25519') throw new Error('Unsupported publisher key format');
  const metadata = bundle.privateKey;
  const kek = scryptKey(meatphrase, metadata.kdf);
  let privateDer;
  try {
    privateDer = decryptAesGcm(Buffer.from(metadata.encryptedPkcs8, 'base64'), kek, metadata, metadata.aad);
  } catch {
    throw new Error('Wrong publisher Meatphrase or damaged key file');
  } finally {
    kek.fill(0);
  }
  try {
    return crypto.createPrivateKey({ key: privateDer, type: 'pkcs8', format: 'der' });
  } finally {
    privateDer.fill(0);
  }
}

export function createPackageSignature(pkg, publisherBundle, publisherMeatphrase, { certificate = null } = {}) {
  const privateKey = unlockPublisherPrivateKey(publisherBundle, publisherMeatphrase);
  const digest = packageDigest(pkg);
  const statement = {
    format: 'wurst/signature-statement-1',
    packageDigest: `sha256:${digest}`,
    publisher: {
      label: publisherBundle.label ?? null,
      email: publisherBundle.email ?? null,
      domain: publisherBundle.domain ? normalizePublisherDomain(publisherBundle.domain) : null,
      fingerprint: publisherBundle.fingerprint,
      publicKeySpki: publisherBundle.publicKeySpki
    }
  };
  const statementBytes = Buffer.from(canonicalStringify(statement));
  if (certificate) {
    const certificateStatus = verifyPublisherCertificate(certificate);
    if (!certificateStatus.valid) throw new Error(`Publisher certificate is invalid: ${certificateStatus.error}`);
    const subject = certificateStatus.subject;
    const publisherDomain = publisherBundle.domain ? normalizePublisherDomain(publisherBundle.domain) : null;
    const publisherEmail = publisherBundle.email ?? null;
    const claimMismatch = certificateStatus.claims.some((claim) =>
      (claim.type === 'domain' && normalizePublisherDomain(claim.value) !== publisherDomain)
      || (claim.type === 'email' && claim.value !== publisherEmail)
    );
    if (claimMismatch || subject.fingerprint !== publisherBundle.fingerprint || subject.publicKeySpki !== publisherBundle.publicKeySpki) {
      throw new Error('Publisher certificate does not belong to this publisher key');
    }
  }
  const signature = crypto.sign(null, statementBytes, privateKey);
  return {
    format: 'wurst/signature-1',
    algorithm: 'ed25519',
    statement,
    signature: signature.toString('base64'),
    certificate
  };
}

function verifyPackageSignatureRecord(pkg, record) {
  try {
    if (record?.format !== 'wurst/signature-1' || record.algorithm !== 'ed25519') throw new Error('Unsupported Wurst signature format');
    const statement = record.statement;
    const publicDer = Buffer.from(statement.publisher.publicKeySpki, 'base64');
    const fingerprint = sha256(publicDer);
    if (fingerprint !== statement.publisher.fingerprint) throw new Error('Publisher fingerprint mismatch');
    const expectedDigest = `sha256:${packageDigest(pkg)}`;
    if (statement.packageDigest !== expectedDigest) throw new Error('Signed package digest mismatch');
    const publicKey = crypto.createPublicKey({ key: publicDer, type: 'spki', format: 'der' });
    const valid = crypto.verify(null, Buffer.from(canonicalStringify(statement)), publicKey, Buffer.from(record.signature, 'base64'));
    if (!valid) throw new Error('Ed25519 signature verification failed');
    let certificate = null;
    if (record.certificate) {
      const certificateStatus = verifyPublisherCertificate(record.certificate);
      if (certificateStatus.valid) {
        const subject = certificateStatus.subject;
        const statementDomain = statement.publisher.domain ? normalizePublisherDomain(statement.publisher.domain) : null;
        const statementEmail = statement.publisher.email ?? null;
        const claims = certificateStatus.claims;
        const claimsMatch = claims.every((claim) =>
          (claim.type === 'domain' && normalizePublisherDomain(claim.value) === statementDomain)
          || (claim.type === 'email' && claim.value === statementEmail)
        );
        const matches = claimsMatch
          && subject.fingerprint === fingerprint
          && subject.publicKeySpki === statement.publisher.publicKeySpki;
        certificate = matches
          ? { ...certificateStatus, record: record.certificate }
          : { status: 'invalid', valid: false, trusted: false, error: 'Publisher certificate subject does not match package signer', record: record.certificate };
      } else {
        certificate = { ...certificateStatus, record: record.certificate };
      }
    }
    return {
      status: 'signed',
      valid: true,
      publisher: {
        label: statement.publisher.label ?? null,
        email: statement.publisher.email ?? null,
        domain: statement.publisher.domain ? normalizePublisherDomain(statement.publisher.domain) : null,
        fingerprint
      },
      certificate,
      record
    };
  } catch (error) {
    return { status: 'invalid', valid: false, publisher: null, error: error.message };
  }
}

export function verifyPackageSignature(pkg) {
  const entry = pkg.has(SIGNATURE_PATH) ? pkg.get(SIGNATURE_PATH) : null;
  if (!entry) return { status: 'unsigned', valid: false, publisher: null };
  try {
    return verifyPackageSignatureRecord(pkg, JSON.parse(entry.data.toString('utf8')));
  } catch (error) {
    return { status: 'invalid', valid: false, publisher: null, error: error.message };
  }
}

export async function verifyPackageSignatureFromReader(reader) {
  if (!reader.has(SIGNATURE_PATH)) return { status: 'unsigned', valid: false, publisher: null };
  try {
    const entry = await reader.read(SIGNATURE_PATH, { verify: true });
    return verifyPackageSignatureRecord(reader, JSON.parse(entry.data.toString('utf8')));
  } catch (error) {
    return { status: 'invalid', valid: false, publisher: null, error: error.message };
  }
}

function fileAad(pathName, scope) {
  return `wurst-file-v5:${scope}:${pathName}`;
}

function chunkAad(pathName, scope, chunkIndex, plainOffset, plainLength) {
  return `${fileAad(pathName, scope)}:chunk:${chunkIndex}:${plainOffset}:${plainLength}`;
}

function assertProtectionKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Wurst protection key must be a 32-byte Buffer');
}

const WURSTKEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const WURSTKEY_DECODE = new Map([...WURSTKEY_ALPHABET].map((char, index) => [char, index]));

function encodeWurstKeyBytes(bytes) {
  const input = Buffer.from(bytes);
  if (input.length !== 32) throw new Error('WurstKey must contain exactly 256 bits');
  let value = BigInt(`0x${input.toString('hex')}`);
  let encoded = '';
  for (let i = 0; i < 52; i += 1) {
    encoded = WURSTKEY_ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

function decodeWurstKeyBody(body) {
  let cleaned = String(body ?? '').normalize('NFKC').trim().toUpperCase().replace(/[\s_-]+/g, '');
  cleaned = cleaned.replaceAll('O', '0').replace(/[IL]/g, '1');
  if (cleaned.length !== 52) throw new Error('WurstKey must contain 52 Crockford Base32 characters');
  let value = 0n;
  for (const char of cleaned) {
    const digit = WURSTKEY_DECODE.get(char);
    if (digit == null) throw new Error(`Invalid WurstKey character: ${char}`);
    value = (value << 5n) | BigInt(digit);
  }
  if (value >= (1n << 256n)) throw new Error('WurstKey is outside the 256-bit key range');
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}

export function normalizeWurstKey(value) {
  if (typeof value !== 'string') throw new Error('WurstKey must be a string');
  let raw = value.normalize('NFKC').trim();
  raw = raw.replace(/^wurstkey(?:-v1)?[-\s:]*/i, '');
  const bytes = decodeWurstKeyBody(raw);
  const body = encodeWurstKeyBytes(bytes);
  bytes.fill(0);
  const groups = body.match(/.{1,4}/g) ?? [body];
  return `wurstkey-v1-${groups.join('-')}`;
}

export function generateWurstKey() {
  const bytes = crypto.randomBytes(32);
  const body = encodeWurstKeyBytes(bytes);
  bytes.fill(0);
  const groups = body.match(/.{1,4}/g) ?? [body];
  return {
    wurstKey: `wurstkey-v1-${groups.join('-')}`,
    entropyBits: 256,
    encoding: 'crockford-base32'
  };
}

function wurstKeyBytes(value) {
  const normalized = normalizeWurstKey(value);
  return decodeWurstKeyBody(normalized.replace(/^wurstkey-v1-/i, ''));
}

export function createApplicationKeyWrap(manifest, wurstKey) {
  const wrappingKey = wurstKeyBytes(wurstKey);
  const dataKey = crypto.randomBytes(32);
  const wrapAad = `wurst-application-key-wrap-v5:${manifest.id}`;
  const wrapped = encryptAesGcm(dataKey, wrappingKey, wrapAad);
  wrappingKey.fill(0);
  return {
    dataKey,
    keyWrap: {
      format: 'wurst/application-keywrap-5',
      keyWrap: {
        algorithm: 'aes-256-gcm',
        wrappedKey: wrapped.ciphertext.toString('base64'),
        iv: wrapped.iv,
        tag: wrapped.tag,
        aad: wrapAad
      }
    }
  };
}

export function unlockApplicationDataKey(manifest, wurstKey) {
  const metadata = manifest?.security?.applicationKeyWrap;
  if (!metadata || metadata.format !== 'wurst/application-keywrap-5') throw new Error('This Wurst has no application WurstKey wrap');
  const wrappingKey = wurstKeyBytes(wurstKey);
  let dataKey;
  try {
    dataKey = decryptAesGcm(Buffer.from(metadata.keyWrap.wrappedKey, 'base64'), wrappingKey, metadata.keyWrap, metadata.keyWrap.aad);
  } catch {
    throw new Error('Wrong WurstKey or damaged protected application');
  } finally {
    wrappingKey.fill(0);
  }
  if (dataKey.length !== 32) {
    dataKey.fill(0);
    throw new Error('Invalid Wurst application protection key');
  }
  return dataKey;
}

export function encryptProtectedBuffer(filePath, data, dataKey, options = {}) {
  assertProtectionKey(dataKey);
  const safePath = normalizeWurstPath(filePath);
  const scope = options.scope ?? 'app';
  const mime = options.mime ?? mimeFor(safePath);
  const plain = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const chunkSize = Number(options.chunkSize ?? DEFAULT_PROTECTED_CHUNK_SIZE);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 64 * 1024 || chunkSize > 64 * 1024 * 1024) {
    throw new Error('Protected chunk size must be between 64 KiB and 64 MiB');
  }

  const chunks = [];
  const ciphertextParts = [];
  let cipherOffset = 0;
  const totalChunks = Math.max(1, Math.ceil(plain.length / chunkSize));
  for (let index = 0; index < totalChunks; index += 1) {
    const plainOffset = index * chunkSize;
    const plainLength = Math.min(chunkSize, Math.max(0, plain.length - plainOffset));
    const chunk = plain.subarray(plainOffset, plainOffset + plainLength);
    const aad = chunkAad(safePath, scope, index, plainOffset, plainLength);
    const encrypted = encryptAesGcm(chunk, dataKey, aad);
    ciphertextParts.push(encrypted.ciphertext);
    chunks.push({
      index,
      plainOffset,
      plainLength,
      cipherOffset,
      cipherLength: encrypted.ciphertext.length,
      iv: encrypted.iv,
      tag: encrypted.tag,
      aad
    });
    cipherOffset += encrypted.ciphertext.length;
  }

  return {
    path: safePath,
    data: Buffer.concat(ciphertextParts),
    mime,
    scope,
    encryption: {
      format: 'wurst/sealed-chunks-1',
      algorithm: 'aes-256-gcm',
      plainLength: plain.length,
      chunkSize,
      chunks
    }
  };
}

export function decryptProtectedBuffer(entry, ciphertext, dataKey) {
  assertProtectionKey(dataKey);
  if (!entry) return undefined;
  if (!entry.encryption) return Buffer.from(ciphertext);
  const meta = entry.encryption;
  if (meta.format !== 'wurst/sealed-chunks-1' || meta.algorithm !== 'aes-256-gcm' || !Array.isArray(meta.chunks)) {
    throw new Error(`Unsupported protection for ${entry.path}`);
  }
  const cipher = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  const parts = [];
  let total = 0;
  for (const chunk of meta.chunks) {
    const bytes = cipher.subarray(chunk.cipherOffset, chunk.cipherOffset + chunk.cipherLength);
    let plain;
    try {
      plain = decryptAesGcm(bytes, dataKey, chunk, chunk.aad);
    } catch {
      throw new Error(`Protected Wurst resource failed authentication: ${entry.path} chunk ${chunk.index}`);
    }
    if (plain.length !== chunk.plainLength) {
      plain.fill(0);
      throw new Error(`Protected Wurst resource integrity failed: ${entry.path} chunk ${chunk.index}`);
    }
    total += plain.length;
    parts.push(plain);
  }
  const result = Buffer.concat(parts, total);
  if (result.length !== meta.plainLength) {
    result.fill(0);
    throw new Error(`Protected Wurst resource length mismatch: ${entry.path}`);
  }
  return result;
}

export async function decryptProtectedRange(entry, readCipherRange, dataKey, offset = 0, length = null) {
  assertProtectionKey(dataKey);
  const meta = entry?.encryption;
  if (!meta || meta.format !== 'wurst/sealed-chunks-1' || meta.algorithm !== 'aes-256-gcm' || !Array.isArray(meta.chunks)) {
    throw new Error(`Resource is not a chunk-protected Wurst entry: ${entry?.path ?? 'unknown'}`);
  }
  const start = Number(offset);
  if (!Number.isSafeInteger(start) || start < 0 || start > meta.plainLength) throw new Error(`Invalid protected range offset for ${entry.path}`);
  const wanted = length == null ? meta.plainLength - start : Number(length);
  if (!Number.isSafeInteger(wanted) || wanted < 0) throw new Error(`Invalid protected range length for ${entry.path}`);
  const end = Math.min(meta.plainLength, start + wanted);
  const pieces = [];
  let total = 0;

  for (const chunk of meta.chunks) {
    const chunkStart = chunk.plainOffset;
    const chunkEnd = chunk.plainOffset + chunk.plainLength;
    if (chunkEnd <= start || chunkStart >= end) continue;
    const ciphertext = await readCipherRange(chunk.cipherOffset, chunk.cipherLength);
    let plain;
    try {
      plain = decryptAesGcm(ciphertext, dataKey, chunk, chunk.aad);
    } catch {
      throw new Error(`Protected Wurst resource failed authentication: ${entry.path} chunk ${chunk.index}`);
    }
    if (plain.length !== chunk.plainLength) {
      plain.fill(0);
      throw new Error(`Protected Wurst resource integrity failed: ${entry.path} chunk ${chunk.index}`);
    }
    const sliceStart = Math.max(start, chunkStart) - chunkStart;
    const sliceEnd = Math.min(end, chunkEnd) - chunkStart;
    const piece = Buffer.from(plain.subarray(sliceStart, sliceEnd));
    plain.fill(0);
    total += piece.length;
    pieces.push(piece);
  }
  return Buffer.concat(pieces, total);
}

export function sealApplicationFiles({ manifest, files, wurstKey }) {
  const { dataKey, keyWrap } = createApplicationKeyWrap(manifest, wurstKey);
  const sealed = files.map((rawFile) => {
    const file = normalizeFileDescriptor(rawFile);
    if (!rawFile.sealed || (file.scope ?? 'app') !== 'app') return file;
    return encryptProtectedBuffer(file.path, file.data, dataKey, { scope: file.scope, mime: file.mime });
  });
  dataKey.fill(0);
  const nextManifest = structuredClone(manifest);
  nextManifest.security = { ...(nextManifest.security ?? {}), applicationKeyWrap: keyWrap };
  return { manifest: nextManifest, files: sealed };
}

function protectionAccess(pkg, dataKey, protectedFlag = true) {
  let destroyed = false;
  let currentPkg = pkg;
  const assertAlive = () => { if (destroyed) throw new Error('Wurst key material has already been destroyed'); };
  const decryptEntry = (entry) => {
    assertAlive();
    if (!entry) return undefined;
    const data = entry.encryption ? decryptProtectedBuffer(entry, entry.data, dataKey) : Buffer.from(entry.data);
    return { ...entry, data };
  };
  return {
    protected: protectedFlag,
    get(filePath) { return decryptEntry(currentPkg.get(filePath)); },
    decryptEntry,
    protectFile(filePath, data, options = {}) {
      assertAlive();
      return encryptProtectedBuffer(filePath, data, dataKey, options);
    },
    replacePackage(nextPkg) { assertAlive(); currentPkg = nextPkg; },
    destroy() {
      if (destroyed) return;
      dataKey.fill(0);
      destroyed = true;
    }
  };
}

function plainProtectionAccess(pkg) {
  let currentPkg = pkg;
  return {
    protected: false,
    get(filePath) { return currentPkg.get(filePath); },
    protectFile(filePath, data, options = {}) {
      return {
        path: normalizeWurstPath(filePath),
        data: Buffer.isBuffer(data) ? data : Buffer.from(data),
        mime: options.mime ?? mimeFor(filePath),
        scope: options.scope ?? 'app'
      };
    },
    replacePackage(nextPkg) { currentPkg = nextPkg; },
    destroy() {}
  };
}

export function unlockApplication(pkg, wurstKey) {
  if (!pkg.manifest?.security?.applicationKeyWrap) return plainProtectionAccess(pkg);
  return protectionAccess(pkg, unlockApplicationDataKey(pkg.manifest, wurstKey));
}

export function descriptorsFromPackage(pkg) {
  return pkg.files().map((entry) => ({
    path: entry.path,
    data: Buffer.from(entry.data),
    mime: entry.mime,
    scope: entry.scope ?? 'app',
    encryption: entry.encryption ? structuredClone(entry.encryption) : undefined
  }));
}

/** Open the current multi-realm PigFS writer for a local raw Wurst. */
export async function openLocalPigFsStore(filePath, reader) {
  if (!reader?.source || !Number.isSafeInteger(reader.baseLength)) throw new Error('A live Wurst reader is required');
  if (reader.carrier) throw new Error('Incremental PigFS writes are not yet available for carrier Wursts');
  if (reader.manifest?.pigfs?.format !== 'wurst/pigfs-policy-1' || reader.manifest.pigfs.writable !== true) throw new Error('This Wurst does not declare writable PigFS realms');
  if (reader.pigFsRoot && reader.pigFsRoot.format !== PIG_FS_FORMAT) throw new Error(`Unsupported PigFS root format ${reader.pigFsRoot.format}`);
  const appendHandle = await fs.open(filePath, 'a');
  let closed = false;
  const store = new PigFsStore({
    source: reader.source,
    baseOffset: reader.baseLength,
    append: async (bytes) => {
      if (closed) throw new Error('PigFS writer is closed');
      const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await appendHandle.write(data, offset, data.length - offset, null);
        if (bytesWritten <= 0) throw new Error('Could not append PigFS record');
        offset += bytesWritten;
      }
    },
    sync: async () => {
      if (closed) throw new Error('PigFS writer is closed');
      await appendHandle.sync();
    }
  });
  await store.init();
  store.closeFile = async () => {
    if (closed) return;
    closed = true;
    store.close();
    await appendHandle.close();
  };
  return store;
}

/**
 * Materialize the current live PigFS generation into a fresh raw WRST file.
 *
 * The immutable application bytes are copied byte-for-byte. Only live PigFS
 * DATA records are carried forward and all catalog/map records are rebuilt with
 * new physical offsets. Sealed DATA chunks stay ciphertext; only sealed metadata
 * pages are opened/resealed because their record pointers change.
 *
 * This intentionally writes to a separate destination. The runtime can keep the
 * old Wurst readable while compaction happens, then atomically-ish swap files at
 * a quiet point without reloading the Wurst renderer.
 */
export async function writeCompactedWurstFile(destination, reader, options = {}) {
  if (!reader?.source || !Number.isSafeInteger(reader.baseLength)) throw new Error('A live Wurst reader is required');
  if (reader.carrier) throw new Error('Carrier Wurst compaction is not yet supported');

  const targetPath = path.resolve(destination);
  const target = await fs.open(targetPath, 'wx+');
  let closed = false;
  const closeTarget = async () => {
    if (closed) return;
    closed = true;
    await target.close();
  };

  try {
    const copyChunkSize = 4 * 1024 * 1024;
    let targetSize = 0;
    for (let offset = 0; offset < reader.baseLength; offset += copyChunkSize) {
      const length = Math.min(copyChunkSize, reader.baseLength - offset);
      const bytes = await reader.source.read(offset, length);
      let written = 0;
      while (written < bytes.length) {
        const step = await target.write(bytes, written, bytes.length - written, offset + written);
        if (step.bytesWritten <= 0) throw new Error('Could not copy immutable Wurst bytes during compaction');
        written += step.bytesWritten;
      }
      targetSize = offset + bytes.length;
    }

    const tempSource = {
      size: targetSize,
      async read(offset, length) {
        const start = Number(offset);
        const wanted = Number(length);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(wanted) || start < 0 || wanted < 0 || start + wanted > this.size) {
          throw new Error('Invalid compacted Wurst source range');
        }
        return readExact(target, wanted, start);
      }
    };

    const append = async (bytes) => {
      const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      let written = 0;
      const start = tempSource.size;
      while (written < data.length) {
        const step = await target.write(data, written, data.length - written, start + written);
        if (step.bytesWritten <= 0) throw new Error('Could not write compacted PigFS record');
        written += step.bytesWritten;
      }
      tempSource.size += data.length;
    };

    const root = reader.pigFsRoot;
    if (root) {
      if ((root.historyMode ?? 'integrity') !== PIG_FS_HISTORY_NONE) {
        const error = new Error('PigFS shared/integrity history is not compacted as ordinary CRUD data');
        error.code = 'PIG_FS_HISTORY_RETAINED';
        throw error;
      }
      const realmKeys = options.realmKeys ?? new Map();
      const store = new PigFsStore({
        source: tempSource,
        baseOffset: reader.baseLength,
        append,
        sync: async () => target.sync()
      });
      await store.init();
      const nextRoot = structuredClone(root);
      for (const [realmId, realm] of Object.entries(root.realms ?? {})) {
        const realmKey = realm.protection === 'sealed' ? realmKeys.get?.(realmId) ?? null : null;
        const unclaimedPersonal = realm.protection === 'sealed' && pigFsRealmGovernance(realm) === 'personal' && realm.claimed === false && !(realm.catalogPages?.length);
        if (realm.protection === 'sealed' && !realmKey && !unclaimedPersonal) {
          const error = new Error(`PigFS realm ${realmId} must be unlocked before compaction`);
          error.code = 'WURST_AUTH_REQUIRED';
          throw error;
        }
        if (unclaimedPersonal) {
          nextRoot.realms[realmId] = structuredClone(realm);
          continue;
        }
        if (realmKey) store.realmKeys.set(realmId, Buffer.from(realmKey));
        const entries = await loadPigFsRealmCatalog(reader.source, realm, { realmKey });
        const changedMaps = new Map();
        for (const [entryPath, entry] of entries) {
          if (entry.type !== 'file') continue;
          const chunks = await loadPigFsRealmChunks(reader.source, realm, entry, realmKey);
          const compactedChunks = [];
          for (const chunk of chunks) {
            const record = await readFsRecord(reader.source, chunk.recordOffset);
            if (record.type !== PIG_FS_RECORD.DATA) throw new Error('PigFS chunk points to non-data record during compaction');
            const appended = await store.appendRecord(PIG_FS_RECORD.DATA, record.payload, 0);
            compactedChunks.push({ ...structuredClone(chunk), recordOffset: appended.recordStart, storedLength: record.payload.length });
          }
          entry.mapPages = [];
          changedMaps.set(entryPath, compactedChunks);
        }
        nextRoot.realms[realmId] = await store.buildRealmWithCatalog(realm, entries, changedMaps, root.generation, 0);
      }
      await store.publishStandaloneRoot(nextRoot, { generation: root.generation });
      store.close();
    } else {
      await target.sync();
    }

    const newSize = tempSource.size;
    const oldSize = reader.source.size;
    await closeTarget();

    // Re-open once before handoff. This catches malformed rewritten offsets
    // before the runtime ever swaps the compacted file into place.
    const verify = await openWurstFile(targetPath);
    try {
      if (verify.manifest?.format !== reader.manifest?.format || verify.baseLength !== reader.baseLength) {
        throw new Error('Compacted Wurst verification failed');
      }
    } finally {
      await verify.close();
    }

    return {
      oldSize,
      newSize,
      reclaimedBytes: Math.max(0, oldSize - newSize),
      generation: root?.generation ?? 0
    };
  } catch (error) {
    await closeTarget().catch(() => {});
    await fs.rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function openWurstRangeSource(source, { close = async () => {}, physicalSize = null, carrier = null } = {}) {
  if (!source || typeof source.read !== 'function' || !Number.isSafeInteger(source.size) || source.size < HEADER_SIZE) {
    throw new Error('A Wurst range source requires size and read(offset, length)');
  }
  let closed = false;
  const header = await source.read(0, HEADER_SIZE);
  if (!header.subarray(0, 4).equals(MAGIC)) throw new Error('Invalid Wurst magic');
  const version = header.readUInt16LE(4);
  if (version !== FORMAT_VERSION) throw new Error(`Unsupported Wurst format version ${version}`);
  const flags = header.readUInt16LE(6);
  const manifestLength = header.readUInt32LE(8);
  const indexLength = header.readUInt32LE(12);
  const payloadLengthBig = header.readBigUInt64LE(16);
  if (payloadLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Wurst payload is too large for this runtime');
  const payloadLength = Number(payloadLengthBig);
  const payloadStart = HEADER_SIZE + manifestLength + indexLength;
  const baseLength = payloadStart + payloadLength;
  if (baseLength > source.size) throw new Error('Corrupt Wurst length table');

  const metadata = await source.read(HEADER_SIZE, manifestLength + indexLength);
  const manifest = JSON.parse(metadata.subarray(0, manifestLength).toString('utf8'));
  assertWrst7Manifest(manifest);
  const index = JSON.parse(metadata.subarray(manifestLength).toString('utf8'));
  if (index?.format !== 'wurst/index-7' || !Array.isArray(index.files)) throw new Error('Invalid Wurst file index');
  const entries = new Map();
  for (const rawEntry of index.files) {
    const safePath = normalizeWurstPath(rawEntry.path);
    if (entries.has(safePath)) throw new Error(`Duplicate Wurst path in index: ${safePath}`);
    if (!Number.isSafeInteger(rawEntry.offset) || !Number.isSafeInteger(rawEntry.length) || rawEntry.offset < 0 || rawEntry.length < 0) throw new Error(`Invalid range metadata for ${safePath}`);
    const virtualOffset = payloadStart + rawEntry.offset;
    if (virtualOffset + rawEntry.length > baseLength) throw new Error(`Invalid range for ${safePath}`);
    entries.set(safePath, { ...rawEntry, path: safePath, scope: rawEntry.scope ?? 'app', virtualOffset });
  }
  const loadedFs = await loadLatestFsRoot(source, baseLength, PIG_FS_FORMAT);
  assertFsPolicyMatchesRoot(manifest, loadedFs.root);
  const reader = {
    version, flags, manifest, index, baseLength, payloadStart, source,
    size: physicalSize ?? source.size,
    wurstSize: source.size,
    carrier,
    pigFsRoot: loadedFs.root,
    pigFsCommitOffset: loadedFs.commitOffset,
    entries: () => [...entries.values()].map((entry) => ({ ...entry })),
    has: (resourcePath) => entries.has(normalizeWurstPath(resourcePath)),
    entry: (resourcePath) => {
      const entry = entries.get(normalizeWurstPath(resourcePath));
      return entry ? { ...entry } : undefined;
    },
    async read(resourcePath, { verify = true } = {}) {
      if (closed) throw new Error('Wurst range reader is closed');
      const entry = entries.get(normalizeWurstPath(resourcePath));
      if (!entry) return undefined;
      const data = await source.read(entry.virtualOffset, entry.length);
      if (verify && sha256(data) !== entry.sha256) throw new Error(`Integrity check failed for ${entry.path}`);
      return { ...entry, data };
    },
    async readRange(resourcePath, offset = 0, length = null, { verify = true } = {}) {
      if (closed) throw new Error('Wurst range reader is closed');
      const entry = entries.get(normalizeWurstPath(resourcePath));
      if (!entry) return undefined;
      const start = Number(offset);
      const wanted = length == null ? entry.length - start : Number(length);
      if (!Number.isSafeInteger(start) || start < 0 || start > entry.length || !Number.isSafeInteger(wanted) || wanted < 0) throw new Error('Invalid Wurst resource range');
      const end = Math.min(entry.length, start + wanted);
      if (!verify) return { ...entry, range: { offset: start, length: end - start, total: entry.length }, data: await source.read(entry.virtualOffset + start, end - start) };
      const integrity = entry.integrity;
      if (!integrity || integrity.format !== 'wurst/integrity-chunks-1' || !Array.isArray(integrity.chunks)) throw new Error(`Missing chunk integrity metadata for ${entry.path}`);
      const pieces = [];
      let total = 0;
      for (const chunk of integrity.chunks) {
        const chunkStart = chunk.offset;
        const chunkEnd = chunk.offset + chunk.length;
        if (chunkEnd <= start || chunkStart >= end) continue;
        const chunkBytes = await source.read(entry.virtualOffset + chunk.offset, chunk.length);
        if (sha256(chunkBytes) !== chunk.sha256) throw new Error(`Integrity check failed for ${entry.path} chunk ${chunk.index}`);
        const piece = Buffer.from(chunkBytes.subarray(Math.max(start, chunkStart) - chunkStart, Math.min(end, chunkEnd) - chunkStart));
        total += piece.length;
        pieces.push(piece);
      }
      return { ...entry, range: { offset: start, length: total, total: entry.length }, data: Buffer.concat(pieces, total) };
    },
    pigFsStat(fsPath, options = {}) { return this.pigFsRoot ? statPigFsEntry(source, this.pigFsRoot, fsPath, options) : null; },
    pigFsList(fsPath = '/data', options = {}) { return this.pigFsRoot ? listPigFsDirectory(source, this.pigFsRoot, fsPath, options) : []; },
    pigFsReadRange(fsPath, offset = 0, length = null, options = {}) { return this.pigFsRoot ? readPigFsRange(source, this.pigFsRoot, fsPath, offset, length, options) : null; },
    pigFsHistory() { return this.pigFsRoot ? verifyPigFsHistory(source, this.baseLength) : Promise.resolve({ valid: true, format: PIG_FS_FORMAT, historyMode: PIG_FS_HISTORY_NONE, root: null, commitOffset: null, commits: [] }); },
    async close() { if (!closed) { closed = true; await close(); } }
  };
  return reader;
}

function parseContentRange(value) {
  const match = String(value ?? '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

export async function createHttpWurstSource(url, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('HTTP Wurst source requires fetch()');
  const target = new URL(String(url));
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Remote Wurst source must use HTTP or HTTPS');
  const first = await fetchImpl(target, { headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' } });
  if (first.status !== 206) throw new Error('Remote server does not provide byte-range Wurst access');
  const range = parseContentRange(first.headers.get('content-range'));
  if (!range || range.start !== 0 || range.end !== 0 || !Number.isSafeInteger(range.total) || range.total < HEADER_SIZE) throw new Error('Remote server returned an invalid Content-Range');
  const etag = first.headers.get('etag');
  const lastModified = first.headers.get('last-modified');
  const strongEtag = etag && !/^W\//i.test(etag) ? etag : null;
  await first.arrayBuffer();

  return {
    size: range.total,
    url: target.toString(),
    etag: strongEtag,
    lastModified,
    async read(position, length) {
      const start = Number(position);
      const count = Number(length);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || start + count > range.total) throw new Error('Invalid remote Wurst range');
      if (count === 0) return Buffer.alloc(0);
      const headers = { Range: `bytes=${start}-${start + count - 1}`, 'Accept-Encoding': 'identity' };
      if (strongEtag) headers['If-Range'] = strongEtag;
      else if (lastModified) headers['If-Range'] = lastModified;
      const response = await fetchImpl(target, { headers });
      if (response.status !== 206) throw new Error('Remote Wurst changed or stopped serving byte ranges');
      const got = parseContentRange(response.headers.get('content-range'));
      if (!got || got.start !== start || got.end !== start + count - 1 || got.total !== range.total) throw new Error('Remote Wurst range does not match the pinned representation');
      if (strongEtag && response.headers.get('etag') && response.headers.get('etag') !== strongEtag) throw new Error('Remote Wurst ETag changed during streaming');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== count) throw new Error('Remote Wurst range was truncated');
      return bytes;
    }
  };
}

export async function openHttpWurst(url, options = {}) {
  const source = await createHttpWurstSource(url, options);
  return openWurstRangeSource(source);
}
