import { validateJsonValue } from '@wurster/piglink';
import { WurstSessionRegistry, analyzePigletAuthorityComposition, assertPigletParentMethod, normalizePigletRelationship } from '@wurster/piglet';
import { BlobWurstSource, HttpWurstSource, MessagePortWurstSource, sourceFrom } from './wurst-source.mjs';
import { verifyPublisherCertificateWeb, verifyTrustBundleWeb } from './trust-runtime.mjs';
import { mimeFor, normalizeCapabilityDeclaration, parseRange } from './web-runtime-util.mjs';
import { mountWebMachineSession } from './piglet-machine-runtime.mjs';
import { registerServiceWorkerSession, waitForServiceWorkerControl } from './service-worker-runtime.mjs';
export { BlobWurstSource, HttpWurstSource, MessagePortWurstSource } from './wurst-source.mjs';
export { verifyPublisherCertificateWeb, verifyTrustBundleWeb } from './trust-runtime.mjs';
const WRST_MAGIC = new Uint8Array([0x57, 0x52, 0x53, 0x54]);
const WRST_VERSION = 7;
const HEADER_SIZE = 24;
const FS_RECORD_HEADER = 32;
const FS_RECORD_TRAILER = 64;
const FS_MAX_PAYLOAD = 4 * 1024 * 1024;
const FS_CHUNK = 4 * 1024 * 1024;
const FS_MAP_TARGET = 512 * 1024;
const FS_CATALOG_TARGET = 512 * 1024;
const FS_MAGIC = new Uint8Array([0x57, 0x37, 0x52, 0x43]);
const FS_END_MAGIC = new Uint8Array([0x57, 0x37, 0x52, 0x45]);
const FS_RECORD = Object.freeze({ DATA: 1, MAP: 2, CATALOG: 3, COMMIT: 4 });
const SIGNATURE_PATH = '__wurst/signature.json';
const SEALED_APP_INDEX_PATH = '__wurst/sealed-app/index.json';
const WURSTER_WEB_VERSION = '0.32.8';
const te = new TextEncoder();
const td = new TextDecoder();
function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return te.encode(value);
  throw new TypeError('Expected bytes or string');
}
function concat(parts) {
  const list = parts.map(bytes);
  const total = list.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of list) { out.set(part, offset); offset += part.byteLength; }
  return out;
}
function matches(a, b) {
  if (a.byteLength < b.byteLength) return false;
  for (let i = 0; i < b.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
function hex(value) { return [...bytes(value)].map((v) => v.toString(16).padStart(2, '0')).join(''); }
function fromBase64(value) {
  const raw = atob(String(value));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
const WURSTKEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const WURSTKEY_DECODE = new Map([...WURSTKEY_ALPHABET].map((char, index) => [char, index]));
function wurstKeyBytes(value) {
  if (typeof value !== 'string') throw new Error('WurstKey must be a string');
  let body = value.normalize('NFKC').trim().replace(/^wurstkey(?:-v1)?[-\s:]*/i, '');
  body = body.toUpperCase().replace(/[\s_-]+/g, '').replaceAll('O', '0').replace(/[IL]/g, '1');
  if (body.length !== 52) throw new Error('WurstKey must contain 52 Crockford Base32 characters');
  let number = 0n;
  for (const char of body) {
    const digit = WURSTKEY_DECODE.get(char);
    if (digit == null) throw new Error(`Invalid WurstKey character: ${char}`);
    number = (number << 5n) | BigInt(digit);
  }
  if (number >= (1n << 256n)) throw new Error('WurstKey is outside the 256-bit key range');
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i -= 1) { out[i] = Number(number & 255n); number >>= 8n; }
  return out;
}
async function importAesKey(raw) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is required by Wurster Web');
  return crypto.subtle.importKey('raw', bytes(raw), { name: 'AES-GCM' }, false, ['decrypt']);
}
async function decryptAesGcm(ciphertext, key, metadata, aad = null) {
  if (metadata?.algorithm && metadata.algorithm !== 'aes-256-gcm') throw new Error('Unsupported Wurst AES-GCM metadata');
  const encrypted = concat([bytes(ciphertext), fromBase64(metadata.tag)]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: fromBase64(metadata.iv), tagLength: 128,
      ...(aad ? { additionalData: te.encode(String(aad)) } : {})
    }, key, encrypted));
  } catch {
    throw new Error('Wrong WurstKey or damaged protected application');
  }
}
async function unlockApplicationDataKey(manifest, wurstKey) {
  const metadata = manifest?.security?.applicationKeyWrap;
  if (!metadata || metadata.format !== 'wurst/application-keywrap-5') throw new Error('This Wurst has no application WurstKey wrap');
  const wrappingBytes = wurstKeyBytes(wurstKey);
  try {
    const wrappingKey = await importAesKey(wrappingBytes);
    const rawDataKey = await decryptAesGcm(fromBase64(metadata.keyWrap.wrappedKey), wrappingKey, metadata.keyWrap, metadata.keyWrap.aad);
    if (rawDataKey.byteLength !== 32) throw new Error('Invalid Wurst application protection key');
    try { return await importAesKey(rawDataKey); } finally { rawDataKey.fill(0); }
  } finally { wrappingBytes.fill(0); }
}
async function decryptProtectedRange(entry, readCipherRange, dataKey, offset = 0, length = null) {
  const meta = entry?.encryption;
  if (!meta || meta.format !== 'wurst/sealed-chunks-1' || meta.algorithm !== 'aes-256-gcm' || !Array.isArray(meta.chunks)) throw new Error(`Resource is not a chunk-protected Wurst entry: ${entry?.path ?? 'unknown'}`);
  const start = Number(offset);
  if (!Number.isSafeInteger(start) || start < 0 || start > meta.plainLength) throw new Error(`Invalid protected range offset for ${entry.path}`);
  const wanted = length == null ? meta.plainLength - start : Number(length);
  if (!Number.isSafeInteger(wanted) || wanted < 0) throw new Error(`Invalid protected range length for ${entry.path}`);
  const end = Math.min(meta.plainLength, start + wanted), parts = [];
  for (const chunk of meta.chunks) {
    const chunkStart = Number(chunk.plainOffset), chunkEnd = chunkStart + Number(chunk.plainLength);
    if (chunkEnd <= start || chunkStart >= end) continue;
    const ciphertext = await readCipherRange(Number(chunk.cipherOffset), Number(chunk.cipherLength));
    let plain;
    try { plain = await decryptAesGcm(ciphertext, dataKey, chunk, chunk.aad); }
    catch { throw new Error(`Protected Wurst resource failed authentication: ${entry.path} chunk ${chunk.index}`); }
    if (plain.byteLength !== chunk.plainLength) throw new Error(`Protected Wurst resource integrity failed: ${entry.path} chunk ${chunk.index}`);
    parts.push(plain.subarray(Math.max(start, chunkStart) - chunkStart, Math.min(end, chunkEnd) - chunkStart));
  }
  return concat(parts);
}
function lockedApplicationError(message = 'WurstKey required for protected application content') { const error = new Error(message); error.code = 'WURST_APP_LOCKED'; return error; }
async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is required by Wurster Web');
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value))));
}
function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }
function u64(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Wurst offset exceeds browser safe integer range');
  return Number(value);
}
function writeU16(view, offset, value) { view.setUint16(offset, value, true); }
function writeU64(view, offset, value) { view.setBigUint64(offset, BigInt(value), true); }
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}
function normalizeWurstPath(value) {
  const normalized = String(value).replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) throw new Error(`Invalid Wurst path: ${value}`);
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe Wurst path: ${value}`);
  return parts.join('/');
}
function normalizeFsPath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const target = normalized || 'data';
  const parts = target.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe PigFS path: ${value}`);
  if (target !== 'data' && !target.startsWith('data/')) return normalizeFsPath(`data/${target}`);
  return target;
}
function normalizePublicPigFsPath(value) {
  const raw = String(value ?? '/').replaceAll('\\', '/');
  const normalized = `/${raw.replace(/^\/+|\/+$/g, '')}`.replace(/\/{2,}/g, '/');
  if (normalized === '/') return '/';
  const parts = normalized.slice(1).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe PigFS path: ${value}`);
  return normalized;
}
function resolveMountedPigFsPath(value, realms, { allowRoot = true } = {}) {
  const publicPath = normalizePublicPigFsPath(value);
  if (publicPath === '/') {
    if (!allowRoot) throw new Error('PigFS operation requires a path inside a realm');
    return { publicPath, target: 'data', realmId: null, path: '', realm: null };
  }
  const candidates = [...(realms || [])].map((realm) => ({ ...realm, mount: normalizePublicPigFsPath(realm.mount || `/${realm.id}`) })).sort((a,b) => b.mount.length - a.mount.length);
  const realm = candidates.find((item) => publicPath === item.mount || publicPath.startsWith(`${item.mount}/`));
  if (!realm) { const error = new Error(`PigFS path is outside declared mounts: ${publicPath}`); error.code = 'PIG_FS_OUTSIDE_MOUNTS'; throw error; }
  const path = publicPath === realm.mount ? '' : publicPath.slice(realm.mount.length + 1);
  if (!path && !allowRoot) throw new Error('PigFS operation requires a path inside a realm');
  return { publicPath, target: path ? `data/${realm.id}/${path}` : `data/${realm.id}`, realmId: String(realm.id), path, realm };
}
function mountedPublicPigFsPath(internalPath, realms) {
  const parsed = parseFsRealmPath(internalPath, { allowRealmRoot: true });
  const realm = (realms || []).find((item) => String(item.id) === parsed.realmId);
  if (!realm) return `/${internalPath}`;
  const mount = normalizePublicPigFsPath(realm.mount || `/${realm.id}`);
  return parsed.path ? `${mount}/${parsed.path}` : mount;
}
async function readFsRecord(source, recordStart) {
  const header = await source.read(recordStart, FS_RECORD_HEADER);
  if (!matches(header, FS_MAGIC)) throw new Error('Invalid PigFS record header');
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (u16(view, 4) !== 1) throw new Error('Unsupported PigFS record version');
  const type = u16(view, 6), payloadLength = u64(view, 8), previousCommitOffset = u64(view, 16), sequence = u64(view, 24);
  if (payloadLength > FS_MAX_PAYLOAD) throw new Error('PigFS record exceeds format limit');
  const payload = await source.read(recordStart + FS_RECORD_HEADER, payloadLength);
  const trailerOffset = recordStart + FS_RECORD_HEADER + payloadLength;
  const trailer = await source.read(trailerOffset, FS_RECORD_TRAILER);
  if (!matches(trailer, FS_END_MAGIC)) throw new Error('Invalid PigFS record trailer');
  const tv = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
  if (u16(tv,4)!==1 || u16(tv,6)!==type || u64(tv,8)!==recordStart || u64(tv,16)!==previousCommitOffset || u64(tv,24)!==payloadLength) throw new Error('PigFS record trailer mismatch');
  if (await sha256Hex(payload) !== hex(trailer.subarray(32,64))) throw new Error('PigFS record integrity check failed');
  return { type, payload, previousCommitOffset, sequence, recordStart, recordEnd: trailerOffset + FS_RECORD_TRAILER };
}
async function locateFsCommit(source, baseOffset) {
  if (source.size <= baseOffset) return null;
  const scanLength = Math.min(source.size - baseOffset, FS_MAX_PAYLOAD + FS_RECORD_HEADER + FS_RECORD_TRAILER + 4096);
  const scanStart = source.size - scanLength;
  const data = await source.read(scanStart, scanLength);
  for (let i = data.byteLength - FS_RECORD_TRAILER; i >= 0; i -= 1) {
    if (!matches(data.subarray(i, i+4), FS_END_MAGIC)) continue;
    const trailer = data.subarray(i, i + FS_RECORD_TRAILER);
    const tv = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
    if (u16(tv,4)!==1) continue;
    const type=u16(tv,6), start=u64(tv,8), previous=u64(tv,16), payloadLength=u64(tv,24);
    if (start < baseOffset || payloadLength > FS_MAX_PAYLOAD) continue;
    const expected = start + FS_RECORD_HEADER + payloadLength;
    if (expected !== scanStart + i || expected + FS_RECORD_TRAILER > source.size) continue;
    return type === FS_RECORD.COMMIT ? start : (previous || null);
  }
  return null;
}
async function loadFsRoot(source, baseOffset) {
  const commitOffset = await locateFsCommit(source, baseOffset);
  if (commitOffset == null) return { root:null, commitOffset:null };
  const record = await readFsRecord(source, commitOffset);
  if (record.type !== FS_RECORD.COMMIT) throw new Error('PigFS commit pointer is invalid');
  const root = JSON.parse(td.decode(record.payload));
  if (root?.format !== 'wurst/pigfs-1') throw new Error('Unsupported PigFS root');
  if (!root.realms || typeof root.realms !== 'object' || Array.isArray(root.realms)) throw new Error('Invalid PigFS realm registry');
  return { root, commitOffset };
}
function fsRealmGovernance(realm={}) { return realm?.governance ? String(realm.governance) : 'ordinary'; }
function parseFsRealmPath(value,{allowRealmRoot=true}={}) {
  const target=normalizeFsPath(value),parts=target.split('/');
  if(parts[0]!=='data'||parts.length<2)throw new Error('PigFS path must name a realm under /data');
  const realmId=parts[1],path=parts.slice(2).join('/');
  if(!path&&!allowRealmRoot)throw new Error('PigFS operation requires a path inside a realm');
  return {target,realmId,path};
}
async function decodeFsPage(source, descriptor, expectedType, expectedFormat, realm) {
  if (realm?.protection === 'sealed' || descriptor.encryption) { const e = new Error(`PigFS realm ${realm?.id||'unknown'} is sealed`); e.code='PIG_FS_LOCKED'; throw e; }
  const record = await readFsRecord(source, descriptor.recordOffset);
  if (record.type !== expectedType) throw new Error('PigFS metadata record type mismatch');
  if (descriptor.plainSha256 && await sha256Hex(record.payload) !== descriptor.plainSha256) throw new Error('PigFS metadata integrity check failed');
  const parsed = JSON.parse(td.decode(record.payload));
  if (parsed?.format !== expectedFormat) throw new Error('Unexpected PigFS metadata format');
  return parsed;
}
async function fsRealmCatalog(source, realm) {
  const out = new Map(); if (!realm) return out;
  for (const page of realm.catalogPages || []) for (const entry of (await decodeFsPage(source,page,FS_RECORD.CATALOG,'wurst/pigfs-catalog-1',realm)).entries || []) out.set(entry.path, entry);
  return out;
}
async function fsMap(source, realm, entry) {
  const chunks=[];
  for (const page of entry.mapPages || []) chunks.push(...((await decodeFsPage(source,page,FS_RECORD.MAP,'wurst/pigfs-map-1',realm)).chunks || []));
  return chunks.sort((a,b)=>a.plainOffset-b.plainOffset);
}

export class WurstWebReader {
  static async open(input) {
    const source = await sourceFrom(input);
    const head = await source.read(0, HEADER_SIZE);
    if (!matches(head, WRST_MAGIC)) throw new Error('Wurster Web accepts native WRST files; Undercover PNG transport is not yet wired into the web source adapter');
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const version = u16(hv,4); if (version !== WRST_VERSION) throw new Error(`Unsupported Wurst format version ${version}`);
    const manifestLength=u32(hv,8), indexLength=u32(hv,12), payloadLength=u64(hv,16);
    const meta = await source.read(HEADER_SIZE, manifestLength + indexLength);
    const manifest = JSON.parse(td.decode(meta.subarray(0,manifestLength)));
    const index = JSON.parse(td.decode(meta.subarray(manifestLength)));
    if (manifest?.format !== 'wurst/7' || index?.format !== 'wurst/index-7' || !Array.isArray(index.files)) throw new Error('Invalid WRST v7 metadata');
    const payloadStart=HEADER_SIZE+manifestLength+indexLength, baseLength=payloadStart+payloadLength;
    if (baseLength > source.size) throw new Error('Corrupt Wurst length table');
    const entries=new Map();
    for (const raw of index.files) {
      const path=normalizeWurstPath(raw.path), virtualOffset=payloadStart+Number(raw.offset), length=Number(raw.length);
      if (!Number.isSafeInteger(virtualOffset)||!Number.isSafeInteger(length)||virtualOffset<payloadStart||virtualOffset+length>baseLength) throw new Error(`Invalid range for ${path}`);
      entries.set(path,{...raw,path,scope:raw.scope||'app',virtualOffset,length});
    }
    const loaded=await loadFsRoot(source,baseLength);
    return new WurstWebReader({source,version,manifest,index,payloadStart,baseLength,entries,fsRoot:loaded.root,fsCommitOffset:loaded.commitOffset});
  }
  constructor(state) { Object.assign(this,state); this._catalogs=new Map(); }
  entry(path) { const e=this.entries.get(normalizeWurstPath(path)); return e?{...e}:undefined; }
  has(path) { return this.entries.has(normalizeWurstPath(path)); }
  realms() {
    if(this.fsRoot?.realms)return Object.values(this.fsRoot.realms).map((realm)=>{const spec=(this.manifest?.pigfs?.realms||[]).find((item)=>String(item.id)===String(realm.id));return {...structuredClone(realm),mount:realm.mount||spec?.mount||`/${realm.id}`};});
    return (this.manifest?.pigfs?.realms||[]).map((spec)=>({id:String(spec.id),mount:spec.mount||`/${spec.id}`,label:spec.label||spec.id,governance:spec.governance||undefined,audit:spec.audit||'none',protection:spec.governance==='personal'?'sealed':(spec.protection||'public'),access:null,keyWraps:[],catalogPages:[],stats:{files:0,directories:0,logicalBytes:0}}));
  }
  realm(id) { const key=String(id);const realm=this.fsRoot?.realms?.[key]||this.realms().find((item)=>item.id===key);return realm?structuredClone(realm):null; }
  async read(path,{verify=true}={}) { const e=this.entry(path); if(!e)return undefined; const data=await this.source.read(e.virtualOffset,e.length); if(verify&&await sha256Hex(data)!==e.sha256)throw new Error(`Integrity check failed for ${e.path}`); return {...e,data}; }
  async readRange(path,offset=0,length=null,{verify=true}={}) {
    const e=this.entry(path); if(!e)return undefined; const start=Number(offset), end=Math.min(e.length,start+(length==null?e.length-start:Number(length)));
    if(!Number.isSafeInteger(start)||start<0||end<start||end>e.length)throw new Error('Invalid Wurst resource range');
    if(!verify)return {...e,range:{offset:start,length:end-start,total:e.length},data:await this.source.read(e.virtualOffset+start,end-start)};
    if(!e.integrity?.chunks)throw new Error(`Missing chunk integrity metadata for ${e.path}`);
    const parts=[];
    for(const chunk of e.integrity.chunks){const cs=chunk.offset,ce=cs+chunk.length;if(ce<=start||cs>=end)continue;const b=await this.source.read(e.virtualOffset+cs,chunk.length);if(await sha256Hex(b)!==chunk.sha256)throw new Error(`Integrity check failed for ${e.path} chunk ${chunk.index}`);parts.push(b.subarray(Math.max(start,cs)-cs,Math.min(end,ce)-cs));}
    const data=concat(parts); return {...e,range:{offset:start,length:data.byteLength,total:e.length},data};
  }
  async catalog(realmId){
    const id=String(realmId||'');if(!id)throw new Error('PigFS realm id is required');
    if(this._catalogs.has(id))return this._catalogs.get(id);
    const realm=this.fsRoot?.realms?.[id];if(!realm){const empty=new Map();this._catalogs.set(id,empty);return empty;}
    const loaded=await fsRealmCatalog(this.source,realm);this._catalogs.set(id,loaded);return loaded;
  }
  async pigFsStat(path){
    const resolved=resolveMountedPigFsPath(path,this.realms(),{allowRoot:true}),target=resolved.target;
    if(target==='data')return {path:'/',name:'pigfs',type:'directory',size:0};
    const parsed={realmId:resolved.realmId,path:resolved.path},realm=this.fsRoot?.realms?.[parsed.realmId]||resolved.realm;if(!realm)return null;
    if(!parsed.path)return {path:realm.mount||`/${realm.id}`,realm:realm.id,name:realm.label||realm.id,type:'realm',size:0,protection:realm.protection,governance:fsRealmGovernance(realm),audit:realm.audit||'none'};
    const entry=(await this.catalog(realm.id)).get(parsed.path);return entry?{...entry,path:`${String(realm.mount||`/${realm.id}`).replace(/\/$/,'')}/${entry.path}`,realm:realm.id}:null;
  }
  async pigFsList(path='/'){
    const resolved=resolveMountedPigFsPath(path,this.realms(),{allowRoot:true}),target=resolved.target;
    if(target==='data')return this.realms().sort((a,b)=>a.id.localeCompare(b.id)).map((realm)=>({path:realm.mount||`/${realm.id}`,realm:realm.id,name:realm.label||realm.id,type:'realm',size:0,protection:realm.protection,governance:fsRealmGovernance(realm),audit:realm.audit||'none'}));
    const parsed={realmId:resolved.realmId,path:resolved.path},realm=this.fsRoot?.realms?.[parsed.realmId]||resolved.realm;if(!realm)return [];
    const catalog=await this.catalog(realm.id),prefix=parsed.path?`${parsed.path}/`:'';const list=[];
    for(const entry of catalog.values()){if(!entry.path.startsWith(prefix))continue;const rest=entry.path.slice(prefix.length);if(rest&&!rest.includes('/'))list.push({...entry,path:`${String(realm.mount||`/${realm.id}`).replace(/\/$/,'')}/${entry.path}`,realm:realm.id});}
    return list.sort((a,b)=>a.name.localeCompare(b.name));
  }
  async pigFsReadRange(path,offset=0,length=null){
    const resolved=resolveMountedPigFsPath(path,this.realms(),{allowRoot:false}),parsed={realmId:resolved.realmId,path:resolved.path},realm=this.fsRoot?.realms?.[parsed.realmId]||resolved.realm;if(!realm)return null;
    const entry=(await this.catalog(realm.id)).get(parsed.path);if(!entry||entry.type!=='file')return null;
    const start=Number(offset),end=Math.min(entry.size,start+(length==null?entry.size-start:Number(length)));if(!Number.isSafeInteger(start)||start<0||start>entry.size||!Number.isSafeInteger(end)||end<start)throw new Error('Invalid PigFS range');
    const parts=[];for(const chunk of await fsMap(this.source,realm,entry)){const cs=chunk.plainOffset,ce=cs+chunk.plainLength;if(ce<=start||cs>=end)continue;if(chunk.encryption||realm.protection==='sealed'){const e=new Error(`PigFS realm ${realm.id} is sealed`);e.code='PIG_FS_LOCKED';throw e;}const rec=await readFsRecord(this.source,chunk.recordOffset);if(rec.type!==FS_RECORD.DATA)throw new Error('PigFS data record mismatch');if(chunk.plainSha256&&await sha256Hex(rec.payload)!==chunk.plainSha256)throw new Error('PigFS data integrity check failed');parts.push(rec.payload.subarray(Math.max(start,cs)-cs,Math.min(end,ce)-cs));}return concat(parts);
  }
  async verifySignature(){
    if(!this.has(SIGNATURE_PATH))return {status:'unsigned',valid:false,publisher:null};
    try{
      const loaded=await this.read(SIGNATURE_PATH);const record=JSON.parse(td.decode(loaded.data));if(record?.format!=='wurst/signature-1'||record.algorithm!=='ed25519')throw new Error('Unsupported Wurst signature format');
      const pub=fromBase64(record.statement.publisher.publicKeySpki);if(await sha256Hex(pub)!==record.statement.publisher.fingerprint)throw new Error('Publisher fingerprint mismatch');
      const immutableFiles=this.index.files.filter((e)=>['app','meta','piglink','piglet'].includes(e.scope||'app')&&e.path!==SIGNATURE_PATH).map((e)=>({path:e.path,length:e.length,sha256:e.sha256,mime:e.mime,scope:e.scope||'app',encryption:e.encryption??null,integrity:e.integrity??null})).sort((a,b)=>a.path.localeCompare(b.path));
      const manifest=structuredClone(this.manifest);
      const projection={format:'wurst/signing-projection-7',manifest,immutableFiles};const digest=await sha256Hex(te.encode(canonicalStringify(projection)));if(record.statement.packageDigest!==`sha256:${digest}`)throw new Error('Signed package digest mismatch');
      const key=await crypto.subtle.importKey('spki',pub,{name:'Ed25519'},false,['verify']);const valid=await crypto.subtle.verify({name:'Ed25519'},key,fromBase64(record.signature),te.encode(canonicalStringify(record.statement)));if(!valid)throw new Error('Ed25519 verification failed');
      let certificateTrust=null;
      if(record.certificate){
        certificateTrust=await verifyPublisherCertificateWeb(record.certificate);
        const subject=certificateTrust.subject;
        if(certificateTrust.valid&&subject&&(subject.fingerprint!==record.statement.publisher.fingerprint||subject.publicKeySpki!==record.statement.publisher.publicKeySpki||(subject.domain!=null&&subject.domain!==record.statement.publisher.domain)||(subject.email!=null&&subject.email!==record.statement.publisher.email)))throw new Error('Publisher certificate subject does not match package signer');
      }
      return {status:'signed',valid:true,publisher:{...record.statement.publisher},certificate:record.certificate||null,certificateTrust};
    }catch(error){return {status:'invalid',valid:false,publisher:null,error:error.message};}
  }
}

function entryName(path){return path.split('/').at(-1)||'data';}
function directoryEntry(path, now=Date.now(), revision=1) { return {objectId:crypto.randomUUID(),path,name:entryName(path),type:'directory',size:0,mime:null,createdAt:now,modifiedAt:now,revision}; }

class MemoryChunkStore {
  constructor(sessionId){this.sessionId=sessionId;this.items=new Map();}
  async put(storageId,index,data){this.items.set(`${storageId}:${index}`,data instanceof Blob?data:new Blob([bytes(data)]));}
  async get(storageId,index){return this.items.get(`${storageId}:${index}`)||null;}
  async deleteStorage(storageId){for(const key of [...this.items.keys()])if(key.startsWith(`${storageId}:`))this.items.delete(key);}
  async clear(){this.items.clear();}
}

class IndexedDbChunkStore {
  constructor(sessionId){this.sessionId=sessionId;this.dbPromise=this.#open();}
  #open(){return new Promise((resolve,reject)=>{const request=indexedDB.open('wurster-web-runtime-v2',1);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('chunks')){const store=db.createObjectStore('chunks',{keyPath:'key'});store.createIndex('storageId','storageId',{unique:false});store.createIndex('sessionId','sessionId',{unique:false});}};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error||new Error('Could not open Wurster Web storage'));});}
  async #tx(mode,fn){const db=await this.dbPromise;return new Promise((resolve,reject)=>{const tx=db.transaction('chunks',mode),store=tx.objectStore('chunks');let result;try{result=fn(store,tx);}catch(error){tx.abort();reject(error);return;}tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||new Error('Wurster Web storage transaction failed'));tx.onabort=()=>reject(tx.error||new Error('Wurster Web storage transaction aborted'));});}
  async put(storageId,index,data){const blob=data instanceof Blob?data:new Blob([bytes(data)]);await this.#tx('readwrite',(store)=>store.put({key:`${storageId}:${index}`,storageId,sessionId:this.sessionId,index,blob}));}
  async get(storageId,index){const db=await this.dbPromise;return new Promise((resolve,reject)=>{const tx=db.transaction('chunks','readonly'),req=tx.objectStore('chunks').get(`${storageId}:${index}`);req.onsuccess=()=>resolve(req.result?.blob||null);req.onerror=()=>reject(req.error||new Error('Could not read Wurster Web chunk'));});}
  async #deleteByIndex(indexName,value){await this.#tx('readwrite',(store)=>{const index=store.index(indexName),range=IDBKeyRange.only(value),request=index.openKeyCursor(range);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;store.delete(cursor.primaryKey);cursor.continue();};});}
  async deleteStorage(storageId){await this.#deleteByIndex('storageId',storageId);}
  async clear(){await this.#deleteByIndex('sessionId',this.sessionId);}
}

function createChunkStore(sessionId){return typeof indexedDB!=='undefined'&&typeof IDBKeyRange!=='undefined'?new IndexedDbChunkStore(sessionId):new MemoryChunkStore(sessionId);}
function storageDescriptor(storageId, sizes){let offset=0;return {kind:'store',storageId,chunks:sizes.map((size,index)=>{const item={index,plainOffset:offset,size};offset+=size;return item;}),size:offset};}

export class WurstWebPigFsOverlay {
  constructor(reader,{sessionId=null,chunkStore=null}={}){this.reader=reader;this.sessionId=sessionId||`overlay-${crypto.randomUUID?.()||Math.random().toString(36).slice(2)}`;this.store=chunkStore||createChunkStore(this.sessionId);this.overlay=new Map();this.sessions=new Map();this.nextSession=1;this.baseCatalog=null;}
  _resolve(path,{allowRoot=true}={}){return resolveMountedPigFsPath(path,this.reader.realms(),{allowRoot});}
  _realm(path){const resolved=this._resolve(path,{allowRoot:true});return {parsed:{target:resolved.target,realmId:resolved.realmId,path:resolved.path},realm:resolved.realm,target:resolved.target,publicPath:resolved.publicPath};}
  _public(path){return mountedPublicPigFsPath(path,this.reader.realms());}
  _assertOrdinaryWritable(path){const {parsed,realm}=this._realm(path);if(!realm)throw new Error(`Unknown PigFS realm ${parsed.realmId}`);if(fsRealmGovernance(realm)!=='ordinary'||realm.protection!=='public'){const e=new Error(`Wurster Web 0.20 writes currently support ordinary public realms only; ${realm.id} is ${fsRealmGovernance(realm)}/${realm.protection}`);e.code='PIG_FS_WEB_IDENTITY_REQUIRED';throw e;}return {parsed,realm};}
  async base(){
    if(this.baseCatalog)return this.baseCatalog;
    const out=new Map();
    for(const realm of this.reader.realms()){
      if(realm.protection==='sealed')continue;
      const catalog=await this.reader.catalog(realm.id);
      for(const entry of catalog.values()){
        const full=`data/${realm.id}/${entry.path}`;
        out.set(full,{...structuredClone(entry),path:full,realm:realm.id});
      }
    }
    this.baseCatalog=out;return out;
  }
  async merged(){const out=new Map([...await this.base()].map(([k,v])=>[k,structuredClone(v)]));for(const [k,v] of this.overlay){if(v===null)out.delete(k);else out.set(k,structuredClone(v.entry));}return out;}
  async _ensureParents(path,now=Date.now()){const merged=await this.merged(),parts=path.split('/');for(let i=2;i<parts.length-1;i+=1){const p=parts.slice(0,i+1).join('/');if(merged.has(p))continue;const entry=directoryEntry(p,now);entry.realm=parts[1];this.overlay.set(p,{entry,source:null});merged.set(p,entry);}}
  async stat(path){const resolved=this._resolve(path,{allowRoot:true}),target=resolved.target;if(target==='data')return {path:'/',name:'pigfs',type:'directory',size:0};const {parsed,realm}=this._realm(resolved.publicPath);if(!realm)return null;if(!parsed.path)return {path:realm.mount||`/${realm.id}`,realm:realm.id,name:realm.label||realm.id,type:'realm',size:0,protection:realm.protection,governance:fsRealmGovernance(realm),audit:realm.audit||'none'};if(realm.protection==='sealed'&&!this.overlay.has(target)){const e=new Error(`PigFS realm ${realm.id} is sealed`);e.code='PIG_FS_LOCKED';throw e;}const item=(await this.merged()).get(target);return item?{...item,path:this._public(item.path)}:null;}
  async list(path='/'){const resolved=this._resolve(path,{allowRoot:true}),target=resolved.target;if(target==='data')return this.reader.realms().sort((a,b)=>a.id.localeCompare(b.id)).map((realm)=>({path:realm.mount||`/${realm.id}`,realm:realm.id,name:realm.label||realm.id,type:'realm',size:0,protection:realm.protection,governance:fsRealmGovernance(realm),audit:realm.audit||'none'}));const {parsed,realm}=this._realm(resolved.publicPath);if(!realm)return[];if(realm.protection==='sealed'){const e=new Error(`PigFS realm ${realm.id} is sealed`);e.code='PIG_FS_LOCKED';throw e;}const prefix=parsed.path?`${target}/`:`data/${realm.id}/`,out=[];for(const entry of (await this.merged()).values()){if(!entry.path.startsWith(prefix))continue;const rest=entry.path.slice(prefix.length);if(rest&&!rest.includes('/'))out.push({...entry,path:this._public(entry.path)});}return out.sort((a,b)=>a.name.localeCompare(b.name));}
  async _readStored(source,offset=0,length=null){const start=Number(offset),total=source.size,end=Math.min(total,start+(length==null?total-start:Number(length)));if(!Number.isSafeInteger(start)||start<0||start>total||!Number.isSafeInteger(end)||end<start)throw new Error('Invalid PigFS range');const parts=[];for(const chunk of source.chunks){const cs=chunk.plainOffset,ce=cs+chunk.size;if(ce<=start||cs>=end)continue;const blob=await this.store.get(source.storageId,chunk.index);if(!blob)throw new Error('Wurster Web overlay chunk is missing');const a=Math.max(start,cs)-cs,b=Math.min(end,ce)-cs;parts.push(new Uint8Array(await blob.slice(a,b).arrayBuffer()));}return concat(parts);}
  async read(path,{offset=0,length=null}={}){const resolved=this._resolve(path,{allowRoot:false}),target=resolved.target,{realm}=this._realm(resolved.publicPath);if(!realm)return null;if(realm.protection==='sealed'&&!this.overlay.has(target)){const e=new Error(`PigFS realm ${realm.id} is sealed`);e.code='PIG_FS_LOCKED';throw e;}if(this.overlay.has(target)){const own=this.overlay.get(target);if(own===null||own.entry.type!=='file')return null;if(own.source?.kind==='store')return this._readStored(own.source,offset,length);if(own.source?.kind==='base')return this.reader.pigFsReadRange(this._public(own.source.path),Number(offset),length==null?null:Number(length));return new Uint8Array(0);}return this.reader.pigFsReadRange(resolved.publicPath,Number(offset),length==null?null:Number(length));}
  async write(path,data,{mime='application/octet-stream'}={}){const tx=await this.beginWrite(path,{mime});try{const blob=data instanceof Blob?data:new Blob([bytes(data)],{type:mime});for(let offset=0,index=0;offset<blob.size||(blob.size===0&&index===0);offset+=FS_CHUNK,index+=1){const chunk=new Uint8Array(await blob.slice(offset,Math.min(blob.size,offset+FS_CHUNK)).arrayBuffer());await this.writeChunk(tx.id,chunk);if(blob.size===0)break;}return await this.commitWrite(tx.id);}catch(error){await this.abortWrite(tx.id).catch(()=>{});throw error;}}
  async beginWrite(path,{mime='application/octet-stream'}={}){const resolved=this._resolve(path,{allowRoot:false}),target=resolved.target;this._assertOrdinaryWritable(resolved.publicPath);const id=`${this.sessionId}-tx-${this.nextSession++}-${crypto.randomUUID?.()||Math.random().toString(36).slice(2)}`;this.sessions.set(id,{path:target,mime,sizes:[],size:0});return {id,chunkSize:FS_CHUNK};}
  async writeChunk(id,data){const s=this.sessions.get(String(id));if(!s)throw new Error('Unknown PigFS write session');const b=bytes(data);if(b.byteLength>FS_CHUNK)throw new Error('PigFS chunk exceeds 4 MiB');const index=s.sizes.length;await this.store.put(String(id),index,b);s.sizes.push(b.byteLength);s.size+=b.byteLength;return {bytes:b.byteLength,total:s.size};}
  async commitWrite(id){const key=String(id),s=this.sessions.get(key);if(!s)throw new Error('Unknown PigFS write session');this._assertOrdinaryWritable(this._public(s.path));this.sessions.delete(key);const target=s.path,merged=await this.merged(),prev=merged.get(target),now=Date.now();await this._ensureParents(target,now);const previousOwn=this.overlay.get(target);const source=storageDescriptor(key,s.sizes);const entry={objectId:prev?.objectId||crypto.randomUUID(),path:target,realm:target.split('/')[1],name:entryName(target),type:'file',size:s.size,mime:s.mime||prev?.mime||'application/octet-stream',createdAt:prev?.createdAt||now,modifiedAt:now,revision:(prev?.revision||0)+1,mapPages:[]};this.overlay.set(target,{entry,source});if(previousOwn?.source?.kind==='store'&&previousOwn.source.storageId!==key)await this.store.deleteStorage(previousOwn.source.storageId).catch(()=>{});return {...entry,path:this._public(target)};}
  async abortWrite(id){const key=String(id),existed=this.sessions.delete(key);await this.store.deleteStorage(key).catch(()=>{});return existed;}
  async _dropStorage(item){if(item?.source?.kind==='store')await this.store.deleteStorage(item.source.storageId).catch(()=>{});}
  async remove(path,{recursive=false}={}){const resolved=this._resolve(path,{allowRoot:false}),target=resolved.target;const {parsed}=this._assertOrdinaryWritable(resolved.publicPath);if(!parsed.path)throw new Error('Cannot remove a PigFS realm');const merged=await this.merged(),e=merged.get(target);if(!e)return false;if(e.type==='directory'){const children=[...merged.keys()].filter((p)=>p.startsWith(`${target}/`));if(children.length&&!recursive)throw new Error('PigFS directory is not empty');for(const p of children){await this._dropStorage(this.overlay.get(p));this.overlay.set(p,null);}}await this._dropStorage(this.overlay.get(target));this.overlay.set(target,null);return true;}
  async mkdir(path,{recursive=true}={}){const resolved=this._resolve(path,{allowRoot:true}),target=resolved.target;if(target==='data')return {path:'/',type:'directory'};const {parsed}=this._assertOrdinaryWritable(resolved.publicPath);if(!parsed.path)return this.stat(resolved.publicPath);const merged=await this.merged(),now=Date.now();if(merged.has(target))return this.stat(resolved.publicPath);if(!recursive){const parent=target.split('/').slice(0,-1).join('/');if(parent.split('/').length>2&&!merged.has(parent))throw new Error('PigFS parent directory does not exist');}else await this._ensureParents(`${target}/placeholder`,now);const entry=directoryEntry(target,now);entry.realm=parsed.realmId;this.overlay.set(target,{entry,source:null});return {...entry,path:this._public(target)};}
  async rename(fromPath,toPath){const fromResolved=this._resolve(fromPath,{allowRoot:false}),toResolved=this._resolve(toPath,{allowRoot:false}),from=fromResolved.target,to=toResolved.target,a=this._assertOrdinaryWritable(fromResolved.publicPath),b=this._assertOrdinaryWritable(toResolved.publicPath);if(a.parsed.realmId!==b.parsed.realmId)throw new Error('PigFS rename cannot cross realm boundaries');if(!a.parsed.path||!b.parsed.path)throw new Error('Cannot rename a PigFS realm');const merged=await this.merged();if(!merged.has(from))throw new Error('PigFS source does not exist');if(merged.has(to))throw new Error('PigFS destination exists');await this._ensureParents(to,Date.now());const affected=[...merged.entries()].filter(([p])=>p===from||p.startsWith(`${from}/`));for(const [p,e] of affected){const own=this.overlay.has(p)?this.overlay.get(p):undefined;const source=e.type==='file'?(own?.source||{kind:'base',path:p}):null;this.overlay.set(p,null);const np=`${to}${p.slice(from.length)}`,ne={...e,path:np,name:entryName(np),modifiedAt:Date.now(),revision:(e.revision||0)+1};this.overlay.set(np,{entry:ne,source});}return this.stat(toResolved.publicPath);}
  capabilities(){return {read:true,write:true,persistent:false,snapshot:true,streamingWrite:true,rangeRead:true,realms:true,identityRealms:false,source:this.reader.source.kind,backing:typeof indexedDB!=='undefined'?'indexeddb':'memory'};}
  realms(){return this.reader.realms();}
  async usage(){let overlayBytes=0;for(const item of this.overlay.values())if(item?.source?.kind==='store')overlayBytes+=item.source.size;return {overlayBytes,persistent:false,reclaimableBytes:0};}
  async *snapshotChunks(){const realms=this.reader.realms();const unsupported=realms.filter((realm)=>fsRealmGovernance(realm)!=='ordinary'||realm.protection!=='public');if(unsupported.length)throw new Error(`Web snapshot export currently requires ordinary public realms; cannot export ${unsupported.map((realm)=>realm.id).join(', ')}`);for(let o=0;o<this.reader.baseLength;o+=FS_CHUNK)yield await this.reader.source.read(o,Math.min(FS_CHUNK,this.reader.baseLength-o));const entries=await this.merged();yield* encodeFsSnapshotStream(realms,entries,async(path,offset,length)=>{const data=await this.read(this._public(path),{offset,length});return data??new Uint8Array(0);},this.reader.baseLength,this.reader.fsRoot?.generation??1);}
  async snapshotBlob(){const parts=[];for await(const chunk of this.snapshotChunks())parts.push(chunk);return new Blob(parts,{type:'application/vnd.wurster.wurst'});}
  async dispose(){for(const id of [...this.sessions.keys()])await this.abortWrite(id).catch(()=>{});await this.store.clear().catch(()=>{});this.overlay.clear();}
}

function splitItems(items,wrap,target){const groups=[];let current=[];for(const item of items){const trial=[...current,item];if(current.length&&te.encode(JSON.stringify(wrap(trial))).byteLength>target){groups.push(current);current=[item];}else current=trial;}if(current.length)groups.push(current);return groups;}
async function makeRecord(type,payload,{recordStart,previousCommitOffset=0,sequence=0}){const body=bytes(payload);if(body.byteLength>FS_MAX_PAYLOAD)throw new Error('PigFS record too large');const header=new Uint8Array(FS_RECORD_HEADER),hv=new DataView(header.buffer);header.set(FS_MAGIC);writeU16(hv,4,1);writeU16(hv,6,type);writeU64(hv,8,body.byteLength);writeU64(hv,16,previousCommitOffset);writeU64(hv,24,sequence);const trailer=new Uint8Array(FS_RECORD_TRAILER),tv=new DataView(trailer.buffer);trailer.set(FS_END_MAGIC);writeU16(tv,4,1);writeU16(tv,6,type);writeU64(tv,8,recordStart);writeU64(tv,16,previousCommitOffset);writeU64(tv,24,body.byteLength);trailer.set(bytesFromHex(await sha256Hex(body)),32);return concat([header,body,trailer]);}
function bytesFromHex(value){const out=new Uint8Array(value.length/2);for(let i=0;i<out.length;i++)out[i]=parseInt(value.slice(i*2,i*2+2),16);return out;}
function webFsStateForHash(root){return {format:'wurst/pigfs-1',historyMode:root.historyMode,generation:root.generation,previousCommitOffset:root.previousCommitOffset??null,previousCommitHash:root.previousCommitHash??null,committedAt:root.committedAt,rootPolicy:root.rootPolicy,identities:root.identities,realms:root.realms,mutation:root.mutation};}
async function* encodeFsSnapshotStream(realms,entries,readFileChunk,baseOffset,generation=1){
  if(!realms.length)return;
  let nextOffset=baseOffset,sequence=0;
  const make=async(type,payload)=>{const start=nextOffset,record=await makeRecord(type,payload,{recordStart:start,sequence:++sequence});nextOffset+=record.byteLength;return {start,record};};
  const realmRoots={};
  for(const declared of realms){
    if(fsRealmGovernance(declared)!=='ordinary'||declared.protection!=='public')throw new Error(`Cannot snapshot non-ordinary realm ${declared.id} without an identity broker`);
    const prefix=`data/${declared.id}/`;
    const local=new Map();
    for(const [full,entry] of entries){if(!full.startsWith(prefix))continue;const rel=full.slice(prefix.length);if(!rel)continue;const copy=structuredClone(entry);copy.path=rel;delete copy.realm;copy.name=entryName(rel);copy.mapPages=[];local.set(rel,copy);}
    const files=[...local.values()].filter((e)=>e.type==='file').sort((a,b)=>a.path.localeCompare(b.path));
    const maps=new Map();
    for(const file of files){const chunks=[];const full=`data/${declared.id}/${file.path}`;for(let off=0;off<file.size||(file.size===0&&off===0);off+=FS_CHUNK){const len=Math.min(FS_CHUNK,Math.max(0,file.size-off)),chunk=await readFileChunk(full,off,len),made=await make(FS_RECORD.DATA,chunk);yield made.record;chunks.push({plainOffset:off,plainLength:len,recordOffset:made.start,storedLength:len,plainSha256:await sha256Hex(chunk),encryption:null,aad:null});if(file.size===0)break;}maps.set(file.path,chunks);}
    for(const [filePath,chunks] of maps){const entry=local.get(filePath),groups=splitItems(chunks,(part)=>({format:'wurst/pigfs-map-1',chunks:part}),FS_MAP_TARGET);entry.mapPages=[];for(const part of groups){const payload=te.encode(JSON.stringify({format:'wurst/pigfs-map-1',chunks:part})),made=await make(FS_RECORD.MAP,payload);yield made.record;entry.mapPages.push({recordOffset:made.start,payloadLength:payload.byteLength,plainSha256:await sha256Hex(payload),encryption:null,aad:null,plainStart:part[0]?.plainOffset||0,plainEnd:part.length?part.at(-1).plainOffset+part.at(-1).plainLength:0,count:part.length});}}
    const sorted=[...local.values()].sort((a,b)=>a.path.localeCompare(b.path)),catalogPages=[];
    for(const part of splitItems(sorted,(items)=>({format:'wurst/pigfs-catalog-1',entries:items}),FS_CATALOG_TARGET)){const payload=te.encode(JSON.stringify({format:'wurst/pigfs-catalog-1',entries:part})),made=await make(FS_RECORD.CATALOG,payload);yield made.record;catalogPages.push({recordOffset:made.start,payloadLength:payload.byteLength,plainSha256:await sha256Hex(payload),encryption:null,aad:null,first:part[0]?.path||'',last:part.at(-1)?.path||'',count:part.length});}
    realmRoots[declared.id]={id:declared.id,label:declared.label||declared.id,audit:'none',protection:'public',access:{read:{mode:'public',identities:[]},write:{mode:'open',identities:[]},admins:[]},keyWraps:[],catalogPages,stats:{files:files.length,directories:sorted.length-files.length,logicalBytes:files.reduce((sum,e)=>sum+Number(e.size||0),0)}};
  }
  const committedAt=Date.now();
  const root={format:'wurst/pigfs-1',historyMode:'none',generation:Math.max(1,Number(generation)||1),previousCommitOffset:null,previousCommitHash:null,committedAt,rootPolicy:{admins:[]},identities:{},realms:realmRoots,mutation:null,authorization:null,stateHash:null,commitHash:null};
  root.stateHash=await sha256Hex(te.encode(canonicalStringify(webFsStateForHash(root))));
  root.commitHash=await sha256Hex(te.encode(canonicalStringify({stateHash:root.stateHash,authorization:null})));
  const made=await make(FS_RECORD.COMMIT,te.encode(JSON.stringify(root)));yield made.record;
}
async function encodeFsSnapshot(realms,entries,readFileChunk,baseOffset,generation=1){const records=[];for await(const record of encodeFsSnapshotStream(realms,entries,readFileChunk,baseOffset,generation))records.push(record);return records;}

function injectBootstrap(html,session){
  const network=Array.isArray(session.reader.manifest?.capabilities?.network)?session.reader.manifest.capabilities.network:[];
  const hostOrigin=location.origin;
  const csp=`default-src ${hostOrigin} data: blob:; script-src ${hostOrigin} 'unsafe-inline' blob:; style-src ${hostOrigin} 'unsafe-inline' blob:; img-src ${hostOrigin} data: blob: ${network.join(' ')}; media-src ${hostOrigin} data: blob: ${network.join(' ')}; font-src ${hostOrigin} data: blob:; connect-src ${hostOrigin} ${network.join(' ')}; object-src 'none'; frame-src ${hostOrigin}; base-uri 'none';`;
  const config={sessionId:session.id,root:session._virtualBase(),origin:location.origin,wurstId:session.reader.manifest?.id||null,piglinkEntry:session.reader.manifest?.piglink?.entry||null,piglink:session.reader.manifest?.piglink||null,parent:session.options.parent||null,embedModuleUrl:new URL('./wurster-embed.js',import.meta.url).toString()};
  const script=`<meta http-equiv="Content-Security-Policy" content="${csp.replaceAll('"','&quot;')}"><script>(${frameBootstrap.toString()})(${JSON.stringify(config)})<\/script>`;
  return /<head[\s>]/i.test(html)?html.replace(/<head([^>]*)>/i,`<head$1>${script}`):`${script}${html}`;
}
function frameBootstrap(config){
  const pending=new Map();let seq=1;const handlers=new Map();const parentPigLinkListeners=new Map();const embedRelationships=new Map();const embedSessions=new Map();const embedParentPigLinkSubscriptions=new Map();const embedSessionSubscriptions=new Map();const machineClients=new Map();let nextEmbedSubscriptionId=1;let piglinkReadyResolve;const piglinkReady=new Promise(r=>piglinkReadyResolve=r);
  function call(method,...args){const id=`${config.sessionId}:${seq++}`;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});parent.postMessage({__wurster:1,sessionId:config.sessionId,id,method,args},'*');});}
  addEventListener('message',async(event)=>{const m=event.data;if(m?.__wursterReply&&m.sessionId===config.sessionId){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.ok?p.resolve(m.result):p.reject(new Error(m.error||'Wurster Web operation failed'));return;}if(m?.__wursterSessionChanged&&m.sessionId===config.sessionId){try{dispatchEvent(new CustomEvent('wurst-session-changed',{detail:{session:structuredClone(m.session??null)}}));}catch{}return;}if(m?.__wursterPigletSessionChanged&&m.sessionId===config.sessionId){const sid=String(m.session?.id||'');if(sid){for(const sub of embedSessionSubscriptions.values()){if(embedSessions.get(sub.handle)?.id!==sid)continue;embedSessions.set(sub.handle,structuredClone(m.session));try{sub.callback({writer:String(m.writer||''),session:structuredClone(m.session),size:Number(m.size||0)});}catch{}}}return;}if(m?.__wursterPigletMachineEvent&&m.sessionId===config.sessionId){const sid=String(m.childSessionId||'');const name=String(m.name||''),payload=structuredClone(m.payload??null);for(const client of machineClients.values()){if(client.sessionId!==sid)continue;for(const key of [name,'*'])for(const listener of client.listeners.get(key)||[]){try{listener(payload,name);}catch{}}}return;}if(m?.__wursterParentPigLinkEvent&&m.sessionId===config.sessionId){const name=String(m.name||''),payload=structuredClone(m.payload??null);for(const key of [name,'*'])for(const listener of parentPigLinkListeners.get(key)||[]){try{listener(payload,name);}catch{}}return;}if(m?.__wursterPigLinkEventAccepted&&m.sessionId===config.sessionId){const name=String(m.name||''),payload=structuredClone(m.payload??null);for(const sub of embedParentPigLinkSubscriptions.values()){if(!embedRelationships.get(sub.handle)?.piglink)continue;try{sub.callback(name,payload);}catch{}}return;}if(m?.__wursterPigLinkInvoke&&m.sessionId===config.sessionId){const id=String(m.id||'');try{await piglinkReady;const name=String(m.name||''),fn=handlers.get(name);if(!fn)throw new Error(`Wurst action is declared but not registered: ${name}`);const result=await fn(structuredClone(m.input??{}));parent.postMessage({__wursterPigLinkResult:1,sessionId:config.sessionId,id,ok:true,result:structuredClone(result==null?null:result)},'*');}catch(error){parent.postMessage({__wursterPigLinkResult:1,sessionId:config.sessionId,id,ok:false,error:error?.message||String(error)},'*');}}});
  window.PigLink=Object.freeze({define(def={}){for(const [name,fn] of Object.entries(def.actions||{})){if(typeof fn!=='function')throw new Error(`PigLink action must be a function: ${name}`);handlers.set(name,fn);}return true;}});
  const dataUrl=(path)=>{const v=String(path??'').replaceAll('\\','/').replace(/^\/+/, '').replace(/^data\//,'');if(!v||v.split('/').some(p=>!p||p==='.'||p==='..'))throw new TypeError('Invalid PigFS media path');return `${config.root}/pigfs/${v.split('/').map(encodeURIComponent).join('/')}`;};
  const parentPigFs=config.parent?.pigfs?Object.freeze({capabilities:()=>call('parent.pigfs.capabilities'),realms:()=>call('parent.pigfs.realms'),usage:()=>call('parent.pigfs.usage'),stat:(p)=>call('parent.pigfs.stat',p),list:(p='/')=>call('parent.pigfs.list',p),read:async(p,o={})=>{const result=await call('parent.pigfs.read',p,{offset:Number(o.offset||0),length:o.length==null?null:Number(o.length)});return result?.data??result;},write:(p,d,o={})=>call('parent.pigfs.write',p,d,o),beginWrite:(p,o={})=>call('parent.pigfs.beginWrite',p,o),writeChunk:(id,d)=>call('parent.pigfs.writeChunk',id,d),commitWrite:(id)=>call('parent.pigfs.commitWrite',id),abortWrite:(id)=>call('parent.pigfs.abortWrite',id),remove:(p,o={})=>call('parent.pigfs.remove',p,o),mkdir:(p,o={})=>call('parent.pigfs.mkdir',p,o),rename:(a,b)=>call('parent.pigfs.rename',a,b)}):null;
  const parentPigLink=config.parent?.piglink?Object.freeze({describe:()=>call('parent.piglink.describe'),invoke:(name,input={})=>call('parent.piglink.invoke',String(name||''),input),on:(name,listener)=>{const eventName=String(name??'*');if(typeof listener!=='function')throw new TypeError('Parent PigLink event listener must be a function');const set=parentPigLinkListeners.get(eventName)||new Set();set.add(listener);parentPigLinkListeners.set(eventName,set);return()=>{set.delete(listener);if(!set.size)parentPigLinkListeners.delete(eventName);};}}):null;
  const parentPiglets=config.parent?.piglets?Object.freeze({children:()=>call('parent.piglet.children'),inspect:(ref)=>call('parent.piglet.inspect',String(ref||'')),install:(name,data,options={})=>call('parent.piglet.install',String(name||'Piglet.wurst'),data,options),remove:(ref)=>call('parent.piglet.remove',String(ref||''))}):null;
  const parentRuntime=config.parent?Object.freeze({
    info:()=>Promise.resolve(structuredClone(config.parent.application||null)),
    relationship:()=>Promise.resolve(structuredClone({format:config.parent.format,isolated:Boolean(config.parent.isolated),piglink:config.parent.piglink||null,pigfs:config.parent.pigfs||null,piglets:config.parent.piglets||null})),
    pigfs:parentPigFs,piglink:parentPigLink,piglets:parentPiglets
  }):null;
  window.wurst=Object.freeze({
    info:()=>call('info'),capabilities:Object.freeze({query:(n)=>call('capabilities.query',String(n||'')),list:()=>call('capabilities.list')}),
    parent:parentRuntime,
    auth:Object.freeze({status:(purpose='identity')=>call('auth.status',String(purpose||'identity')),onResult:()=>true}),identity:Object.freeze({session:()=>Promise.resolve(null)}),window:Object.freeze({close:()=>call('window.close'),minimize:()=>call('window.minimize')}),snapshot:Object.freeze({export:()=>call('snapshot.export')}),
    piglink:Object.freeze({ready:()=>piglinkReady.then(()=>Boolean(config.piglinkEntry)),describe:()=>call('piglink.describe'),invoke:async(name,input={})=>{await piglinkReady;const fn=handlers.get(String(name));if(!fn)throw new Error(`Wurst action is not registered: ${name}`);return fn(structuredClone(input));},emit:(name,payload=null)=>{parent.postMessage({__wursterEvent:1,sessionId:config.sessionId,name,payload},'*');return true;}}),
    piglet:Object.freeze({children:()=>call('piglet.children'),running:()=>call('piglet.running'),connect:async(ref,options={})=>{const opened=await call('piglet.machineConnect',String(ref||''),options);const handle=String(opened?.handle||'');if(!handle)throw new Error('Wurster did not return a machine attachment');let closed=false;const client={sessionId:String(opened?.session?.id||''),listeners:new Map()};machineClients.set(handle,client);return Object.freeze({descriptor:structuredClone(opened.descriptor||null),session:structuredClone(opened.session||null),piglink:Object.freeze({describe:()=>call('piglet.machineDescribe',handle),invoke:async(name,input={},invokeOptions={})=>{if(closed)throw new Error('Wurst machine connection is closed');const result=await call('piglet.machineInvoke',handle,String(name||''),input,invokeOptions);return result?.result??null;},on:(name,listener)=>{if(typeof listener!=='function')throw new TypeError('PigLink event listener must be a function');const eventName=String(name??'*'),set=client.listeners.get(eventName)||new Set();set.add(listener);client.listeners.set(eventName,set);return()=>{set.delete(listener);if(!set.size)client.listeners.delete(eventName);};}}),close:async()=>{if(closed)return false;closed=true;machineClients.delete(handle);return call('piglet.machineClose',handle);}});},invoke:async(ref,name,input={},options={})=>{const opened=await call('piglet.machineConnect',String(ref||''),options),handle=String(opened?.handle||'');if(!handle)throw new Error('Wurster did not return a machine attachment');try{const result=await call('piglet.machineInvoke',handle,String(name||''),input,options);return result?.result??null;}finally{await call('piglet.machineClose',handle).catch(()=>{});}},inspect:(ref)=>call('piglet.inspect',String(ref||'')),install:(name,data,options={})=>call('piglet.install',String(name||'Piglet.wurst'),data,options),remove:(ref)=>call('piglet.remove',String(ref||''))}),
    pigsty:Object.freeze({status:()=>call('pigsty.status'),run:(request={})=>call('pigsty.run',request),build:(name='default',request={})=>call('pigsty.build',String(name||'default'),request)}),
    pigfs:Object.freeze({capabilities:()=>call('pigfs.capabilities'),realms:()=>call('pigfs.realms'),usage:()=>call('pigfs.usage'),compact:()=>call('pigfs.compact'),url:dataUrl,stat:(p)=>call('pigfs.stat',p),list:(p='/')=>call('pigfs.list',p),read:(p,o={})=>call('pigfs.read',p,{offset:Number(o.offset||0),length:o.length==null?null:Number(o.length)}),write:(p,d,o={})=>call('pigfs.write',p,d,o),beginWrite:(p,o={})=>call('pigfs.beginWrite',p,o),writeChunk:(id,d)=>call('pigfs.writeChunk',id,d),commitWrite:(id)=>call('pigfs.commitWrite',id),abortWrite:(id)=>call('pigfs.abortWrite',id),remove:(p,o={})=>call('pigfs.remove',p,o),mkdir:(p,o={})=>call('pigfs.mkdir',p,o),rename:(a,b)=>call('pigfs.rename',a,b)})
  });
  function normalizeEmbedSource(raw){const value=String(raw??'').trim();if(!value)throw new TypeError('<wurst-embed> requires a src');if(value.startsWith('builtin:')||value.startsWith('pigfs:'))return value;if(value.startsWith('/'))return `pigfs:${value}`;return new URL(value,document.baseURI).href;}
  window.wurstEmbedRuntime=Object.freeze({open:async(src,options={})=>{const normalized=normalizeEmbedSource(src);if(/^https?:/i.test(normalized)&&!normalized.startsWith(config.root))return null;const opened=await call('piglet.embedOpen',normalized,options);if(opened?.handle){const key=String(opened.handle);embedRelationships.set(key,structuredClone(opened.parent??null));embedSessions.set(key,structuredClone(opened.session??null));}return opened;},read:(handle,offset,length)=>call('piglet.embedRead',String(handle||''),Number(offset),Number(length)),persist:async(handle,data)=>{const key=String(handle||'');const result=await call('piglet.embedPersist',key,data);if(result?.session)embedSessions.set(key,structuredClone(result.session));return result;},refresh:async(handle)=>{const key=String(handle||'');const result=await call('piglet.embedRefresh',key);if(result?.session)embedSessions.set(key,structuredClone(result.session));return result;},invoke:(handle,method,args=[])=>call('piglet.embedInvoke',String(handle||''),String(method||''),Array.isArray(args)?args:[]),subscribeParentPigLink:(handle,callback)=>{const key=String(handle||'');if(typeof callback!=='function')throw new TypeError('Parent PigLink event subscriber must be a function');if(!embedRelationships.get(key)?.piglink)throw new Error('Parent PigLink is unavailable to this Piglet');const id=`epl-${nextEmbedSubscriptionId++}`;embedParentPigLinkSubscriptions.set(id,{handle:key,callback});return id;},unsubscribeParentPigLink:(id)=>embedParentPigLinkSubscriptions.delete(String(id||'')),subscribeSession:(handle,callback)=>{const key=String(handle||'');if(typeof callback!=='function')throw new TypeError('Wurst session subscriber must be a function');if(!embedSessions.get(key)?.id)throw new Error('Wurst session is unavailable');const id=`ews-${nextEmbedSubscriptionId++}`;embedSessionSubscriptions.set(id,{handle:key,callback});return id;},unsubscribeSession:(id)=>embedSessionSubscriptions.delete(String(id||'')),close:async(handle)=>{const key=String(handle||'');for(const[id,sub]of embedParentPigLinkSubscriptions)if(sub.handle===key)embedParentPigLinkSubscriptions.delete(id);for(const[id,sub]of embedSessionSubscriptions)if(sub.handle===key)embedSessionSubscriptions.delete(id);embedRelationships.delete(key);embedSessions.delete(key);return call('piglet.embedClose',key);}});
  class WursterAuth extends HTMLElement{connectedCallback(){if(this.shadowRoot)return;const root=this.attachShadow({mode:'closed'}),wrap=document.createElement('div');wrap.style.cssText='font:600 13px system-ui;display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid rgba(80,50,60,.22);border-radius:14px;background:#fff8f6;color:#523f46;box-sizing:border-box;min-height:48px';const b=document.createElement('button');b.type='button';const type=String(this.getAttribute('type')||'identity').toLowerCase(),purpose=this.getAttribute('purpose')||(type==='wurstkey'?'application':'identity');b.textContent=type==='wurstkey'?'🔑 Unlock with Wurster Web':'🐷 Open Wurster Runtime';b.style.cssText='font:inherit;border:0;border-radius:999px;padding:8px 12px;background:#5d4650;color:white;cursor:pointer';b.addEventListener('click',async()=>{if(type==='wurstkey'){try{await call('auth.present',{type,purpose,target:this.getAttribute('target')||null,session:this.getAttribute('session')||'60m'});this.dispatchEvent(new CustomEvent('wurster-auth-success',{bubbles:true,composed:true,detail:{purpose:'application',runtime:'web'}}));}catch(error){this.dispatchEvent(new CustomEvent('wurster-auth-error',{bubbles:true,composed:true,detail:{error:error.message}}));}return;}const request=(crypto.randomUUID?.()||Math.random().toString(36).slice(2)),duration=this.getAttribute('session')||'60m';const params=new URLSearchParams({origin:config.origin,purpose,request,duration});if(config.wurstId)params.set('wurst',config.wurstId);const a=document.createElement('a');a.href=`wurster://auth?${params}`;a.target='_top';a.click();});wrap.append(b);const note=document.createElement('span');note.textContent=type==='wurstkey'?'Wurster opens the key prompt outside the Wurst DOM':'Authenticate with the trusted local runtime';wrap.append(note);root.append(wrap);}}
  customElements.define('wurster-auth',WursterAuth);
  addEventListener('DOMContentLoaded',async()=>{try{if(config.embedModuleUrl&&!customElements.get('wurst-embed')){const e=document.createElement('script');e.type='module';e.src=config.embedModuleUrl;document.head.append(e);}if(config.piglinkEntry){const s=document.createElement('script');s.src=`${config.root}/piglink/entry.js`;s.onload=()=>piglinkReadyResolve();s.onerror=()=>piglinkReadyResolve();document.head.append(s);}else piglinkReadyResolve();}catch{piglinkReadyResolve();}},{once:true});
}

export class WursterWebSession {
  static async open(input, options = {}) {
    const reader = await WurstWebReader.open(input);
    const session = new WursterWebSession(reader, options);
    if (options.wurstKey) await session.unlockApplication(options.wurstKey);
    return session;
  }
  constructor(reader, options = {}) {
    this.reader = reader;
    this.id = options.sessionId || `w${crypto.randomUUID?.().replaceAll('-', '') || Math.random().toString(36).slice(2)}`;
    this.fs = new WurstWebPigFsOverlay(reader, { sessionId: this.id });
    this.options = options;
    this.externalSession = options.externalSession ? structuredClone(options.externalSession) : null;
    this.frame = null;
    this.applicationKey = null;
    this._sealedMap = null;
    this._mountTarget = null;
    this._authOverlay = null;
    this._embedSources = new Map();
    this._embedSessions = new WurstSessionRegistry();
    this._embedWorlds = new Map();
    this._pigLinkPending = new Map();
    this._pigLinkListeners = new Set();
    this._pigLinkSeq = 1;
    this.signature = null;
    this._boundMessage = (e) => this._onFrameMessage(e);
    this._boundSw = (e) => this._onSwMessage(e);
  }
  applicationProtection() { return this.reader.manifest?.application?.protection || 'public'; }
  applicationNeedsKey() { return Boolean(this.reader.manifest?.security?.applicationKeyWrap); }
  applicationUnlocked() { return !this.applicationNeedsKey() || Boolean(this.applicationKey); }
  async unlockApplication(wurstKey) {
    if (!this.applicationNeedsKey()) return { unlocked: true, protection: 'public' };
    const key = await unlockApplicationDataKey(this.reader.manifest, wurstKey);
    const previous = this.applicationKey;
    this.applicationKey = key;
    this._sealedMap = null;
    try {
      if (this.applicationProtection() === 'sealed') await this._loadSealedMap();
      else {
        const probe = this.reader.index.files.find((entry) => (entry.scope || 'app') === 'app' && entry.encryption);
        if (probe) {
          const entry = this.reader.entry(probe.path);
          await this._readProtected(entry, 0, Math.min(1, entry.encryption?.plainLength ?? 1));
        }
      }
    } catch (error) {
      this.applicationKey = previous || null;
      this._sealedMap = null;
      throw error;
    }
    return { unlocked: true, protection: this.applicationProtection() };
  }
  async _loadSealedMap() {
    if (this.applicationProtection() !== 'sealed') return null;
    if (this._sealedMap) return this._sealedMap;
    if (!this.applicationKey) throw lockedApplicationError();
    const indexPath = this.reader.manifest?.application?.sealedIndex || SEALED_APP_INDEX_PATH;
    const entry = this.reader.entry(indexPath);
    if (!entry?.encryption) throw new Error('Sealed application index is missing or not protected');
    const data = await this._readProtected(entry, 0, entry.encryption.plainLength);
    let parsed;
    try { parsed = JSON.parse(td.decode(data)); } catch { throw new Error('Invalid sealed application map'); }
    if (parsed?.format !== 'wurst/sealed-app-map-1' || !Array.isArray(parsed.files) || !parsed.entry) throw new Error('Invalid sealed application map');
    const files = new Map();
    for (const item of parsed.files) {
      const logical = normalizeWurstPath(item.path), resource = normalizeWurstPath(item.resource);
      if (logical.startsWith('__wurst/') || logical.startsWith('data/')) throw new Error('Invalid path in sealed application map');
      const resourceEntry = this.reader.entry(resource);
      if (!resourceEntry?.encryption || (resourceEntry.scope || 'app') !== 'app') throw new Error(`Invalid protected resource in sealed application map: ${resource}`);
      files.set(logical, { entry: resourceEntry, mime: item.mime || mimeFor(logical), logicalPath: logical });
    }
    this._sealedMap = { entry: normalizeWurstPath(parsed.entry), files };
    return this._sealedMap;
  }
  async _applicationResource(path) {
    const logicalPath = normalizeWurstPath(path);
    if (this.applicationProtection() === 'sealed') {
      const map = await this._loadSealedMap();
      return map.files.get(logicalPath) || null;
    }
    const entry = this.reader.entry(logicalPath);
    return entry ? { entry, mime: entry.mime || mimeFor(logicalPath), logicalPath } : null;
  }
  async _entryPath() {
    if (this.applicationProtection() === 'sealed') return (await this._loadSealedMap()).entry;
    return normalizeWurstPath(this.reader.manifest.entry);
  }
  async _readProtected(entry, offset = 0, length = null) {
    if (!this.applicationKey) throw lockedApplicationError();
    return decryptProtectedRange(entry, async (cipherOffset, cipherLength) => {
      const loaded = await this.reader.readRange(entry.path, cipherOffset, cipherLength, { verify: true });
      return loaded.data;
    }, this.applicationKey, offset, length);
  }
  async _readImmutable(entry, offset = 0, length = null) {
    const total = entry.encryption?.plainLength ?? entry.length;
    const bounded = length == null ? total - offset : Math.min(Number(length), total - offset);
    if (entry.encryption) return this._readProtected(entry, offset, bounded);
    const loaded = offset === 0 && bounded === entry.length ? await this.reader.read(entry.path) : await this.reader.readRange(entry.path, offset, bounded);
    return loaded.data;
  }
  _virtualBase() {
    const configured = this.options.serviceWorkerScope || '/';
    const pathname = new URL(configured, location.origin).pathname.replace(/\/+$/, '') || '';
    return `${location.origin}${pathname}/__wurster/${this.id}`.replace(/([^:]\/)\/+/g, '$1');
  }
  async refreshEmbeddedSource({ size, session = null } = {}) {
    const source = this.reader?.source;
    if (!source?.resize) throw new Error('This Wurst session source cannot be refreshed in place');
    if (this.fs?.sessions?.size || this.fs?.overlay?.size) {
      const error = new Error('This Wurst view has uncommitted PigFS state and cannot rebase automatically');
      error.code = 'WURST_SESSION_CONFLICT';
      throw error;
    }
    const previousId = this.reader.manifest?.id ?? null;
    await this.fs.dispose().catch(() => {});
    source.resize(Number(size));
    const reader = await WurstWebReader.open(source);
    if ((reader.manifest?.id ?? null) !== previousId) throw new Error('Wurst identity changed while refreshing the shared session');
    const signature = await reader.verifySignature();
    if (signature.status === 'invalid') throw new Error(`Wurst signature became invalid while refreshing the shared session: ${signature.error || 'verification failed'}`);
    this.reader = reader;
    this.signature = signature;
    this.fs = new WurstWebPigFsOverlay(reader, { sessionId: this.id });
    this.externalSession = session ? structuredClone(session) : this.externalSession;
    if (this.frame?.contentWindow) {
      this.frame.contentWindow.postMessage({
        __wursterSessionChanged: 1,
        sessionId: this.id,
        session: this.externalSession ? structuredClone(this.externalSession) : null
      }, '*');
    }
    return { ok: true, session: this.externalSession, size: source.size };
  }
  async mount(container) {
    if (typeof document === 'undefined' || !navigator.serviceWorker) throw new Error('Wurster Web mount requires a browser with Service Worker support');
    const target = typeof container === 'string' ? document.querySelector(container) : container;
    if (!target) throw new Error('Wurster Web mount container not found');
    this._mountTarget = target;
    this.signature = await this.reader.verifySignature();
    if (this.signature.status === 'invalid') throw new Error(`Wurst signature is invalid: ${this.signature.error || 'verification failed'}`);
    if (this.applicationProtection() === 'sealed' && !this.applicationUnlocked()) {
      await this._presentApplicationUnlock({ resumeMount: true });
      return this;
    }
    await this._mountFrame(target);
    return this;
  }
  async _mountFrame(target = this._mountTarget) {
    const swUrl = this.options.serviceWorkerUrl || '/wurster-sw.js', swScope = this.options.serviceWorkerScope || '/';
    await navigator.serviceWorker.register(swUrl, { scope: swScope });
    await navigator.serviceWorker.ready;
    const controller = await waitForServiceWorkerControl(navigator.serviceWorker, { timeoutMs: this.options.serviceWorkerControlTimeoutMs || 5000 });
    addEventListener('message', this._boundMessage); navigator.serviceWorker.addEventListener('message', this._boundSw);
    await registerServiceWorkerSession(controller, this.id, { timeoutMs: this.options.serviceWorkerRegistrationTimeoutMs || 3000 });
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-downloads allow-top-navigation-by-user-activation');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.cssText = this.options.frameStyle || 'width:100%;height:100%;border:0;display:block;background:transparent';
    const entry = await this._entryPath();
    const loaded = new Promise((resolve, reject) => {
      frame.addEventListener('load', resolve, { once: true });
      frame.addEventListener('error', () => reject(new Error('Wurst application frame failed to load')), { once: true });
    });
    frame.src = `${this._virtualBase()}/app/${entry.split('/').map(encodeURIComponent).join('/')}`;
    target.replaceChildren(frame);
    this.frame = frame;
    await loaded;
  }
  async mountMachine() { return mountWebMachineSession(this); }

  async _presentApplicationUnlock({ resumeMount = false } = {}) {
    if (this.applicationUnlocked()) { if (resumeMount && !this.frame) await this._mountFrame(); return true; }
    if (!this._mountTarget) throw new Error('Wurster Web has no mount surface for authentication');
    if (this._authOverlay) return this._authOverlay.promise;
    const target = this._mountTarget;
    if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;z-index:2147483000;display:grid;place-items:center;padding:20px;background:linear-gradient(145deg,#fff8f6f7,#f6e5e9f5);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#342d30;box-sizing:border-box;';
    overlay.innerHTML = `<form style="width:min(430px,100%);padding:24px;border:1px solid rgba(116,76,92,.18);border-radius:24px;background:#fffdfc;box-shadow:0 24px 70px rgba(75,45,58,.18)"><div style="font-size:30px">🔐🐷</div><div style="font-size:11px;font-weight:900;letter-spacing:.12em;color:#a65f75;margin-top:10px">PROTECTED WURST</div><h2 style="font-size:22px;margin:5px 0 8px">This Wurst wants its WurstKey.</h2><p style="font-size:13px;line-height:1.5;color:#75646b;margin:0 0 16px">The key is handled by Wurster Web, outside the Wurst application DOM.</p><input name="wurstkey" autocomplete="off" spellcheck="false" placeholder="wurstkey-v1-…" style="width:100%;padding:12px 13px;border:1px solid #dbc8ce;border-radius:12px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;box-sizing:border-box"><div data-error style="min-height:18px;margin:8px 2px;color:#b23850;font-size:11px"></div><button style="width:100%;border:0;border-radius:12px;padding:11px 14px;background:#3c3035;color:#fff;font-weight:800;cursor:pointer">Verify key & open Wurst</button><button type="button" data-cancel style="width:100%;border:0;background:transparent;color:#806c74;padding:9px;cursor:pointer">Not now</button><div style="font-size:10px;color:#9b858e;margin-top:4px;text-align:center">A good Wurst keeps its secret meat encrypted until the key actually fits.</div></form>`;
    if (!resumeMount) target.append(overlay); else target.replaceChildren(overlay);
    let resolvePromise, rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    this._authOverlay = { element: overlay, promise, reject: rejectPromise };
    const form = overlay.querySelector('form'), input = overlay.querySelector('input'), error = overlay.querySelector('[data-error]'), button = overlay.querySelector('button:not([data-cancel])'), cancel = overlay.querySelector('[data-cancel]');
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); error.textContent = ''; button.disabled = true; button.textContent = 'Checking the sausage…';
      try {
        await this.unlockApplication(input.value);
        overlay.remove(); this._authOverlay = null;
        if (resumeMount && !this.frame) await this._mountFrame(target);
        resolvePromise(true);
      } catch (e) {
        error.textContent = e?.message || String(e); button.disabled = false; button.textContent = 'Verify key & open Wurst'; input.select();
      }
    });
    cancel.addEventListener('click', () => {
      const canceled = lockedApplicationError('WurstKey entry canceled');
      overlay.remove(); this._authOverlay = null; rejectPromise(canceled);
    });
    queueMicrotask(() => input.focus());
    return promise;
  }
  async close() {
    globalThis.removeEventListener?.('message', this._boundMessage);
    globalThis.navigator?.serviceWorker?.removeEventListener('message', this._boundSw);
    this._authOverlay?.reject?.(new Error('Wurster Web session closed'));
    this._authOverlay?.element?.remove(); this._authOverlay = null;
    this.frame?.remove(); this.frame = null;
    for (const pending of this._pigLinkPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Wurst closed before PigLink action completed')); }
    this._pigLinkPending.clear(); this._pigLinkListeners.clear();
    this.reader.source?.close?.();
    await this.fs.dispose().catch(() => {});
  }
  async _onSwMessage(event) {
    const m = event.data, port = event.ports?.[0]; if (m?.sessionId !== this.id || !port) return;
    if (m.type === 'wurster-sw-session-probe') { port.postMessage({ owns: true }); return; }
    if (m.type !== 'wurster-sw-fetch') return;
    try {
      let result;
      try { result = await this._serve(m); }
      catch (error) {
        if (error?.code !== 'WURST_APP_LOCKED' || !this._mountTarget) throw error;
        await this._presentApplicationUnlock();
        result = await this._serve(m);
      }
      port.postMessage({ ok: true, ...result }, result.body ? [result.body] : []);
    } catch (error) {
      port.postMessage({ ok: false, status: error?.code === 'WURST_APP_LOCKED' ? 423 : 500, error: error.message, code: error?.code || null });
    }
  }
  async _serve({ scope, path, method = 'GET', range }) {
    let data, mime, total; const head = String(method).toUpperCase() === 'HEAD';
    if (scope === 'machine') {
      const html = injectBootstrap('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>', this);
      const body = te.encode(html);
      return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.byteLength), 'Cache-Control': 'no-store' }, body: head ? null : body.buffer };
    }
    if (scope === 'app' || scope === 'piglink' || scope === 'piglet') {
      let resource;
      if (scope === 'piglink') {
        const piglinkPath = this.reader.manifest?.piglink?.entry || '';
        const entry = piglinkPath ? this.reader.entry(piglinkPath) : null;
        resource = entry ? { entry, mime: entry.mime || mimeFor(piglinkPath), logicalPath: piglinkPath } : null;
      } else if (scope === 'piglet') {
        const child = this.piglets().find((item) => item.id === String(path || '').replace(/\.wurst$/i, ''));
        const entry = child ? this.reader.entry(child.entry) : null;
        resource = entry ? { entry, mime: entry.mime || 'application/vnd.wrst.wurst', logicalPath: child.entry } : null;
      } else resource = await this._applicationResource(path);
      if (!resource) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: head ? null : te.encode('Not found').buffer };
      const entry = resource.entry; total = entry.encryption?.plainLength ?? entry.length;
      const r = range ? parseRange(range, total) : null;
      if (range && !r) return { status: 416, headers: { 'Content-Range': `bytes */${total}` }, body: null };
      mime = resource.mime || entry.mime || mimeFor(resource.logicalPath);
      if (head) return { status: r ? 206 : 200, headers: { 'Content-Type': mime, 'Content-Length': String(r?.length ?? total), 'Accept-Ranges': 'bytes', ...(r ? { 'Content-Range': `bytes ${r.offset}-${r.end}/${total}` } : {}) }, body: null };
      data = await this._readImmutable(entry, r?.offset || 0, r?.length ?? total);
      if (mime.startsWith('text/html')) data = te.encode(injectBootstrap(td.decode(data), this));
      return { status: r ? 206 : 200, headers: { 'Content-Type': mime, 'Content-Length': String(data.byteLength), 'Accept-Ranges': 'bytes', ...(r ? { 'Content-Range': `bytes ${r.offset}-${r.end}/${total}` } : {}) }, body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    }
    if (scope === 'pigfs') {
      const stat = await this.fs.stat(path);
      if (!stat || stat.type !== 'file') return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: head ? null : te.encode('Not found').buffer };
      total = stat.size; const r = range ? parseRange(range, total) : null;
      if (range && !r) return { status: 416, headers: { 'Content-Range': `bytes */${total}` }, body: null };
      mime = stat.mime || mimeFor(path);
      if (head) return { status: r ? 206 : 200, headers: { 'Content-Type': mime, 'Content-Length': String(r?.length ?? total), 'Accept-Ranges': 'bytes', ...(r ? { 'Content-Range': `bytes ${r.offset}-${r.end}/${total}` } : {}) }, body: null };
      data = await this.fs.read(path, { offset: r?.offset || 0, length: r?.length ?? null });
      return { status: r ? 206 : 200, headers: { 'Content-Type': mime, 'Content-Length': String(data.byteLength), 'Accept-Ranges': 'bytes', ...(r ? { 'Content-Range': `bytes ${r.offset}-${r.end}/${total}` } : {}) }, body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    }
    return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: head ? null : te.encode('Not found').buffer };
  }
  async _onFrameMessage(event) {
    const m = event.data; if (m?.sessionId !== this.id || event.source !== this.frame?.contentWindow) return;
    if (m?.__wursterPigLinkResult) {
      const pending = this._pigLinkPending.get(String(m.id || '')); if (!pending) return;
      this._pigLinkPending.delete(String(m.id || '')); clearTimeout(pending.timer);
      if(!m.ok){pending.reject(new Error(m.error || `Wurst action failed: ${pending.name}`));return;}
      try{const result=structuredClone(m.result??null);if(pending.spec?.output)validateJsonValue(result,pending.spec.output,'$output');pending.resolve(result);}catch(error){pending.reject(error);}
      return;
    }
    if (m?.__wursterEvent) {
      const name = String(m.name || ''), spec = this.reader.manifest?.piglink?.events?.[name];
      if (!spec) return;
      const payload = structuredClone(m.payload ?? null);
      try{if(spec.payload)validateJsonValue(payload,spec.payload,'$event');}catch{return;}
      for (const listener of [...this._pigLinkListeners]) { try { listener(name, payload); } catch {} }
      this.frame?.contentWindow?.postMessage({ __wursterPigLinkEventAccepted: 1, sessionId: this.id, name, payload }, '*');
      return;
    }
    if (!m?.__wurster) return;
    try { const result = await this._invoke(m.method, m.args || []); event.source.postMessage({ __wursterReply: 1, sessionId: this.id, id: m.id, ok: true, result }, '*'); }
    catch (error) { event.source.postMessage({ __wursterReply: 1, sessionId: this.id, id: m.id, ok: false, error: error.message }, '*'); }
  }
  deliverParentPigLinkEvent(rawName, payload = null) {
    if (!this.options.parent?.piglink) return false;
    const name = String(rawName ?? '');
    if (!name || !this.frame?.contentWindow) return false;
    this.frame.contentWindow.postMessage({ __wursterParentPigLinkEvent: 1, sessionId: this.id, name, payload: structuredClone(payload ?? null) }, '*');
    return true;
  }
  describePigLink() { return structuredClone(this.reader.manifest?.piglink ?? null); }
  onPigLinkEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('PigLink event listener must be a function');
    this._pigLinkListeners.add(listener); return () => this._pigLinkListeners.delete(listener);
  }
  async invokePigLink(rawName, input = {}) {
    const name = String(rawName ?? ''), spec = this.reader.manifest?.piglink?.actions?.[name];
    if (!spec) throw new Error(`Unknown Wurst action: ${name}`);
    validateJsonValue(input,spec.input,'$input');
    if (!this.frame?.contentWindow) throw new Error('Wurst renderer is not available');
    const id = `web-pl-${this._pigLinkSeq++}`, timeoutMs = Math.min(Number(spec.timeoutMs ?? 5000), 60000);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pigLinkPending.delete(id); reject(new Error(`Wurst action exceeded ${timeoutMs} ms: ${name}`)); }, timeoutMs);
      this._pigLinkPending.set(id, { name, spec, resolve, reject, timer });
      this.frame.contentWindow.postMessage({ __wursterPigLinkInvoke: 1, sessionId: this.id, id, name, input: structuredClone(input ?? {}) }, '*');
    });
  }
  async _invoke(method, args) {
    if(String(method).startsWith('parent.')){const childMethod=String(method).slice(7);if(typeof this.options.parentInvoke!=='function')throw new Error('Parent runtime services are unavailable');assertPigletParentMethod(this.options.parent,childMethod);return this.options.parentInvoke(childMethod,args);}
    switch (method) {
      case 'info': return { manifest: this.reader.manifest, source: this.reader.source.kind, format: 'wurst/7', webRuntime: WURSTER_WEB_VERSION, signature: this.signature };
      case 'auth.status': {
        const purpose = String(args[0] || 'identity').toLowerCase();
        if (purpose === 'application') { const required = this.applicationNeedsKey(); return { state: required ? (this.applicationUnlocked() ? 'unlocked' : 'locked') : 'not-required', purpose: 'application', protection: required ? 'wurstkey' : 'public', runtime: 'web', session: null }; }
        return { state: 'unavailable', purpose, protection: 'identity', runtime: 'web', session: null, reason: 'desktop-handoff-required' };
      }
      case 'auth.present': { const request = args[0] || {}; if (String(request.purpose || 'application') !== 'application') throw new Error('Browser-local auth presentation currently supports WurstKey application unlock only'); return this._presentApplicationUnlock(); }
      case 'capabilities.query': return this._cap(args[0]);
      case 'capabilities.list': return Object.keys(normalizeCapabilityDeclaration(this.reader.manifest.capabilities)).map((name) => this._cap(name));
      case 'pigfs.capabilities': return this.fs.capabilities(); case 'pigfs.realms': return this.fs.realms(); case 'pigfs.usage': return this.fs.usage(); case 'pigfs.compact': return { compacted: false, reason: 'ephemeral web overlay has no physical garbage' };
      case 'pigfs.stat': return this.fs.stat(args[0]); case 'pigfs.list': return this.fs.list(args[0]); case 'pigfs.read': return this.fs.read(args[0], args[1]); case 'pigfs.write': { const result = await this.fs.write(args[0], args[1], args[2] || {}); await this._persistPigFs(); return result; }
      case 'pigfs.beginWrite': return this.fs.beginWrite(args[0], args[1] || {}); case 'pigfs.writeChunk': return this.fs.writeChunk(args[0], args[1]); case 'pigfs.commitWrite': { const result = await this.fs.commitWrite(args[0]); await this._persistPigFs(); return result; } case 'pigfs.abortWrite': return this.fs.abortWrite(args[0]);
      case 'pigfs.remove': { const result = await this.fs.remove(args[0], args[1] || {}); await this._persistPigFs(); return result; } case 'pigfs.mkdir': { const result = await this.fs.mkdir(args[0], args[1] || {}); await this._persistPigFs(); return result; } case 'pigfs.rename': { const result = await this.fs.rename(args[0], args[1]); await this._persistPigFs(); return result; }
      case 'snapshot.export': { const blob = await this.fs.snapshotBlob(); this.downloadSnapshot(blob); return { ok: true, size: blob.size }; }
      case 'piglink.describe': return this.reader.manifest.piglink || null;
      case 'piglet.children': return this.pigletDescriptors();
      case 'piglet.running': return this._runningPiglets();
      case 'piglet.machineConnect': return this._openEmbedSource(args[0],{...(args[1]||{}),kind:'machine'});
      case 'piglet.machineDescribe': return this._describeMachine(args[0]);
      case 'piglet.machineInvoke': return this._invokeMachine(args[0],args[1],args[2]||{},args[3]||{});
      case 'piglet.machineClose': return this._closeEmbedSource(args[0]);
      case 'piglet.inspect': return this.inspectPiglet(args[0]);
      case 'piglet.install': return this.installPiglet(args[0],args[1],args[2]||{});
      case 'piglet.remove': return this.removePiglet(args[0]);
      case 'piglet.embedOpen': return this._openEmbedSource(args[0],args[1]||{});
      case 'piglet.embedRead': return this._readEmbedSource(args[0],args[1],args[2]);
      case 'piglet.embedPersist': return this._persistEmbedSource(args[0],args[1]);
      case 'piglet.embedRefresh': return this._refreshEmbedSource(args[0]);
      case 'piglet.embedInvoke': return this._invokeEmbedParent(args[0],args[1],args[2]||[]);
      case 'piglet.embedClose': return this._closeEmbedSource(args[0]);
      case 'pigsty.status': return this.pigstyStatus();
      case 'pigsty.run': throw new Error('Pigsty execution is unavailable in Wurster Web');
      case 'pigsty.build': throw new Error('Pigsty execution is unavailable in Wurster Web');
      case 'window.close': this.frame?.remove(); return true; case 'window.minimize': return false;
      default: throw new Error(`Unsupported Wurster Web bridge method: ${method}`);
    }
  }
  async _openEmbedSource(rawRef,options={}) {
    const ref=String(rawRef??'').trim();if(!ref)throw new Error('Embedded Wurst source is required');const relationship=normalizePigletRelationship(options?.parent||{}, {parentPigLink:Boolean(this.reader.manifest?.piglink),parentPigFs:this.reader.manifest?.pigfs?(this.reader.manifest.pigfs.writable===true?'read-write':'read'):null,parentPiglets:this.reader.manifest?.pigfs?.writable===true?'manage':'read'}),parent={...relationship,application:{id:this.reader.manifest?.id??null,name:this.reader.manifest?.name??null,version:this.reader.manifest?.version??null}};
    let source=null,path=null,writable=false,locator=ref;
    if(ref.startsWith('pigfs:')){path=ref.slice(6)||'/';const stat=await this.fs.stat(path);if(!stat||stat.type!=='file')throw new Error(`Embedded PigFS Wurst not found: ${path}`);source={size:stat.size,read:async(offset,length)=>this.fs.read(path,{offset,length})};writable=Boolean(this.reader.manifest?.pigfs?.writable);locator=stat.objectId?`pigfs://object/${stat.objectId}`:`pigfs:${path}`;}
    else if(ref.startsWith('builtin:')){const {entry}=this.pigletEntry(ref.slice(8));source={size:entry.encryption?.plainLength??entry.length,read:(offset,length)=>this._readImmutable(entry,offset,length)};locator=`builtin:${ref.slice(8)}`;}
    else {const href=new URL(ref,location.origin).toString(),appBase=`${this._virtualBase()}/app/`,pigletBase=`${this._virtualBase()}/piglet/`,pigfsBase=`${this._virtualBase()}/pigfs/`;if(href.startsWith(pigletBase)){const id=decodeURIComponent(new URL(href).pathname.split('/').at(-1)).replace(/\.wurst$/i,'');const {entry}=this.pigletEntry(id);source={size:entry.encryption?.plainLength??entry.length,read:(offset,length)=>this._readImmutable(entry,offset,length)};locator=`builtin:${id}`;}else if(href.startsWith(pigfsBase)){path='/'+new URL(href).pathname.split('/pigfs/')[1].split('/').map(decodeURIComponent).join('/');const stat=await this.fs.stat(path);if(!stat||stat.type!=='file')throw new Error(`Embedded PigFS Wurst not found: ${path}`);source={size:stat.size,read:async(offset,length)=>this.fs.read(path,{offset,length})};writable=Boolean(this.reader.manifest?.pigfs?.writable);locator=stat.objectId?`pigfs://object/${stat.objectId}`:`pigfs:${path}`;}else if(href.startsWith(appBase)){const logical=new URL(href).pathname.split('/app/')[1].split('/').map(decodeURIComponent).join('/');const resource=await this._applicationResource(logical);if(!resource)throw new Error(`Embedded Wurst resource is unavailable: ${logical}`);const entry=resource.entry;source={size:entry.encryption?.plainLength??entry.length,read:(offset,length)=>this._readImmutable(entry,offset,length)};locator=`resource:${logical}`;}else return null;}
    const childReader=await WurstWebReader.open(source),composition=analyzePigletAuthorityComposition(parent,childReader.manifest),descriptor={application:{id:childReader.manifest?.id??null,name:childReader.manifest?.name??null,version:childReader.manifest?.version??null},capabilities:structuredClone(childReader.manifest?.capabilities||{}),piglink:childReader.manifest?.piglink?{headless:childReader.manifest.piglink.headless===true,actions:Object.keys(childReader.manifest.piglink.actions||{}),events:Object.keys(childReader.manifest.piglink.events||{})}:null};
    if(options?.kind==='machine'&&!descriptor.piglink?.headless)throw new Error('This Wurst does not declare a headless PigLink end');
    const attached=this._embedSessions.attach(this.id,locator,{kind:options?.kind==='machine'?'machine':'view',relationship:parent,metadata:{...descriptor.application,ref,locator,path,size:source.size}});let world=this._embedWorlds.get(attached.session.id);if(attached.created){world={source,path,writable,parent,composition,descriptor,locator};this._embedWorlds.set(attached.session.id,world);}else if(path&&world){world.path=path;world.source=source;}const handle=attached.attachment.id;this._embedSources.set(handle,{sessionId:attached.session.id});return {handle,size:world.source.size,writable:world.writable,parent:world.parent,composition:world.composition,session:this._embedSessions.describeByAttachment(handle),descriptor:world.descriptor};
  }
  _requireEmbedSource(rawHandle){const handle=String(rawHandle??''),item=this._embedSources.get(handle);if(!item)throw new Error('Unknown Wurst embed handle');const attachment=this._embedSessions.requireAttachment(handle),world=this._embedWorlds.get(attachment.session.id);if(!world)throw new Error('Unknown Wurst embed session');return {handle,attachment,world};}
  async _readEmbedSource(handle,offset,length){const {world}=this._requireEmbedSource(handle),start=Number(offset),size=Number(length);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(size)||start<0||size<0||start+size>world.source.size)throw new Error('Invalid Wurst embed byte range');return world.source.read(start,size);}
  async _persistEmbedSource(handle,value){const {world}=this._requireEmbedSource(handle);this._embedSessions.requireFresh(handle);if(!world.path||!world.writable)throw new Error('This embedded Wurst is not writable');const data=value instanceof Uint8Array?value:new Uint8Array(value),result=await this.fs.write(world.path,data,{mime:'application/vnd.wrst.wurst'});await this._persistPigFs();const stat=await this.fs.stat(world.path);world.source={size:stat.size,read:async(offset,length)=>this.fs.read(world.path,{offset,length})};const session=this._embedSessions.bump(handle,{metadata:{...world.descriptor.application,ref:`pigfs:${world.path}`,locator:world.locator,path:world.path,size:stat.size}});this.frame?.contentWindow?.postMessage({__wursterPigletSessionChanged:1,sessionId:this.id,writer:String(handle),session,size:stat.size},'*');return {ok:true,path:world.path,size:data.byteLength,result,revision:session.revision,session};}
  async _invokeEmbedParent(handle,method,args=[]){const {world}=this._requireEmbedSource(handle),name=String(method??'');assertPigletParentMethod(world.parent,name);const safeArgs=Array.isArray(args)?args:[];if(name==='piglink.describe')return this.describePigLink();if(name==='piglink.invoke')return this.invokePigLink(safeArgs[0],safeArgs[1]??{});return this._invoke(name,safeArgs);}
  async _describeMachine(handle){const {attachment,world}=this._requireEmbedSource(handle);if(attachment.kind!=='machine')throw new Error('Wurst session attachment is not a machine client');const reader=await WurstWebReader.open(world.source);try{return {info:{id:reader.manifest?.id??null,name:reader.manifest?.name??null,version:reader.manifest?.version??null,format:reader.manifest?.format??null},piglink:structuredClone(reader.manifest?.piglink??null)};}finally{await reader.close?.();}}
  async _invokeMachine(handle,name,input={},options={}){const key=String(handle??''),{attachment,world}=this._requireEmbedSource(key);if(attachment.kind!=='machine')throw new Error('Wurst session attachment is not a machine client');this._embedSessions.refresh(key);const machine=await WursterWebSession.open(world.source,{sessionId:`machine-${crypto.randomUUID?.()||Math.random().toString(36).slice(2)}`,serviceWorkerUrl:this.options.serviceWorkerUrl||'/wurster-sw.js',serviceWorkerScope:this.options.serviceWorkerScope||'/',parent:world.parent,externalSession:this._embedSessions.describeByAttachment(key),persistSnapshot:world.writable?async(blob)=>this._persistEmbedSource(key,new Uint8Array(await blob.arrayBuffer())):null,parentInvoke:world.parent?async(method,args=[])=>this._invokeEmbedParent(key,method,args):null});const events=[];const stop=machine.onPigLinkEvent((eventName,payload)=>events.push({name:eventName,payload:structuredClone(payload??null)}));try{await machine.mountMachine();const result=await machine.invokePigLink(String(name??''),input??{}),session=this._embedSessions.describeByAttachment(key);for(const event of events)this.frame?.contentWindow?.postMessage({__wursterPigletMachineEvent:1,sessionId:this.id,childSessionId:session.id,name:event.name,payload:event.payload},'*');return {result,events,session};}finally{stop();await machine.close();}}
  _refreshEmbedSource(handle){const {world}=this._requireEmbedSource(handle),refreshed=this._embedSessions.refresh(String(handle??''));return {size:world.source.size,session:refreshed.session};}
  _runningPiglets(){return this._embedSessions.list(this.id);}
  _closeEmbedSource(handle){const key=String(handle??'');this._requireEmbedSource(key);this._embedSources.delete(key);const released=this._embedSessions.release(key);if(released.closed)this._embedWorlds.delete(released.session.id);return true;}
  async _inspectPigletSource(source,metadata={}) {
    const reader=await WurstWebReader.open(source),signature=await reader.verifySignature();
    return {...metadata,bytes:source.size,application:{id:reader.manifest?.id??null,name:reader.manifest?.name??null,version:reader.manifest?.version??null},data:{format:reader.manifest?.pigfs?.format??null,writable:reader.manifest?.pigfs?.writable===true},capabilities:structuredClone(reader.manifest?.capabilities||{}),piglink:reader.manifest?.piglink?{format:reader.manifest.piglink.format??null,headless:reader.manifest.piglink.headless===true,actions:Object.keys(reader.manifest.piglink.actions||{}),events:Object.keys(reader.manifest.piglink.events||{})}:null,protection:{application:reader.manifest?.application?.protection??'public',sealed:reader.manifest?.application?.protection==='sealed'||[...reader.entries.values()].some((entry)=>Boolean(entry.encryption))},signature:{status:signature.status,publisher:signature.publisher??null,error:signature.error??null}};
  }
  async _pigFsWurstSource(path) {
    const stat=await this.fs.stat(path); if(!stat||stat.type!=='file')throw new Error(`PigFS Wurst not found: ${path}`);
    return {size:stat.size,read:async(offset,length)=>this.fs.read(path,{offset,length})};
  }
  async _discoverPigFsPiglets() {
    const out=[],seen=new Set(),queue=[];
    for(const realm of this.fs.realms()) if(realm?.mount&&!seen.has(realm.mount)){seen.add(realm.mount);queue.push(realm.mount);}
    let visited=0;
    while(queue.length&&visited<2048){const dir=queue.shift();let entries=[];try{entries=await this.fs.list(dir);}catch{continue;}for(const entry of entries){if(++visited>2048)break;const path=String(entry.path||'');if(entry.type==='directory'){if(!seen.has(path)){seen.add(path);queue.push(path);}continue;}if(entry.type!=='file'||!/\.(wurst|wrst)$/i.test(path))continue;try{const source=await this._pigFsWurstSource(path);out.push(await this._inspectPigletSource(source,{ref:`pigfs:${path}`,id:path,label:null,source:'pigfs',path,mutable:true}));}catch{}}
    }
    return out;
  }
  async pigletDescriptors() {
    const builtins=[];
    for(const child of this.piglets()){try{builtins.push(await this.inspectPiglet(`builtin:${child.id}`));}catch{builtins.push({...child,ref:`builtin:${child.id}`,source:'builtin',mutable:false});}}
    return [...builtins,...await this._discoverPigFsPiglets()];
  }
  async inspectPiglet(rawRef) {
    const ref=String(rawRef??'');
    if(ref.startsWith('pigfs:')||ref.startsWith('/')){const path=ref.startsWith('pigfs:')?ref.slice(6):ref,source=await this._pigFsWurstSource(path);return this._inspectPigletSource(source,{ref:`pigfs:${path}`,id:path,label:null,source:'pigfs',path,mutable:true});}
    const id=ref.startsWith('builtin:')?ref.slice(8):ref,{child,entry}=this.pigletEntry(id),source={size:entry.encryption?.plainLength??entry.length,read:(offset,length)=>this._readImmutable(entry,offset,length)};
    return this._inspectPigletSource(source,{...structuredClone(child),ref:`builtin:${child.id}`,source:'builtin',mutable:false});
  }
  async installPiglet(rawName,value,options={}) {
    if(!this.reader.manifest?.pigfs?.writable)throw new Error('This Wurst PigFS is not writable');
    const data=value instanceof Uint8Array?value:value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):null;
    if(!data?.byteLength)throw new TypeError('wurst.piglet.install expects Wurst bytes');
    if(data.byteLength>512*1024*1024)throw new Error('Piglet installation exceeds the 512 MiB runtime import limit');
    const probe=await WurstWebReader.open(data),signature=await probe.verifySignature();
    if(signature.status==='invalid')throw new Error(`Piglet signature is invalid: ${signature.error||'verification failed'}`);
    const clean=String(rawName||'Piglet.wurst').replaceAll('\\','/').split('/').at(-1).replace(/[^A-Za-z0-9._ -]/g,'_');
    if(!/\.(wurst|wrst)$/i.test(clean))throw new Error('Piglet filename must end in .wurst or .wrst');
    let path=String(options.path||'').trim();
    if(!path){
      const realms=this.fs.realms();
      const realm=realms.find((item)=>item?.mount&&item.protection==='public'&&(!item.governance||item.governance==='ordinary'))||realms.find((item)=>item?.mount&&item.protection==='public');
      if(!realm)throw new Error('No writable public PigFS realm is available for Piglet installation');
      const dir=`${String(realm.mount).replace(/\/$/,'')}/piglets`;
      await this.fs.mkdir(dir,{recursive:true});
      path=`${dir}/${clean}`;
    }
    if(!path.startsWith('/'))path=`/${path}`;
    await this.fs.write(path,data,{mime:'application/vnd.wrst.wurst'});
    await this._persistPigFs();
    return this.inspectPiglet(`pigfs:${path}`);
  }
  async removePiglet(rawRef) {
    const ref=String(rawRef??'');if(!ref.startsWith('pigfs:')&&!ref.startsWith('/'))throw new Error('Built-in Piglets are immutable package content and cannot be removed at runtime');const path=ref.startsWith('pigfs:')?ref.slice(6):ref;const removed=await this.fs.remove(path);await this._persistPigFs();return removed;
  }
  piglets() {
    return structuredClone(this.reader.manifest?.piglet?.children ?? []);
  }
  pigletEntry(id) {
    const key = String(id ?? '');
    const child = this.piglets().find((item) => item.id === key);
    if (!child) throw new Error(`Unknown Piglet child: ${key}`);
    const entry = this.reader.entry(child.entry);
    if (!entry || entry.scope !== 'piglet' || entry.encryption) throw new Error(`Piglet child is unavailable: ${key}`);
    return { child, entry };
  }
  pigstyStatus() {
    const declared = this.reader.manifest?.pigsty ?? null;
    return {
      declared: Boolean(declared),
      policy: structuredClone(declared),
      state: declared ? 'unavailable' : 'undeclared',
      runtime: 'web',
      builds: declared ? Object.keys(declared.builds ?? {}).sort() : [],
      reason: declared ? 'pigsty-node-runtime-unavailable-in-web' : 'not-declared'
    };
  }
  _cap(name) {
    const declared = normalizeCapabilityDeclaration(this.reader.manifest.capabilities), value = declared?.[name];
    const requested = value !== false && value != null;
    const supported = new Set(['storage.local', 'network']);
    return { name, state: !requested ? 'undeclared' : supported.has(name) ? 'available' : 'unsupported', declared: value ?? null, reason: !requested ? 'not-declared' : supported.has(name) ? null : 'web-runtime' };
  }
  async _persistPigFs() {
    if (typeof this.options.persistSnapshot !== 'function') return null;
    const blob = await this.fs.snapshotBlob();
    return this.options.persistSnapshot(blob);
  }
  downloadSnapshot(blob, name = null) { if (typeof document === 'undefined') return; const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name || `${this.reader.manifest?.name || 'snapshot'}.wurst`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

export const WursterWeb = Object.freeze({
  version: WURSTER_WEB_VERSION,
  open: (input, options = {}) => WursterWebSession.open(input, options),
  inspect: async (input) => { const reader = await WurstWebReader.open(input); return { manifest: reader.manifest, signature: await reader.verifySignature(), source: reader.source.kind, baseLength: reader.baseLength, size: reader.source.size }; }
});

if (typeof window !== 'undefined') window.WursterWeb = WursterWeb;
