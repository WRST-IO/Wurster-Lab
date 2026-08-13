const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }
function writeU16(view, offset, value) { view.setUint16(offset, value & 0xffff, true); }
function writeU32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

function safeZipPath(value) {
  const path = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!path || path.split('/').some((part) => part === '..' || part === '.')) throw new Error(`Unsafe ZIP path: ${value}`);
  return path;
}

function findEocd(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= min; offset -= 1) {
    if (u32(view, offset) === SIG_EOCD) return offset;
  }
  throw new Error('ZIP end-of-central-directory record not found');
}

export function parseZip(bytesLike) {
  const bytes = bytesLike instanceof Uint8Array ? bytesLike : new Uint8Array(bytesLike);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes);
  const disk = u16(view, eocd + 4);
  const centralDisk = u16(view, eocd + 6);
  const entriesOnDisk = u16(view, eocd + 8);
  const totalEntries = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) throw new Error('Multi-disk ZIPs are not supported');
  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) throw new Error('ZIP64 is not supported by Wurster Lab');
  if (centralOffset + centralSize > bytes.length) throw new Error('ZIP central directory is outside the file');

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (u32(view, cursor) !== SIG_CENTRAL) throw new Error(`Bad ZIP central entry ${index}`);
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const modTime = u16(view, cursor + 12);
    const modDate = u16(view, cursor + 14);
    const crc = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const externalAttrs = u32(view, cursor + 38);
    const localOffset = u32(view, cursor + 42);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    if (!(flags & UTF8_FLAG) && nameBytes.some((byte) => byte >= 0x80)) throw new Error('Non-UTF8 ZIP filenames are not supported');
    const name = safeZipPath(td.decode(nameBytes));
    if (![0, 8].includes(method)) throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    if (u32(view, localOffset) !== SIG_LOCAL) throw new Error(`Bad local ZIP header for ${name}`);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length) throw new Error(`ZIP entry exceeds file bounds: ${name}`);
    entries.push({
      name,
      flags,
      method,
      modTime,
      modDate,
      crc,
      compressedSize,
      uncompressedSize,
      externalAttrs,
      compressedData: bytes.slice(dataOffset, dataOffset + compressedSize)
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytesLike) {
  const bytes = bytesLike instanceof Uint8Array ? bytesLike : new Uint8Array(bytesLike);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function localHeader(entry, nameBytes) {
  const out = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(out.buffer);
  writeU32(view, 0, SIG_LOCAL);
  writeU16(view, 4, 20);
  writeU16(view, 6, (entry.flags | UTF8_FLAG) & ~DATA_DESCRIPTOR_FLAG);
  writeU16(view, 8, entry.method);
  writeU16(view, 10, entry.modTime || 0);
  writeU16(view, 12, entry.modDate || 0);
  writeU32(view, 14, entry.crc);
  writeU32(view, 18, entry.compressedSize);
  writeU32(view, 22, entry.uncompressedSize);
  writeU16(view, 26, nameBytes.length);
  writeU16(view, 28, 0);
  out.set(nameBytes, 30);
  return out;
}

function centralHeader(entry, nameBytes, localOffset) {
  const out = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(out.buffer);
  writeU32(view, 0, SIG_CENTRAL);
  writeU16(view, 4, 0x031e);
  writeU16(view, 6, 20);
  writeU16(view, 8, (entry.flags | UTF8_FLAG) & ~DATA_DESCRIPTOR_FLAG);
  writeU16(view, 10, entry.method);
  writeU16(view, 12, entry.modTime || 0);
  writeU16(view, 14, entry.modDate || 0);
  writeU32(view, 16, entry.crc);
  writeU32(view, 20, entry.compressedSize);
  writeU32(view, 24, entry.uncompressedSize);
  writeU16(view, 28, nameBytes.length);
  writeU16(view, 30, 0);
  writeU16(view, 32, 0);
  writeU16(view, 34, 0);
  writeU16(view, 36, 0);
  writeU32(view, 38, entry.externalAttrs || 0);
  writeU32(view, 42, localOffset);
  out.set(nameBytes, 46);
  return out;
}

export function writeZip(entries, replacements = new Map()) {
  const ordered = [];
  const seen = new Set();
  for (const source of entries) {
    const name = safeZipPath(source.name);
    if (seen.has(name)) continue;
    seen.add(name);
    if (replacements.has(name)) {
      const data = replacements.get(name);
      if (data == null) continue;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      ordered.push({ name, flags: UTF8_FLAG, method: 0, modTime: source.modTime, modDate: source.modDate, crc: crc32(bytes), compressedSize: bytes.length, uncompressedSize: bytes.length, externalAttrs: source.externalAttrs, compressedData: bytes });
    } else {
      ordered.push({ ...source, name });
    }
  }
  for (const [rawName, data] of replacements) {
    const name = safeZipPath(rawName);
    if (seen.has(name) || data == null) continue;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    ordered.push({ name, flags: UTF8_FLAG, method: 0, modTime: 0, modDate: 0, crc: crc32(bytes), compressedSize: bytes.length, uncompressedSize: bytes.length, externalAttrs: 0, compressedData: bytes });
  }
  if (ordered.length > 0xffff) throw new Error('Too many ZIP entries');

  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;
  for (const entry of ordered) {
    const nameBytes = te.encode(entry.name);
    const local = localHeader(entry, nameBytes);
    localChunks.push(local, entry.compressedData);
    centralChunks.push(centralHeader(entry, nameBytes, localOffset));
    localOffset += local.length + entry.compressedData.length;
    if (localOffset > 0xffffffff) throw new Error('ZIP grew beyond classic ZIP limits');
  }
  const central = concat(centralChunks);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeU32(eocdView, 0, SIG_EOCD);
  writeU16(eocdView, 4, 0);
  writeU16(eocdView, 6, 0);
  writeU16(eocdView, 8, ordered.length);
  writeU16(eocdView, 10, ordered.length);
  writeU32(eocdView, 12, central.length);
  writeU32(eocdView, 16, localOffset);
  writeU16(eocdView, 20, 0);
  return concat([...localChunks, central, eocd]);
}

function jsonText(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function bytesText(value) { return te.encode(value); }


export function validateOperatorSettings(value, { requireComplete = false } = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const relayUrl = String(source.mailRelayUrl ?? '').trim();
  const relaySecret = String(source.mailRelaySecret ?? '').trim();
  if (!relayUrl && !relaySecret && !requireComplete) return null;
  if (!relayUrl || !relaySecret) throw new Error('Mail relay URL and secret must be stored together');
  let parsed;
  try { parsed = new URL(relayUrl); } catch { throw new Error('Mail relay URL is not a valid URL'); }
  if (parsed.protocol !== 'https:') throw new Error('Mail relay URL must use HTTPS');
  if (parsed.username || parsed.password) throw new Error('Mail relay URL must not contain credentials');
  if (relaySecret.length < 32 || relaySecret.length > 512) throw new Error('Mail relay secret must be between 32 and 512 characters');
  return {
    format: 'wrst/operator-settings-1',
    mailRelayUrl: parsed.href,
    mailRelaySecret: relaySecret
  };
}

function storedZipText(entriesByName, name, { required = true } = {}) {
  const entry = entriesByName.get(name);
  if (!entry) {
    if (required) throw new Error(`Operator workspace ZIP is missing ${name}`);
    return null;
  }
  if (entry.method !== 0) throw new Error(`Operator workspace ZIP entry ${name} is compressed; Wurster Lab expects its own stored ZIP export`);
  if (entry.compressedSize !== entry.uncompressedSize) throw new Error(`Operator workspace ZIP entry ${name} has inconsistent size`);
  return td.decode(entry.compressedData);
}

export function extractOperatorWorkspaceZip(bytesLike) {
  const entries = parseZip(bytesLike);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const prefix = byName.has('wurster_lab/package.json') ? 'wurster_lab/' : '';
  const rootText = storedZipText(byName, `${prefix}authority/wrst.io/public/root.json`);
  const issuerText = storedZipText(byName, `${prefix}authority/wrst.io/public/issuer.json`);
  const trustBundleText = storedZipText(byName, `${prefix}authority/wrst.io/public/trust-bundle.json`);
  const issuerPrivateText = storedZipText(byName, `${prefix}authority/wrst.io/private/issuer.wurstissuer`);
  const settingsText = storedZipText(byName, `${prefix}authority/wrst.io/private/operator-settings.json`, { required: false });
  return {
    rootText,
    issuerText,
    trustBundleText,
    issuerPrivateText,
    settings: settingsText ? validateOperatorSettings(JSON.parse(settingsText), { requireComplete: true }) : null
  };
}

export function validateOperatorMaterial({ rootText, issuerText, trustBundleText, issuerPrivateText }) {
  const root = JSON.parse(rootText);
  const issuer = JSON.parse(issuerText);
  const trustBundle = JSON.parse(trustBundleText);
  const privateIssuer = JSON.parse(issuerPrivateText);
  if (root?.format !== 'wurst/authority-root-1' || root.authority !== 'wrst.io' || root.algorithm !== 'ed25519') throw new Error('root.json is not a WRST.IO Ed25519 Authority root');
  if (root.development) throw new Error('Refusing to store the bundled WRST.IO development root');
  if (!/^[a-f0-9]{64}$/i.test(root.fingerprint ?? '')) throw new Error('root.json fingerprint is invalid');
  if (issuer?.format !== 'wurst/authority-issuer-certificate-1' || issuer.statement?.root?.fingerprint !== root.fingerprint) throw new Error('issuer.json is not chained to root.json');
  const issuerPublic = issuer.statement?.issuer;
  if (!issuerPublic?.fingerprint || privateIssuer?.format !== 'wurst/authority-issuer-key-1' || privateIssuer.fingerprint !== issuerPublic.fingerprint) throw new Error('issuer.wurstissuer does not match issuer.json');
  if (trustBundle?.format !== 'wurst/trust-bundle-1' || trustBundle.statement?.root?.fingerprint !== root.fingerprint) throw new Error('trust-bundle.json is not signed for root.json');
  const included = (trustBundle.statement?.issuers ?? []).some((item) => item?.statement?.issuer?.fingerprint === issuerPublic.fingerprint);
  if (!included) throw new Error('trust-bundle.json does not contain the active issuer');
  return { root, issuer, trustBundle, privateIssuer };
}


function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function base64Bytes(value) {
  const binary = atob(String(value ?? ''));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyEd25519Spki(publicKeySpki, statement, signature) {
  const key = await crypto.subtle.importKey('spki', base64Bytes(publicKeySpki), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, base64Bytes(signature), te.encode(canonicalStringify(statement)));
}

export async function verifyOperatorMaterialCryptographically(material) {
  const { root, issuer, trustBundle, privateIssuer } = material;
  const rootDer = base64Bytes(root.publicKeySpki);
  if (await sha256Hex(rootDer) !== String(root.fingerprint).toLowerCase()) throw new Error('root.json public key does not match its fingerprint');
  const issuerPublic = issuer.statement.issuer;
  const issuerDer = base64Bytes(issuerPublic.publicKeySpki);
  if (await sha256Hex(issuerDer) !== String(issuerPublic.fingerprint).toLowerCase()) throw new Error('issuer.json public key does not match its fingerprint');
  if (!(await verifyEd25519Spki(root.publicKeySpki, issuer.statement, issuer.signature))) throw new Error('issuer.json Root signature is invalid');
  if (!(await verifyEd25519Spki(root.publicKeySpki, trustBundle.statement, trustBundle.signature))) throw new Error('trust-bundle.json Root signature is invalid');
  if (privateIssuer.publicKeySpki !== issuerPublic.publicKeySpki) throw new Error('issuer.wurstissuer public key does not match issuer.json');
  return true;
}

export function operatorReplacementMap(material, operatorSettings = null) {
  const { root, issuer, trustBundle, privateIssuer } = material;
  const settings = operatorSettings ? validateOperatorSettings(operatorSettings, { requireComplete: true }) : null;
  const prefix = 'wurster_lab/';
  const trustModule = `// Generated from the private Wurster Lab operator realm. Public trust material only.\nexport const TRUSTED_AUTHORITIES = ${JSON.stringify([root], null, 2)};\nexport const TRUST_BUNDLE = ${JSON.stringify(trustBundle, null, 2)};\n`;
  const workerGenerated = `// Generated from the private Wurster Lab operator realm. Public trust material only.\nexport const AUTHORITY_ROOT = ${JSON.stringify(root, null, 2)};\nexport const ISSUER_CERTIFICATE = ${JSON.stringify(issuer, null, 2)};\n`;
  const map = new Map();
  const put = (path, text) => map.set(prefix + path, bytesText(text));

  put('authority/wrst.io/public/root.json', jsonText(root));
  put('authority/wrst.io/public/issuer.json', jsonText(issuer));
  put('authority/wrst.io/public/trust-bundle.json', jsonText(trustBundle));
  put('authority/wrst.io/private/issuer.wurstissuer', jsonText(privateIssuer));
  if (settings) put('authority/wrst.io/private/operator-settings.json', jsonText(settings));
  put('runtime/desktop/src/trusted-authorities.json', jsonText([root]));
  put('runtime/desktop/src/trust-bundle.json', jsonText(trustBundle));
  put('runtime/web/src/trusted-authorities.json', jsonText([root]));
  put('runtime/web/src/trust-bundle.json', jsonText(trustBundle));
  put('runtime/web/src/trust-data.mjs', trustModule);
  put('runtime/web/dist/trust-data.mjs', trustModule);
  put('packages/meatgrinder/src/trust-data.mjs', trustModule);
  put('site/src/.well-known/wurst-authority-root.json', jsonText(root));
  put('site/src/.well-known/wurst-trust-bundle.json', jsonText(trustBundle));
  put('site/src/assets/wurster/trust-data.mjs', trustModule);
  put('authority/wrst.io/worker/src/generated-authority.js', workerGenerated);
  put('WRST_OPERATOR_PERSONALIZED.txt', `WRST.IO operator-personalized Wurster Lab\nRoot fingerprint: ${root.fingerprint}\nIssuer fingerprint: ${issuer.statement.issuer.fingerprint}\nGenerated: ${new Date().toISOString()}\n\nPRIVATE OPERATOR BUILD: contains authority/wrst.io/private/issuer.wurstissuer. DO NOT PUBLISH THIS ZIP.\n`);
  return map;
}

export function personalizeWursterLabZip(zipBytes, material, operatorSettings = null) {
  const entries = parseZip(zipBytes);
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has('wurster_lab/package.json') || !names.has('wurster_lab/tools/wrst-authority.mjs')) throw new Error('This does not look like a Wurster Lab release ZIP');
  return writeZip(entries, operatorReplacementMap(material, operatorSettings));
}
