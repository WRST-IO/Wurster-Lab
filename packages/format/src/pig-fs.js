import crypto from 'node:crypto';
import {
  PIG_FS_DEFAULT_CHUNK_SIZE,
  PIG_FS_MAP_TARGET,
  PIG_FS_CATALOG_TARGET,
  PIG_FS_MAX_RECORD_PAYLOAD,
  PIG_FS_RECORD,
  locateLatestFsCommit,
  makeFsRecord,
  readFsRecord
} from './pig-fs-records.js';
import {
  WURSTER_IDENTITY_FORMAT,
  deriveWursterIdentityMaterial,
  signWursterIdentityPayload,
  unwrapKeyForWursterIdentity,
  verifyWursterIdentityPayload,
  verifyWursterIdentityRecord,
  wrapKeyForWursterIdentity
} from './wurst-identity.js';

export const PIG_FS_FORMAT = 'wurst/pigfs-1';
export const PIG_FS_CATALOG_FORMAT = 'wurst/pigfs-catalog-1';
export const PIG_FS_MAP_FORMAT = 'wurst/pigfs-map-1';
export const PIG_FS_MUTATION_FORMAT = 'wurst/pigfs-mutation-1';
export const PIG_FS_COMMIT_CONTEXT = 'wurst/pigfs-commit-1';
export const PIG_FS_REALM_KEY_FORMAT = 'wurst/pigfs-realm-key-1';
export const PIG_FS_HISTORY_NONE = 'none';
export const PIG_FS_HISTORY_INTEGRITY = 'integrity';
export const PIG_FS_REALM_GOVERNANCE = Object.freeze(['personal', 'shared']);
export const PIG_FS_AUDIT_MODES = Object.freeze(['none', 'signed']);
export const PIG_FS_ORDINARY = 'ordinary';

const REALM_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function pigFsRealmGovernance(realm = {}) {
  const explicit = realm?.governance == null ? '' : String(realm.governance).trim().toLowerCase();
  if (!explicit) return PIG_FS_ORDINARY;
  if (!PIG_FS_REALM_GOVERNANCE.includes(explicit)) throw new Error(`Unsupported PigFS realm governance: ${realm.governance}`);
  return explicit;
}

function normalizeRealmAudit(raw, governance) {
  const audit = String(raw ?? 'none').trim().toLowerCase();
  if (!PIG_FS_AUDIT_MODES.includes(audit)) throw new Error(`Unsupported PigFS realm audit mode: ${raw}`);
  if (governance !== 'shared' && audit !== 'none') throw new Error(`PigFS ${governance} governance does not carry signed audit history`);
  return audit;
}

function rootHistoryMode(root) {
  const explicit = root?.historyMode == null ? null : String(root.historyMode);
  if (explicit) {
    if (![PIG_FS_HISTORY_NONE, PIG_FS_HISTORY_INTEGRITY].includes(explicit)) throw new Error(`Unsupported PigFS history mode: ${explicit}`);
    return explicit;
  }
  throw new Error('PigFS root is missing historyMode');
}

function rootNeedsIntegrityChain(root) {
  return Object.values(root?.realms ?? {}).some((realm) => pigFsRealmGovernance(realm) === 'shared');
}

function realmKeepsAudit(realm) {
  return pigFsRealmGovernance(realm) === 'shared' && (realm?.audit ?? 'none') === 'signed';
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function assertSafeOffset(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid ${label}`);
  return number;
}

export function normalizePigFsRealmId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  if (!REALM_ID_RE.test(id)) throw new Error(`Invalid PigFS realm id: ${value}`);
  return id;
}

export function normalizePigFsRealmPath(value, { allowRoot = true } = {}) {
  let normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) {
    if (allowRoot) return '';
    throw new Error('PigFS realm path cannot be empty');
  }
  if (normalized.includes('\0')) throw new Error('PigFS realm path contains NUL');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe PigFS realm path: ${value}`);
  return parts.join('/');
}

export function normalizePigFsPath(value, { allowRoot = true } = {}) {
  const raw = String(value ?? '').replaceAll('\\', '/');
  if (raw.includes('\0')) throw new Error('PigFS path contains NUL');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error(`Unsafe PigFS path: ${value}`);
  const normalized = `/${parts.join('/')}`;
  if (normalized === '/' && !allowRoot) throw new Error('PigFS path cannot be root');
  return normalized;
}

export function normalizePigFsMount(value, realmId = '') {
  const fallback = `/${normalizePigFsRealmId(realmId)}`;
  const mount = normalizePigFsPath(value == null || value === '' ? fallback : value);
  if (mount === '/') throw new Error('PigFS realm mount cannot be filesystem root');
  return mount;
}

export function resolvePigFsPath(root, value, { allowRealmRoot = true } = {}) {
  const path = normalizePigFsPath(value);
  if (path === '/') return { root: true, realmId: null, realm: null, path: '' };
  const realms = Object.values(root?.realms ?? {});
  const matches = realms
    .map((realm) => ({ realm, mount: normalizePigFsMount(realm.mount, realm.id) }))
    .filter(({ mount }) => path === mount || path.startsWith(`${mount}/`))
    .sort((a, b) => b.mount.length - a.mount.length);
  if (!matches.length) {
    const error = new Error(`PigFS path is outside declared realm mounts: ${path}`);
    error.code = 'PIG_FS_OUTSIDE_MOUNTS';
    throw error;
  }
  const { realm, mount } = matches[0];
  const relative = path === mount ? '' : normalizePigFsRealmPath(path.slice(mount.length + 1), { allowRoot: allowRealmRoot });
  if (!relative && !allowRealmRoot) throw new Error('PigFS operation requires a path inside a realm');
  return { root: false, realmId: realm.id, realm, mount, path: relative };
}

export function pigFsRealmPublicPath(realmOrId, realmPath = '', root = null) {
  const id = typeof realmOrId === 'object' ? normalizePigFsRealmId(realmOrId.id) : normalizePigFsRealmId(realmOrId);
  const realm = typeof realmOrId === 'object' ? realmOrId : root?.realms?.[id] ?? { id, mount: `/${id}` };
  const mount = normalizePigFsMount(realm.mount, id);
  const path = normalizePigFsRealmPath(realmPath, { allowRoot: true });
  return `${mount}${path ? `/${path}` : ''}`;
}

function normalizeIdentityIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value ?? '').trim()).filter(Boolean))].sort();
}

export function normalizePigFsRealmAccess(raw = {}, protection = 'public') {
  const access = plainObject(raw) ? raw : {};
  const readRaw = plainObject(access.read) ? access.read : {};
  const writeRaw = plainObject(access.write) ? access.write : {};
  const readMode = String(readRaw.mode ?? (protection === 'sealed' ? 'members' : 'public'));
  const writeMode = String(writeRaw.mode ?? 'members');
  if (!['public', 'members'].includes(readMode)) throw new Error('PigFS realm read mode must be public or members');
  if (!['members', 'authenticated', 'open'].includes(writeMode)) throw new Error('PigFS realm write mode must be members, authenticated or open');
  if (protection === 'sealed' && readMode !== 'members') throw new Error('Sealed PigFS realms cannot be publicly readable');
  if (protection === 'sealed' && writeMode !== 'members') throw new Error('Sealed PigFS realms require explicit member writers');
  const readers = normalizeIdentityIds(readRaw.identities);
  const writers = normalizeIdentityIds(writeRaw.identities);
  const admins = normalizeIdentityIds(access.admins);
  if (protection === 'sealed') {
    const readerSet = new Set(readers);
    for (const id of [...writers, ...admins]) {
      if (!readerSet.has(id)) throw new Error('Writers/admins of a sealed realm must also be readers');
    }
  }
  return {
    read: { mode: readMode, identities: readMode === 'members' ? readers : [] },
    write: { mode: writeMode, identities: writeMode === 'members' ? writers : [] },
    admins
  };
}

function accessContains(accessPart, identityId) {
  return Boolean(identityId) && Array.isArray(accessPart?.identities) && accessPart.identities.includes(identityId);
}

export function pigFsRealmCapabilities(realm, identityId = null, { signedIdentity = Boolean(identityId) } = {}) {
  if (!realm) return { read: false, write: false, admin: false };
  const id = identityId ? String(identityId) : null;
  const admin = Boolean(id && realm.access?.admins?.includes(id));
  const read = realm.protection === 'public'
    ? realm.access?.read?.mode === 'public' || accessContains(realm.access?.read, id) || admin
    : accessContains(realm.access?.read, id) || admin;
  const mode = realm.access?.write?.mode;
  const write = admin
    || mode === 'open'
    || (mode === 'authenticated' && signedIdentity && Boolean(id))
    || (mode === 'members' && accessContains(realm.access?.write, id));
  return { read, write, admin };
}

function validateIdentityRegistry(identities) {
  if (!plainObject(identities)) throw new Error('PigFS identity registry must be an object');
  for (const [id, record] of Object.entries(identities)) {
    if (record?.format !== WURSTER_IDENTITY_FORMAT || record.identityId !== id) throw new Error(`Invalid PigFS Identity record: ${id}`);
    const verified = verifyWursterIdentityRecord(record);
    if (!verified.valid) throw new Error(`Invalid PigFS Identity ${id}: ${verified.error}`);
  }
}

function personalRealmClaimed(realm) {
  if (pigFsRealmGovernance(realm) !== 'personal') return true;
  if (realm?.claimed != null) return Boolean(realm.claimed);
  const readers = realm?.access?.read?.identities ?? [];
  const writers = realm?.access?.write?.identities ?? [];
  const admins = realm?.access?.admins ?? [];
  return readers.length === 1 && writers.length === 1 && admins.length === 1;
}

function validateRealmDescriptor(realm, identities) {
  if (!plainObject(realm)) throw new Error('Invalid PigFS realm descriptor');
  realm.id = normalizePigFsRealmId(realm.id);
  realm.mount = normalizePigFsMount(realm.mount, realm.id);
  if (realm.quotaBytes != null && (!Number.isSafeInteger(Number(realm.quotaBytes)) || Number(realm.quotaBytes) <= 0)) throw new Error(`Invalid PigFS quota for realm ${realm.id}`);
  realm.quotaBytes = realm.quotaBytes == null ? null : Number(realm.quotaBytes);
  if (!['public', 'sealed'].includes(realm.protection)) throw new Error(`Unsupported protection for realm ${realm.id}`);
  realm.access = normalizePigFsRealmAccess(realm.access, realm.protection);
  const governance = pigFsRealmGovernance(realm);
  realm.audit = normalizeRealmAudit(realm.audit, governance);

  if (governance === PIG_FS_ORDINARY) {
    if (realm.protection !== 'public' || realm.access.read.mode !== 'public' || realm.access.write.mode !== 'open') throw new Error(`Ordinary realm ${realm.id} must be public/read-public/write-open`);
    if (realm.access.admins.length) throw new Error(`Ordinary realm ${realm.id} cannot declare admins`);
  }

  if (governance === 'personal') {
    if (realm.protection !== 'sealed') throw new Error(`Personal realm ${realm.id} must be sealed`);
    const readers = realm.access.read.identities ?? [];
    const writers = realm.access.write.identities ?? [];
    const admins = realm.access.admins ?? [];
    const claimed = personalRealmClaimed(realm);
    if (realm.access.read.mode !== 'members' || realm.access.write.mode !== 'members') throw new Error(`Personal realm ${realm.id} must use member-bound read/write access`);
    if (!claimed) {
      if (readers.length || writers.length || admins.length || realm.keyWraps?.length || realm.catalogPages?.length) throw new Error(`Unclaimed personal realm ${realm.id} must be empty and have no owner material`);
      realm.claimed = false;
    } else {
      if (readers.length !== 1 || writers.length !== 1 || admins.length !== 1 || readers[0] !== writers[0] || readers[0] !== admins[0]) {
        throw new Error(`Personal realm ${realm.id} must be single-owner and non-shareable`);
      }
      realm.claimed = true;
    }
  }

  if (governance === 'shared' && realm.access.write.mode === 'open') throw new Error(`Shared realm ${realm.id} must require an authenticated/member writer`);
  if (!Array.isArray(realm.catalogPages)) throw new Error(`Realm ${realm.id} catalogPages must be an array`);
  if (!Array.isArray(realm.keyWraps)) throw new Error(`Realm ${realm.id} keyWraps must be an array`);
  const principals = new Set([
    ...realm.access.admins,
    ...(realm.access.read?.identities ?? []),
    ...(realm.access.write?.identities ?? [])
  ]);
  for (const id of principals) if (!identities[id]) throw new Error(`Realm ${realm.id} references unknown identity ${id}`);
  if (realm.protection === 'public') {
    if (realm.keyWraps.length) throw new Error(`Public realm ${realm.id} cannot contain encryption key-wraps`);
    if (realm.catalogPages.some((page) => Boolean(page.encryption))) throw new Error(`Public realm ${realm.id} has sealed catalog pages`);
  } else if (governance === 'personal' && !personalRealmClaimed(realm)) {
    if (realm.keyWraps.length || realm.catalogPages.length) throw new Error(`Unclaimed personal realm ${realm.id} cannot contain encrypted records`);
  } else {
    const readers = new Set(realm.access.read.identities);
    const wrapRecipients = new Set();
    for (const wrap of realm.keyWraps) {
      if (wrap?.realmId !== realm.id || !readers.has(wrap?.recipient)) throw new Error(`Realm ${realm.id} has a key-wrap for a non-reader`);
      if (wrapRecipients.has(wrap.recipient)) throw new Error(`Realm ${realm.id} has duplicate key-wrap recipient ${wrap.recipient}`);
      wrapRecipients.add(wrap.recipient);
    }
    for (const reader of readers) if (!wrapRecipients.has(reader)) throw new Error(`Realm ${realm.id} reader ${reader} has no key-wrap`);
    if (realm.catalogPages.some((page) => !page.encryption)) throw new Error(`Sealed realm ${realm.id} has plaintext catalog pages`);
  }
}

function stateForHash(root) {
  return {
    format: PIG_FS_FORMAT,
    historyMode: root.historyMode ?? PIG_FS_HISTORY_INTEGRITY,
    generation: root.generation,
    previousCommitOffset: root.previousCommitOffset ?? null,
    previousCommitHash: root.previousCommitHash ?? null,
    committedAt: root.committedAt,
    rootPolicy: root.rootPolicy,
    identities: root.identities,
    realms: root.realms,
    mutation: root.mutation
  };
}

export function computePigFsStateHash(root) {
  return hashJson(stateForHash(root));
}

export function computePigFsCommitHash(root) {
  return hashJson({ stateHash: root.stateHash, authorization: root.authorization ?? null });
}

function commitProofPayload(root) {
  return {
    format: PIG_FS_FORMAT,
    historyMode: root.historyMode ?? PIG_FS_HISTORY_INTEGRITY,
    generation: root.generation,
    previousCommitHash: root.previousCommitHash ?? null,
    stateHash: root.stateHash
  };
}

function realmPolicyDigest(realm) {
  return hashJson({
    id: realm.id,
    label: realm.label ?? realm.id,
    governance: pigFsRealmGovernance(realm),
    audit: realm.audit ?? 'none',
    protection: realm.protection,
    access: realm.access,
    keyWraps: realm.keyWraps
  });
}

function realmContentDigest(realm) {
  return hashJson({ catalogPages: realm.catalogPages, stats: realm.stats ?? null });
}

function sameJson(a, b) {
  return canonicalStringify(a) === canonicalStringify(b);
}

function publicMutationOperation(operation, realms = {}) {
  const op = clone(operation ?? {});
  const realmId = op.realm ? String(op.realm) : null;
  const realm = realmId ? realms?.[realmId] ?? null : null;
  if (realm?.protection !== 'sealed') return op;
  // The signed commit graph is intentionally public so authorization can be
  // verified without decryption. Do not let that graph become a filename side
  // channel for sealed realms.
  for (const key of ['path', 'from', 'to', 'name']) delete op[key];
  op.sealed = true;
  return op;
}

function rootAdmin(root, actorId) {
  return Boolean(actorId && root?.rootPolicy?.admins?.includes(actorId));
}

function realmAdmin(root, realm, actorId) {
  return rootAdmin(root, actorId) || Boolean(actorId && realm?.access?.admins?.includes(actorId));
}

function realmWriter(realm, actorId, signedIdentity) {
  return pigFsRealmCapabilities(realm, actorId, { signedIdentity }).write;
}

function validateMutationShape(root) {
  const mutation = root.mutation;
  if (!plainObject(mutation) || mutation.format !== PIG_FS_MUTATION_FORMAT) throw new Error('Invalid PigFS mutation record');
  if (mutation.actor !== (root.authorization?.signer ?? null)) throw new Error('PigFS mutation actor does not match commit signer');
  if (!Array.isArray(mutation.changes)) throw new Error('PigFS mutation changes must be an array');
}

function inferRealmChanges(parent, next) {
  const changes = [];
  const ids = new Set([...Object.keys(parent?.realms ?? {}), ...Object.keys(next.realms ?? {})]);
  for (const id of [...ids].sort()) {
    const before = parent?.realms?.[id] ?? null;
    const after = next.realms?.[id] ?? null;
    if (!before) changes.push({ realm: id, created: true, deleted: false, policy: true, content: true });
    else if (!after) changes.push({ realm: id, created: false, deleted: true, policy: true, content: true });
    else {
      const policy = realmPolicyDigest(before) !== realmPolicyDigest(after);
      const content = realmContentDigest(before) !== realmContentDigest(after);
      if (policy || content) changes.push({ realm: id, created: false, deleted: false, policy, content });
    }
  }
  return changes;
}

function validateIdentityEvolution(parent, next) {
  validateIdentityRegistry(next.identities);
  if (!parent) return;
  for (const id of Object.keys(parent.identities ?? {})) {
    if (!next.identities[id]) throw new Error(`PigFS Identity registry is append/update-only; ${id} was removed`);
  }
}

export function validatePigFsTransition(parent, next, { parentCommitOffset = null } = {}) {
  if (next?.format !== PIG_FS_FORMAT) throw new Error('Unsupported PigFS root format');
  if (!Number.isInteger(next.generation) || next.generation < 1) throw new Error('Invalid PigFS generation');
  const historyMode = rootHistoryMode(next);
  next.historyMode = historyMode;
  if (!plainObject(next.rootPolicy) || !Array.isArray(next.rootPolicy.admins)) throw new Error('Invalid PigFS root policy');
  next.rootPolicy.admins = normalizeIdentityIds(next.rootPolicy.admins);
  if (historyMode === PIG_FS_HISTORY_INTEGRITY) validateIdentityEvolution(parent, next);
  else validateIdentityRegistry(next.identities);
  if (!plainObject(next.realms)) throw new Error('PigFS realms must be an object');
  for (const [id, realm] of Object.entries(next.realms)) {
    if (id !== realm.id) throw new Error(`PigFS realm registry key mismatch: ${id}`);
    validateRealmDescriptor(realm, next.identities);
  }

  if (historyMode === PIG_FS_HISTORY_NONE) {
    if (rootNeedsIntegrityChain(next)) throw new Error('Shared PigFS realms require the integrity chain');
    if (next.previousCommitHash != null || next.previousCommitOffset != null) throw new Error('History-free PigFS snapshots cannot link previous commits');
    if (next.authorization != null) throw new Error('History-free PigFS snapshots are not mutation-signed');
    if (next.mutation != null) throw new Error('History-free PigFS snapshots do not retain mutation history');
    if (next.stateHash !== computePigFsStateHash(next)) throw new Error('PigFS state hash mismatch');
    if (next.commitHash !== computePigFsCommitHash(next)) throw new Error('PigFS commit hash mismatch');
    return { valid: true, historyMode, changes: [] };
  }

  validateMutationShape(next);
  if (next.stateHash !== computePigFsStateHash(next)) throw new Error('PigFS state hash mismatch');
  if (next.commitHash !== computePigFsCommitHash(next)) throw new Error('PigFS commit hash mismatch');

  const actorId = next.authorization?.signer ?? null;
  const signedIdentity = Boolean(actorId);
  if (signedIdentity) {
    const identity = next.identities[actorId];
    if (!identity) throw new Error(`PigFS commit signer ${actorId} is not in the Identity registry`);
    const proof = verifyWursterIdentityPayload(identity, commitProofPayload(next), next.authorization, { context: PIG_FS_COMMIT_CONTEXT });
    if (!proof.valid) throw new Error(`PigFS commit signature is invalid: ${proof.error}`);
  } else if (next.authorization != null) {
    throw new Error('Unsigned PigFS commits must have authorization = null');
  }

  if (!parent) {
    if (next.generation !== 1 || next.previousCommitHash != null || next.previousCommitOffset != null) throw new Error('Invalid PigFS genesis linkage');
    if (next.rootPolicy.admins.length && (!signedIdentity || !next.rootPolicy.admins.includes(actorId))) {
      throw new Error('PigFS genesis with root admins must be signed by one of them');
    }
    return { valid: true, historyMode, changes: inferRealmChanges(null, next) };
  }

  if (rootHistoryMode(parent) !== PIG_FS_HISTORY_INTEGRITY) throw new Error('Cannot continue an integrity chain from a history-free PigFS snapshot');
  if (next.generation !== parent.generation + 1) throw new Error('PigFS generation is not sequential');
  if (next.previousCommitHash !== parent.commitHash) throw new Error('PigFS previous commit hash mismatch');
  if (parentCommitOffset != null && next.previousCommitOffset !== parentCommitOffset) throw new Error('PigFS previous commit offset mismatch');

  const rootPolicyChanged = !sameJson(parent.rootPolicy, next.rootPolicy);
  if (rootPolicyChanged && !rootAdmin(parent, actorId)) throw new Error('PigFS root policy change is not authorized');

  const changes = inferRealmChanges(parent, next);
  for (const change of changes) {
    const before = parent.realms?.[change.realm] ?? null;
    const after = next.realms?.[change.realm] ?? null;
    const governance = pigFsRealmGovernance(before ?? after);
    if (change.created || change.deleted) {
      if (!rootAdmin(parent, actorId)) throw new Error(`Creating/removing realm ${change.realm} requires PigFS root admin`);
      continue;
    }
    if (governance === 'shared') {
      if (change.policy && !realmAdmin(parent, before, actorId)) throw new Error(`Policy change for realm ${change.realm} is not authorized`);
      if (change.content && !realmWriter(before, actorId, signedIdentity)) throw new Error(`Write to realm ${change.realm} is not authorized`);
    } else if (change.policy) {
      const personalClaim = governance === 'personal' && !personalRealmClaimed(before) && personalRealmClaimed(after)
        && after.access.admins?.[0] === actorId && !change.content;
      if (!personalClaim) throw new Error(`PigFS ${governance} realm ${change.realm} does not support mutable sharing policy`);
    }
  }

  const declared = [...next.mutation.changes].map((item) => ({
    realm: normalizePigFsRealmId(item.realm),
    created: Boolean(item.created),
    deleted: Boolean(item.deleted),
    policy: Boolean(item.policy),
    content: Boolean(item.content)
  })).sort((a, b) => a.realm.localeCompare(b.realm));
  if (!sameJson(declared, changes)) throw new Error('PigFS mutation declaration does not match the state transition');
  return { valid: true, historyMode, changes };
}

export async function loadPigFsCommit(source, commitOffset) {
  const record = await readFsRecord(source, commitOffset);
  if (record.type !== PIG_FS_RECORD.COMMIT) throw new Error('PigFS commit pointer does not reference a commit record');
  let root;
  try { root = JSON.parse(record.payload.toString('utf8')); } catch { throw new Error('Invalid PigFS commit JSON'); }
  if (root?.format !== PIG_FS_FORMAT) throw new Error(`Expected ${PIG_FS_FORMAT}, got ${root?.format ?? 'missing'}`);
  return { root, record };
}

export async function verifyPigFsHistory(source, baseOffset) {
  const latestOffset = await locateLatestFsCommit(source, assertSafeOffset(baseOffset, 'PigFS base offset'));
  if (latestOffset == null) return { valid: true, format: PIG_FS_FORMAT, historyMode: PIG_FS_HISTORY_NONE, root: null, commitOffset: null, commits: [] };
  const latestCommit = await loadPigFsCommit(source, latestOffset);
  const mode = rootHistoryMode(latestCommit.root);
  if (mode === PIG_FS_HISTORY_NONE) {
    validatePigFsTransition(null, latestCommit.root);
    return {
      valid: true,
      format: PIG_FS_FORMAT,
      historyMode: mode,
      root: clone(latestCommit.root),
      commitOffset: latestOffset,
      commits: []
    };
  }

  const reverse = [];
  let offset = latestOffset;
  const seen = new Set();
  while (offset != null) {
    if (seen.has(offset)) throw new Error('PigFS commit chain contains a loop');
    seen.add(offset);
    const { root, record } = await loadPigFsCommit(source, offset);
    if (rootHistoryMode(root) !== PIG_FS_HISTORY_INTEGRITY) throw new Error('PigFS integrity chain crosses a history-free snapshot');
    reverse.push({ offset, root, record });
    offset = root.previousCommitOffset == null ? null : assertSafeOffset(root.previousCommitOffset, 'PigFS previous commit offset');
  }
  const commits = reverse.reverse();
  for (let index = 0; index < commits.length; index += 1) {
    const current = commits[index];
    const parent = index ? commits[index - 1] : null;
    validatePigFsTransition(parent?.root ?? null, current.root, { parentCommitOffset: parent?.offset ?? null });
  }
  const latest = commits.at(-1);
  return {
    valid: true,
    format: PIG_FS_FORMAT,
    historyMode: mode,
    root: clone(latest.root),
    commitOffset: latest.offset,
    commits: commits.map(({ offset, root }) => ({
      offset,
      generation: root.generation,
      commitHash: root.commitHash,
      previousCommitHash: root.previousCommitHash ?? null,
      committedAt: root.committedAt,
      actor: root.authorization?.signer ?? null,
      actorIdentity: root.authorization?.signer ? clone(root.identities?.[root.authorization.signer] ?? null) : null,
      mutation: clone(root.mutation)
    }))
  };
}

export function comparePigFsHistories(left, right) {
  if ((left?.historyMode ?? PIG_FS_HISTORY_NONE) === PIG_FS_HISTORY_NONE
      || (right?.historyMode ?? PIG_FS_HISTORY_NONE) === PIG_FS_HISTORY_NONE) {
    if (left?.root?.commitHash && left.root.commitHash === right?.root?.commitHash) return { relation: 'same', commonGeneration: left.root.generation ?? 0 };
    return { relation: 'untracked', commonGeneration: null };
  }
  const a = (left?.commits ?? []).map((item) => item.commitHash);
  const b = (right?.commits ?? []).map((item) => item.commitHash);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  if (common === a.length && common === b.length) return { relation: 'same', commonGeneration: common };
  if (common === a.length) return { relation: 'behind', commonGeneration: common, aheadBy: b.length - a.length };
  if (common === b.length) return { relation: 'ahead', commonGeneration: common, aheadBy: a.length - b.length };
  return { relation: 'fork', commonGeneration: common, leftCommits: a.length - common, rightCommits: b.length - common };
}

function splitJsonItems(items, makePayload, targetBytes) {
  const pages = [];
  let current = [];
  for (const item of items) {
    const candidate = [...current, item];
    const bytes = Buffer.from(JSON.stringify(makePayload(candidate)));
    if (bytes.length > PIG_FS_MAX_RECORD_PAYLOAD) {
      if (!current.length) throw new Error('A single PigFS metadata item exceeds 4 MiB');
      pages.push(current);
      current = [item];
    } else if (current.length && bytes.length > targetBytes) {
      pages.push(current);
      current = [item];
    } else current = candidate;
  }
  if (current.length) pages.push(current);
  return pages;
}

function sealRealmBytes(realmKey, data, aad) {
  if (!Buffer.isBuffer(realmKey) || realmKey.length !== 32) throw new Error('PigFS realm key must be 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', realmKey, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return {
    data: ciphertext,
    encryption: { format: PIG_FS_REALM_KEY_FORMAT, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
  };
}

function openRealmBytes(realmKey, data, encryption, aad) {
  if (!Buffer.isBuffer(realmKey) || realmKey.length !== 32) throw new Error('PigFS realm key must be 32 bytes');
  if (encryption?.format !== PIG_FS_REALM_KEY_FORMAT || encryption.algorithm !== 'aes-256-gcm') throw new Error('Unsupported PigFS realm encryption');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', realmKey, Buffer.from(encryption.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(encryption.tag, 'base64'));
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    const error = new Error('PigFS realm record failed authentication');
    error.code = 'PIG_FS_LOCKED';
    throw error;
  }
}

async function decodeRealmMetadata(source, descriptor, expectedType, expectedFormat, realm, realmKey = null) {
  const record = await readFsRecord(source, descriptor.recordOffset);
  if (record.type !== expectedType) throw new Error('PigFS metadata record type mismatch');
  let payload = record.payload;
  if (realm.protection === 'sealed') {
    if (!realmKey) {
      const error = new Error(`PigFS realm ${realm.id} is sealed`);
      error.code = 'PIG_FS_LOCKED';
      throw error;
    }
    if (!descriptor.encryption) throw new Error(`Sealed realm ${realm.id} contains plaintext metadata`);
    payload = openRealmBytes(realmKey, payload, descriptor.encryption, descriptor.aad);
  } else if (descriptor.encryption) throw new Error(`Public realm ${realm.id} contains sealed metadata`);
  if (descriptor.plainSha256 && sha256(payload) !== descriptor.plainSha256) throw new Error('PigFS metadata integrity check failed');
  let parsed;
  try { parsed = JSON.parse(payload.toString('utf8')); } catch { throw new Error('Invalid PigFS metadata JSON'); }
  if (parsed?.format !== expectedFormat) throw new Error(`Unexpected PigFS metadata format ${parsed?.format ?? 'missing'}`);
  return parsed;
}

export async function loadPigFsRealmCatalog(source, realm, { realmKey = null } = {}) {
  const entries = new Map();
  for (const page of realm?.catalogPages ?? []) {
    const parsed = await decodeRealmMetadata(source, page, PIG_FS_RECORD.CATALOG, PIG_FS_CATALOG_FORMAT, realm, realmKey);
    for (const entry of parsed.entries ?? []) entries.set(entry.path, clone(entry));
  }
  return entries;
}

function compareWurstFsPath(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

function catalogCandidates(realm, target) {
  const hinted = [];
  const fallback = [];
  for (const page of realm?.catalogPages ?? []) {
    if (typeof page.first !== 'string' || typeof page.last !== 'string') { hinted.push(page); continue; }
    const inside = compareWurstFsPath(target, page.first) >= 0 && compareWurstFsPath(target, page.last) <= 0;
    (inside ? hinted : fallback).push(page);
  }
  // first/last are acceleration hints, never authority. A stale or malformed hint
  // must not make an otherwise valid catalog entry disappear.
  return [...hinted, ...fallback];
}

export async function statPigFsEntry(source, root, fsPath, { realmKey = null } = {}) {
  const { realmId, path } = resolvePigFsPath(root, fsPath, { allowRealmRoot: true });
  const realm = root?.realms?.[realmId];
  if (!realm) return null;
  if (!path) return { path: pigFsRealmPublicPath(realm), realm: realmId, name: realm.label ?? realm.id, type: 'directory', size: 0, revision: root.generation };
  for (const page of catalogCandidates(realm, path)) {
    const parsed = await decodeRealmMetadata(source, page, PIG_FS_RECORD.CATALOG, PIG_FS_CATALOG_FORMAT, realm, realmKey);
    const entry = parsed.entries?.find((item) => item.path === path);
    if (entry) return { ...clone(entry), path: pigFsRealmPublicPath(realm, entry.path), realm: realmId };
  }
  return null;
}

export async function listPigFsDirectory(source, root, fsPath = '/', { realmKeys = new Map(), realmKey = null } = {}) {
  const normalized = normalizePigFsPath(fsPath ?? '/');
  if (normalized === '/') {
    return Object.values(root?.realms ?? {}).sort((a, b) => a.id.localeCompare(b.id)).map((realm) => ({
      path: pigFsRealmPublicPath(realm),
      realm: realm.id,
      name: realm.label ?? realm.id,
      type: 'realm',
      protection: realm.protection,
      size: 0
    }));
  }
  const parsedPath = resolvePigFsPath(root, normalized, { allowRealmRoot: true });
  const realm = root?.realms?.[parsedPath.realmId];
  if (!realm) return [];
  const key = realmKey ?? realmKeys.get?.(realm.id) ?? null;
  const catalog = await loadPigFsRealmCatalog(source, realm, { realmKey: key });
  const prefix = parsedPath.path ? `${parsedPath.path}/` : '';
  const result = [];
  for (const entry of catalog.values()) {
    if (!entry.path.startsWith(prefix)) continue;
    const remainder = entry.path.slice(prefix.length);
    if (!remainder || remainder.includes('/')) continue;
    result.push({ ...clone(entry), path: pigFsRealmPublicPath(realm, entry.path), realm: realm.id });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadPigFsRealmChunks(source, realm, entry, realmKey = null) {
  const chunks = [];
  for (const page of entry.mapPages ?? []) {
    const parsed = await decodeRealmMetadata(source, page, PIG_FS_RECORD.MAP, PIG_FS_MAP_FORMAT, realm, realmKey);
    chunks.push(...(parsed.chunks ?? []));
  }
  return chunks.sort((a, b) => a.plainOffset - b.plainOffset);
}



export async function measurePigFsStorage(source, root, { baseOffset = 0, commitOffset = null, realmKeys = new Map() } = {}) {
  const physicalBytes = Math.max(0, Number(source.size) - Number(baseOffset));
  if (!root) return { physicalBytes, liveBytes: 0, reclaimableBytes: physicalBytes, logicalBytes: 0, files: 0, directories: 0, historyMode: PIG_FS_HISTORY_NONE };
  const historyMode = rootHistoryMode(root);
  let logicalBytes = 0;
  let files = 0;
  let directories = 0;
  for (const realm of Object.values(root.realms ?? {})) {
    if (realm.protection === 'public') {
      logicalBytes += Number(realm.stats?.logicalBytes ?? 0);
      files += Number(realm.stats?.files ?? 0);
      directories += Number(realm.stats?.directories ?? 0);
    }
  }
  if (historyMode !== PIG_FS_HISTORY_NONE) {
    return { physicalBytes, liveBytes: null, reclaimableBytes: null, logicalBytes, files, directories, historyMode, reason: 'integrity-chain-retained' };
  }

  const seen = new Set();
  let liveBytes = 0;
  const addRecord = async (offset) => {
    const key = Number(offset);
    if (!Number.isSafeInteger(key) || key < Number(baseOffset) || seen.has(key)) return;
    const record = await readFsRecord(source, key);
    seen.add(key);
    liveBytes += record.recordEnd - record.recordStart;
  };
  if (commitOffset != null) await addRecord(commitOffset);

  for (const realm of Object.values(root.realms ?? {})) {
    const key = realm.protection === 'sealed' ? realmKeys.get?.(realm.id) ?? null : null;
    if (realm.protection === 'sealed' && !key) {
      return { physicalBytes, liveBytes: null, reclaimableBytes: null, logicalBytes, files, directories, historyMode, lockedRealm: realm.id };
    }
    for (const page of realm.catalogPages ?? []) await addRecord(page.recordOffset);
    const catalog = await loadPigFsRealmCatalog(source, realm, { realmKey: key });
    for (const entry of catalog.values()) {
      if (entry.type !== 'file') continue;
      for (const page of entry.mapPages ?? []) await addRecord(page.recordOffset);
      const chunks = await loadPigFsRealmChunks(source, realm, entry, key);
      for (const chunk of chunks) await addRecord(chunk.recordOffset);
    }
  }
  return {
    physicalBytes,
    liveBytes,
    reclaimableBytes: Math.max(0, physicalBytes - liveBytes),
    logicalBytes,
    files,
    directories,
    historyMode
  };
}

export async function readPigFsRange(source, root, fsPath, offset = 0, length = null, { realmKey = null } = {}) {
  const { realmId, path } = resolvePigFsPath(root, fsPath, { allowRealmRoot: false });
  const realm = root?.realms?.[realmId];
  if (!realm) return null;
  const publicEntry = await statPigFsEntry(source, root, fsPath, { realmKey });
  if (!publicEntry || publicEntry.type !== 'file') return null;
  const entry = { ...publicEntry, path };
  const start = assertSafeOffset(offset, 'PigFS read offset');
  if (start > entry.size) throw new Error('PigFS read offset exceeds file size');
  const wanted = length == null ? entry.size - start : assertSafeOffset(length, 'PigFS read length');
  const end = Math.min(entry.size, start + wanted);
  const chunks = await loadPigFsRealmChunks(source, realm, entry, realmKey);
  const pieces = [];
  let total = 0;
  for (const chunk of chunks) {
    const chunkStart = chunk.plainOffset;
    const chunkEnd = chunkStart + chunk.plainLength;
    if (chunkEnd <= start || chunkStart >= end) continue;
    const record = await readFsRecord(source, chunk.recordOffset);
    if (record.type !== PIG_FS_RECORD.DATA) throw new Error('PigFS chunk points to non-data record');
    let plain = record.payload;
    if (realm.protection === 'sealed') {
      if (!realmKey) {
        const error = new Error(`PigFS realm ${realm.id} is sealed`);
        error.code = 'PIG_FS_LOCKED';
        throw error;
      }
      if (!chunk.encryption) throw new Error(`Sealed realm ${realm.id} contains plaintext data`);
      plain = openRealmBytes(realmKey, plain, chunk.encryption, chunk.aad);
    } else if (chunk.encryption) throw new Error(`Public realm ${realm.id} contains sealed data`);
    if (plain.length !== chunk.plainLength) throw new Error('PigFS chunk length mismatch');
    if (chunk.plainSha256 && sha256(plain) !== chunk.plainSha256) throw new Error('PigFS chunk integrity mismatch');
    const sliceStart = Math.max(start, chunkStart) - chunkStart;
    const sliceEnd = Math.min(end, chunkEnd) - chunkStart;
    const piece = Buffer.from(plain.subarray(sliceStart, sliceEnd));
    pieces.push(piece);
    total += piece.length;
  }
  return { entry: publicEntry, offset: start, length: total, total: entry.size, eof: start + total >= entry.size, data: Buffer.concat(pieces, total) };
}

function entryName(path) {
  return path.split('/').at(-1);
}

function parentPaths(path) {
  const parts = path.split('/');
  const result = [];
  for (let i = 1; i < parts.length; i += 1) result.push(parts.slice(0, i).join('/'));
  return result;
}


function entryVersionFingerprint(entry) {
  if (!entry) return null;
  return hashJson({
    type: entry.type,
    size: Number(entry.size ?? 0),
    revision: Number(entry.revision ?? 0),
    modifiedGeneration: Number(entry.modifiedGeneration ?? 0),
    modifiedAt: Number(entry.modifiedAt ?? 0),
    mapPages: entry.type === 'file' ? (entry.mapPages ?? []).map((page) => ({ recordOffset: page.recordOffset, count: page.count ?? null })) : null
  });
}

function ensureParents(entries, path, timestamp, actorId, generation) {
  for (const parent of parentPaths(path)) {
    if (entries.has(parent)) continue;
    entries.set(parent, {
      objectId: crypto.randomUUID(),
      path: parent,
      name: entryName(parent),
      type: 'directory',
      size: 0,
      mime: null,
      createdAt: timestamp,
      modifiedAt: timestamp,
      revision: 1,
      modifiedBy: actorId,
      modifiedGeneration: generation
    });
  }
}

export class PigFsStore {
  constructor({ source, baseOffset, append, sync = async () => {} } = {}) {
    if (!source || typeof source.read !== 'function' || !Number.isSafeInteger(source.size)) throw new Error('PigFS store requires random-access source');
    if (typeof append !== 'function') throw new Error('PigFS store requires append(bytes)');
    this.source = source;
    this.baseOffset = assertSafeOffset(baseOffset, 'PigFS base offset');
    this.append = append;
    this.sync = sync;
    this.root = null;
    this.commitOffset = null;
    this.nextOffset = source.size;
    this.sequence = 0;
    this.realmKeys = new Map();
    this.sessions = new Map();
    this.appendTail = Promise.resolve();
    this.mutationTail = Promise.resolve();
    this.watchers = new Map();
    this.transactions = new Map();
  }

  async init() {
    const history = await verifyPigFsHistory(this.source, this.baseOffset);
    this.root = history.root;
    this.commitOffset = history.commitOffset;
    return this;
  }

  async appendRecord(type, payload, previousCommitOffset = 0) {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const task = this.appendTail.then(async () => {
      const recordStart = this.nextOffset;
      const record = makeFsRecord(type, bytes, { recordStart, previousCommitOffset, sequence: ++this.sequence });
      await this.append(record);
      this.nextOffset += record.length;
      this.source.size = this.nextOffset;
      return { recordStart, payloadLength: bytes.length, recordLength: record.length };
    });
    this.appendTail = task.then(() => undefined, () => undefined);
    return task;
  }

  async withMutationLock(fn) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const previous = this.mutationTail;
    this.mutationTail = previous.then(() => gate, () => gate);
    await previous.catch(() => {});
    try { return await fn(); }
    finally { release(); }
  }

  identityRegistryWith(...records) {
    const identities = clone(this.root?.identities ?? {});
    for (const record of records.flat().filter(Boolean)) {
      const verified = verifyWursterIdentityRecord(record);
      if (!verified.valid) throw new Error(`Invalid Wurster Identity: ${verified.error}`);
      identities[record.identityId] = clone(record);
    }
    return identities;
  }

  async initialize({ actor = null, rootAdmins = null, identities = [], realms = [] } = {}) {
    if (this.root) throw new Error('PigFS is already initialized');
    const actorRecord = actor?.publicRecord ?? null;
    const registry = {};
    for (const record of [...identities, actorRecord].filter(Boolean)) {
      const verified = verifyWursterIdentityRecord(record);
      if (!verified.valid) throw new Error(`Invalid Wurster Identity: ${verified.error}`);
      registry[record.identityId] = clone(record);
    }

    const realmMap = {};
    let needsIdentity = false;
    for (const spec of realms) {
      const id = normalizePigFsRealmId(spec.id);
      if (realmMap[id]) throw new Error(`Duplicate PigFS realm ${id}`);
      for (const record of spec.identities ?? []) {
        const verified = verifyWursterIdentityRecord(record);
        if (!verified.valid) throw new Error(`Invalid Wurster Identity: ${verified.error}`);
        registry[record.identityId] = clone(record);
      }

      if (Object.hasOwn(spec, 'mode')) throw new Error(`PigFS realm ${id} uses removed field mode; omit governance for ordinary storage or use governance: personal/shared`);
      const requestedGovernanceRaw = spec.governance == null ? '' : String(spec.governance).trim().toLowerCase();
      if (requestedGovernanceRaw && !PIG_FS_REALM_GOVERNANCE.includes(requestedGovernanceRaw)) throw new Error(`Unsupported PigFS realm governance: ${spec.governance}`);
      const requestedGovernance = requestedGovernanceRaw || null;
      const protectionGuess = requestedGovernance === 'personal' ? 'sealed' : String(spec.protection ?? 'public');
      let access;
      let governance;
      let claimed = true;

      if (!requestedGovernance && protectionGuess === 'public' && !spec.access) {
        governance = PIG_FS_ORDINARY;
        access = normalizePigFsRealmAccess({ read: { mode: 'public' }, write: { mode: 'open' }, admins: [] }, 'public');
      } else if (requestedGovernance === 'personal') {
        governance = 'personal';
        if (actorRecord) {
          access = normalizePigFsRealmAccess({
            read: { mode: 'members', identities: [actorRecord.identityId] },
            write: { mode: 'members', identities: [actorRecord.identityId] },
            admins: [actorRecord.identityId]
          }, 'sealed');
        } else {
          // Personal realms may be shipped empty and unclaimed. The first local
          // Wurster Identity that explicitly unlocks/claims the realm becomes
          // its sole owner. This lets a Wurst carry ordinary public data before
          // the recipient has ever used it without inventing a placeholder key.
          claimed = false;
          access = normalizePigFsRealmAccess({
            read: { mode: 'members', identities: [] },
            write: { mode: 'members', identities: [] },
            admins: []
          }, 'sealed');
        }
      } else {
        const protection = protectionGuess;
        const rawAccess = normalizePigFsRealmAccess(spec.access ?? {}, protection);
        governance = requestedGovernance || pigFsRealmGovernance({ protection, access: rawAccess });
        if (governance === PIG_FS_ORDINARY) access = normalizePigFsRealmAccess({ read: { mode: 'public' }, write: { mode: 'open' }, admins: [] }, 'public');
        else if (governance === 'personal') {
          if (actorRecord) {
            access = normalizePigFsRealmAccess({
              read: { mode: 'members', identities: [actorRecord.identityId] },
              write: { mode: 'members', identities: [actorRecord.identityId] },
              admins: [actorRecord.identityId]
            }, 'sealed');
          } else {
            claimed = false;
            access = normalizePigFsRealmAccess({ read: { mode: 'members', identities: [] }, write: { mode: 'members', identities: [] }, admins: [] }, 'sealed');
          }
        } else {
          if (!actorRecord) throw new Error(`Shared PigFS realm ${id} requires an authenticated owner identity`);
          needsIdentity = true;
          access = rawAccess;
        }
      }

      const protection = governance === PIG_FS_ORDINARY ? 'public' : governance === 'personal' ? 'sealed' : protectionGuess;
      const audit = normalizeRealmAudit(spec.audit, governance);
      const keyWraps = [];
      if (protection === 'sealed' && (governance !== 'personal' || claimed)) {
        const key = crypto.randomBytes(32);
        this.realmKeys.set(id, key);
        for (const readerId of access.read.identities) {
          const recipient = registry[readerId];
          if (!recipient) throw new Error(`Unknown sealed realm reader ${readerId}`);
          keyWraps.push(wrapKeyForWursterIdentity(key, recipient, { realmId: id }));
        }
      }
      realmMap[id] = {
        id,
        mount: normalizePigFsMount(spec.mount, id),
        quotaBytes: spec.quotaBytes == null ? null : Number(spec.quotaBytes),
        label: String(spec.label ?? id).slice(0, 120),
        ...(governance === PIG_FS_ORDINARY ? {} : { governance }),
        ...(governance === 'personal' ? { claimed } : {}),
        audit,
        protection,
        access,
        keyWraps,
        catalogPages: [],
        stats: protection === 'sealed' ? { sealed: true, hasEntries: false } : { files: 0, directories: 0, logicalBytes: 0 }
      };
    }

    const mounts = Object.values(realmMap).map((realm) => realm.mount);
    if (new Set(mounts).size !== mounts.length) throw new Error('PigFS realm mounts must be unique');
    for (const a of mounts) for (const b of mounts) if (a !== b && (a.startsWith(`${b}/`) || b.startsWith(`${a}/`))) throw new Error('PigFS realm mounts may not overlap');
    if (needsIdentity && !actorRecord) throw new Error('PigFS identity-backed realms require an authenticated owner identity');
    const historyMode = Object.values(realmMap).some((realm) => pigFsRealmGovernance(realm) === 'shared')
      ? PIG_FS_HISTORY_INTEGRITY
      : PIG_FS_HISTORY_NONE;
    const admins = normalizeIdentityIds(rootAdmins ?? (actorRecord ? [actorRecord.identityId] : []));
    for (const id of admins) if (!registry[id]) throw new Error(`Unknown PigFS root admin ${id}`);

    const root = {
      format: PIG_FS_FORMAT,
      historyMode,
      generation: 1,
      previousCommitOffset: null,
      previousCommitHash: null,
      committedAt: Date.now(),
      rootPolicy: { admins },
      identities: registry,
      realms: realmMap,
      mutation: historyMode === PIG_FS_HISTORY_INTEGRITY
        ? { format: PIG_FS_MUTATION_FORMAT, actor: actorRecord?.identityId ?? null, changes: inferRealmChanges(null, { realms: realmMap }), operations: Object.values(realmMap).some(realmKeepsAudit) ? [{ type: 'genesis' }] : [] }
        : null,
      authorization: null,
      stateHash: null,
      commitHash: null
    };
    root.stateHash = computePigFsStateHash(root);
    if (historyMode === PIG_FS_HISTORY_INTEGRITY && actor) root.authorization = signWursterIdentityPayload(actor, commitProofPayload(root), { context: PIG_FS_COMMIT_CONTEXT });
    root.commitHash = computePigFsCommitHash(root);
    validatePigFsTransition(null, root);
    const commit = await this.appendRecord(PIG_FS_RECORD.COMMIT, Buffer.from(JSON.stringify(root)), 0);
    await this.sync();
    this.root = root;
    this.commitOffset = commit.recordStart;
    return clone(root);
  }

  realms() {
    return Object.values(this.root?.realms ?? {}).map(clone);
  }

  realm(id) {
    const realm = this.root?.realms?.[normalizePigFsRealmId(id)];
    return realm ? clone(realm) : null;
  }

  async claimPersonalRealm(realmId, { actor } = {}) {
    return this.withMutationLock(async () => {
      if (!this.root) throw new Error('PigFS is not initialized');
      const id = normalizePigFsRealmId(realmId);
      const realm = this.root.realms?.[id];
      if (!realm) throw new Error(`Unknown PigFS realm ${id}`);
      if (pigFsRealmGovernance(realm) !== 'personal') {
        const error = new Error(`PigFS realm ${id} is not a personal realm`);
        error.code = 'PIG_FS_NOT_PERSONAL';
        throw error;
      }
      if (personalRealmClaimed(realm)) return { realm: id, claimed: false, owner: realm.access.admins?.[0] ?? null };
      if (realm.catalogPages.length || realm.keyWraps.length) throw new Error(`Unclaimed personal realm ${id} unexpectedly contains data`);
      const actorRecord = actor?.publicRecord ?? null;
      const verified = actorRecord ? verifyWursterIdentityRecord(actorRecord) : { valid: false, error: 'missing identity' };
      if (!verified.valid) {
        const error = new Error('Claiming a personal realm requires an authenticated Wurster Identity');
        error.code = 'WURST_AUTH_REQUIRED';
        throw error;
      }

      const key = crypto.randomBytes(32);
      const nextRoot = clone(this.root);
      nextRoot.identities = this.identityRegistryWith(actorRecord);
      const nextRealm = nextRoot.realms[id];
      nextRealm.governance = 'personal';
      nextRealm.claimed = true;
      nextRealm.protection = 'sealed';
      nextRealm.access = normalizePigFsRealmAccess({
        read: { mode: 'members', identities: [actorRecord.identityId] },
        write: { mode: 'members', identities: [actorRecord.identityId] },
        admins: [actorRecord.identityId]
      }, 'sealed');
      nextRealm.keyWraps = [wrapKeyForWursterIdentity(key, actorRecord, { realmId: id })];
      nextRealm.catalogPages = [];
      nextRealm.stats = { sealed: true, hasEntries: false };
      try {
        await this.commitRoot(nextRoot, actor, [{ type: 'claim-personal', realm: id }]);
        const previous = this.realmKeys.get(id);
        if (previous) previous.fill(0);
        this.realmKeys.set(id, key);
        return { realm: id, claimed: true, owner: actorRecord.identityId, unlocked: true };
      } catch (error) {
        key.fill(0);
        throw error;
      }
    });
  }

  unlockRealm(realmId, materialOrMeatphrase) {
    const id = normalizePigFsRealmId(realmId);
    const realm = this.root?.realms?.[id];
    if (!realm) throw new Error(`Unknown PigFS realm ${id}`);
    if (realm.protection === 'public') return { realm: id, unlocked: true, public: true };
    if (pigFsRealmGovernance(realm) === 'personal' && !personalRealmClaimed(realm)) {
      const error = new Error(`Personal realm ${id} has not been claimed yet`);
      error.code = 'PIG_FS_UNCLAIMED';
      throw error;
    }
    const material = typeof materialOrMeatphrase === 'string' ? deriveWursterIdentityMaterial(materialOrMeatphrase) : materialOrMeatphrase;
    const wrap = realm.keyWraps.find((item) => item.recipient === material?.publicRecord?.identityId);
    if (!wrap) {
      const error = new Error(`Wurster Identity has no read access to realm ${id}`);
      error.code = 'PIG_FS_FORBIDDEN';
      throw error;
    }
    const key = unwrapKeyForWursterIdentity(wrap, material, { realmId: id });
    const previous = this.realmKeys.get(id);
    if (previous) previous.fill(0);
    this.realmKeys.set(id, key);
    return { realm: id, unlocked: true, identity: material.publicRecord.identityId };
  }

  lockRealm(realmId) {
    const id = normalizePigFsRealmId(realmId);
    const key = this.realmKeys.get(id);
    if (key) key.fill(0);
    return this.realmKeys.delete(id);
  }

  async currentCatalog(realmId) {
    const id = normalizePigFsRealmId(realmId);
    const realm = this.root?.realms?.[id];
    if (!realm) throw new Error(`Unknown PigFS realm ${id}`);
    return loadPigFsRealmCatalog(this.source, realm, { realmKey: this.realmKeys.get(id) ?? null });
  }

  assertWriter(realm, actor) {
    const actorId = actor?.publicRecord?.identityId ?? null;
    const signed = Boolean(actorId);
    if (!realmWriter(realm, actorId, signed)) {
      const error = new Error(`Identity is not allowed to write realm ${realm.id}`);
      error.code = 'PIG_FS_FORBIDDEN';
      throw error;
    }
    if (realm.protection === 'sealed' && !this.realmKeys.has(realm.id)) {
      const error = new Error(`Realm ${realm.id} must be unlocked before writing`);
      error.code = 'PIG_FS_LOCKED';
      throw error;
    }
  }

  beginWrite(fsPath, { actor = null, mime = 'application/octet-stream', createdAt = Date.now(), modifiedAt = Date.now() } = {}) {
    if (!this.root) throw new Error('PigFS is not initialized');
    const { realmId, path } = resolvePigFsPath(this.root, fsPath, { allowRealmRoot: false });
    const realm = this.root.realms[realmId];
    if (!realm) throw new Error(`Unknown PigFS realm ${realmId}`);
    this.assertWriter(realm, actor);
    if (actor) {
      const verified = verifyWursterIdentityRecord(actor.publicRecord);
      if (!verified.valid) throw new Error(`Invalid writer identity: ${verified.error}`);
    }
    const id = crypto.randomUUID();
    this.sessions.set(id, {
      id, realmId, path,
      actor,
      mime: String(mime || 'application/octet-stream'),
      createdAt, modifiedAt,
      chunks: [], size: 0,
      baseCommitOffset: this.commitOffset,
      baseCommitHash: this.root.commitHash,
      baseGeneration: this.root.generation,
      baseRealm: clone(realm),
      contentHash: crypto.createHash('sha256')
    });
    return id;
  }

  session(id) {
    const session = this.sessions.get(String(id));
    if (!session) throw new Error('Unknown PigFS write session');
    return session;
  }

  async writeChunk(id, plainBytes) {
    const session = this.session(id);
    const bytes = Buffer.isBuffer(plainBytes) ? Buffer.from(plainBytes) : Buffer.from(plainBytes ?? []);
    if (bytes.length > PIG_FS_MAX_RECORD_PAYLOAD) throw new Error('PigFS write chunks may not exceed 4 MiB');
    const realm = this.root.realms[session.realmId];
    const chunkIndex = session.chunks.length;
    const aad = `wurst-fs2-data:${session.realmId}:${session.baseGeneration + 1}:${session.path}:${chunkIndex}`;
    let stored = bytes;
    let encryption = null;
    if (realm.protection === 'sealed') {
      const sealed = sealRealmBytes(this.realmKeys.get(realm.id), bytes, aad);
      stored = sealed.data;
      encryption = sealed.encryption;
    }
    const appended = await this.appendRecord(PIG_FS_RECORD.DATA, stored, session.baseCommitOffset ?? 0);
    session.chunks.push({
      plainOffset: session.size,
      plainLength: bytes.length,
      recordOffset: appended.recordStart,
      storedLength: stored.length,
      plainSha256: realm.protection === 'sealed' ? null : sha256(bytes),
      encryption,
      aad: encryption ? aad : null
    });
    session.contentHash.update(bytes);
    session.size += bytes.length;
    return { offset: session.size - bytes.length, length: bytes.length, storedLength: stored.length };
  }

  abortWrite(id) {
    return this.sessions.delete(String(id));
  }

  async encodeMetadata(realm, type, object, aad, previousCommitOffset) {
    const plain = Buffer.from(JSON.stringify(object));
    let payload = plain;
    let encryption = null;
    if (realm.protection === 'sealed') {
      const key = this.realmKeys.get(realm.id);
      if (!key) throw new Error(`Realm ${realm.id} is locked`);
      const sealed = sealRealmBytes(key, plain, aad);
      payload = sealed.data;
      encryption = sealed.encryption;
    }
    const appended = await this.appendRecord(type, payload, previousCommitOffset ?? 0);
    return {
      recordOffset: appended.recordStart,
      payloadLength: payload.length,
      plainSha256: encryption ? null : sha256(plain),
      encryption,
      aad: encryption ? aad : null
    };
  }

  async buildRealmWithCatalog(realm, entries, changedMaps, generation, previousCommitOffset) {
    const nextRealm = clone(realm);
    for (const [path, chunks] of changedMaps) {
      const entry = entries.get(path);
      const groups = splitJsonItems(chunks, (part) => ({ format: PIG_FS_MAP_FORMAT, chunks: part }), PIG_FS_MAP_TARGET);
      entry.mapPages = [];
      for (let index = 0; index < groups.length; index += 1) {
        const part = groups[index];
        const meta = await this.encodeMetadata(nextRealm, PIG_FS_RECORD.MAP, { format: PIG_FS_MAP_FORMAT, chunks: part }, `wurst-fs2-map:${nextRealm.id}:${generation}:${path}:${index}`, previousCommitOffset);
        entry.mapPages.push({ ...meta, plainStart: part[0]?.plainOffset ?? 0, plainEnd: part.length ? part.at(-1).plainOffset + part.at(-1).plainLength : 0, count: part.length });
      }
    }
    const sorted = [...entries.values()].sort((a, b) => compareWurstFsPath(a.path, b.path));
    const logicalBytes = [...entries.values()].filter((entry) => entry.type === 'file').reduce((sum, entry) => sum + Number(entry.size ?? 0), 0);
    if (nextRealm.quotaBytes != null && logicalBytes > Number(nextRealm.quotaBytes)) { const error = new Error(`PigFS realm ${nextRealm.id} quota exceeded`); error.code = 'PIG_FS_QUOTA'; throw error; }
    const groups = splitJsonItems(sorted, (part) => ({ format: PIG_FS_CATALOG_FORMAT, entries: part }), PIG_FS_CATALOG_TARGET);
    nextRealm.catalogPages = [];
    for (let index = 0; index < groups.length; index += 1) {
      const part = groups[index];
      const meta = await this.encodeMetadata(nextRealm, PIG_FS_RECORD.CATALOG, { format: PIG_FS_CATALOG_FORMAT, entries: part }, `wurst-fs2-catalog:${nextRealm.id}:${generation}:${index}`, previousCommitOffset);
      nextRealm.catalogPages.push({
        ...meta,
        first: meta.encryption ? null : (part[0]?.path ?? ''),
        last: meta.encryption ? null : (part.at(-1)?.path ?? ''),
        count: meta.encryption ? null : part.length
      });
    }
    const files = sorted.filter((entry) => entry.type === 'file');
    nextRealm.stats = nextRealm.protection === 'sealed'
      ? { sealed: true, hasEntries: sorted.length > 0 }
      : { files: files.length, directories: sorted.length - files.length, logicalBytes };
    return nextRealm;
  }

  async commitRoot(nextRoot, actor, operations = []) {
    const actorRecord = actor?.publicRecord ?? null;
    const historyMode = rootNeedsIntegrityChain(nextRoot)
      ? PIG_FS_HISTORY_INTEGRITY
      : PIG_FS_HISTORY_NONE;
    nextRoot.format = PIG_FS_FORMAT;
    nextRoot.historyMode = historyMode;
    nextRoot.generation = this.root.generation + 1;
    nextRoot.committedAt = Date.now();
    nextRoot.identities = this.identityRegistryWith(Object.values(nextRoot.identities ?? {}), actorRecord);
    nextRoot.authorization = null;

    if (historyMode === PIG_FS_HISTORY_INTEGRITY) {
      // Once shared governance exists we retain a tiny integrity lineage. Rich
      // operation history is opt-in per shared realm; ordinary/personal
      // writes do not become a Git log just because they coexist with sharing.
      nextRoot.previousCommitOffset = this.commitOffset;
      nextRoot.previousCommitHash = this.root.commitHash;
      nextRoot.mutation = {
        format: PIG_FS_MUTATION_FORMAT,
        actor: actorRecord?.identityId ?? null,
        changes: inferRealmChanges(this.root, nextRoot),
        operations: operations
          .filter((operation) => operation?.realm && realmKeepsAudit(nextRoot.realms?.[operation.realm]))
          .map((operation) => publicMutationOperation(operation, nextRoot.realms))
      };
      nextRoot.stateHash = computePigFsStateHash(nextRoot);
      if (actor) nextRoot.authorization = signWursterIdentityPayload(actor, commitProofPayload(nextRoot), { context: PIG_FS_COMMIT_CONTEXT });
      nextRoot.commitHash = computePigFsCommitHash(nextRoot);
      validatePigFsTransition(this.root, nextRoot, { parentCommitOffset: this.commitOffset });
    } else {
      nextRoot.previousCommitOffset = null;
      nextRoot.previousCommitHash = null;
      nextRoot.mutation = null;
      nextRoot.stateHash = computePigFsStateHash(nextRoot);
      nextRoot.commitHash = computePigFsCommitHash(nextRoot);
      validatePigFsTransition(null, nextRoot);
    }

    const commit = await this.appendRecord(PIG_FS_RECORD.COMMIT, Buffer.from(JSON.stringify(nextRoot)), historyMode === PIG_FS_HISTORY_INTEGRITY ? (this.commitOffset ?? 0) : 0);
    await this.sync();
    this.root = nextRoot;
    this.commitOffset = commit.recordStart;
    return { root: clone(nextRoot), commitOffset: this.commitOffset };
  }

  async publishStandaloneRoot(nextRoot, { generation = null } = {}) {
    const root = clone(nextRoot);
    root.format = PIG_FS_FORMAT;
    root.historyMode = PIG_FS_HISTORY_NONE;
    root.generation = generation == null ? Math.max(1, Number(root.generation ?? 1)) : Math.max(1, Number(generation));
    root.previousCommitOffset = null;
    root.previousCommitHash = null;
    root.committedAt = Number(root.committedAt ?? Date.now());
    root.mutation = null;
    root.authorization = null;
    root.stateHash = computePigFsStateHash(root);
    root.commitHash = computePigFsCommitHash(root);
    validatePigFsTransition(null, root);
    const commit = await this.appendRecord(PIG_FS_RECORD.COMMIT, Buffer.from(JSON.stringify(root)), 0);
    await this.sync();
    this.root = root;
    this.commitOffset = commit.recordStart;
    return { root: clone(root), commitOffset: this.commitOffset };
  }

  async commitWrite(id) {
    return this.withMutationLock(async () => {
      const session = this.session(id);
      let realm = this.root.realms[session.realmId];
      if (!realm) {
        const error = new Error(`PigFS realm ${session.realmId} no longer exists`);
        error.code = 'PIG_FS_CONFLICT';
        throw error;
      }
      this.assertWriter(realm, session.actor);

      let entries = await this.currentCatalog(realm.id);
      if (session.baseCommitHash !== this.root.commitHash || session.baseCommitOffset !== this.commitOffset) {
        // Long streaming writes are allowed to be overtaken by unrelated small
        // commits. Rebase is safe when this exact target and the realm policy
        // are unchanged. Two concurrent writers of the same object conflict.
        if (realmPolicyDigest(session.baseRealm) !== realmPolicyDigest(realm)) {
          const error = new Error('PigFS realm policy changed while this write was in progress');
          error.code = 'PIG_FS_CONFLICT';
          throw error;
        }
        const realmKey = realm.protection === 'sealed' ? this.realmKeys.get(realm.id) ?? null : null;
        const baseEntries = await loadPigFsRealmCatalog(this.source, session.baseRealm, { realmKey });
        if (entryVersionFingerprint(baseEntries.get(session.path)) !== entryVersionFingerprint(entries.get(session.path))) {
          const error = new Error('PigFS target changed while this write was in progress');
          error.code = 'PIG_FS_CONFLICT';
          throw error;
        }
      }

      // Re-read after waiting for the commit lane so we always publish on top of
      // the latest compatible state.
      realm = this.root.realms[session.realmId];
      entries = await this.currentCatalog(realm.id);
      const timestamp = session.modifiedAt ?? Date.now();
      const actorId = session.actor?.publicRecord?.identityId ?? null;
      ensureParents(entries, session.path, timestamp, actorId, this.root.generation + 1);
      const previous = entries.get(session.path);
      entries.set(session.path, {
        objectId: previous?.objectId ?? crypto.randomUUID(),
        path: session.path,
        name: entryName(session.path),
        type: 'file',
        size: session.size,
        mime: session.mime,
        createdAt: previous?.createdAt ?? session.createdAt ?? timestamp,
        modifiedAt: timestamp,
        revision: (previous?.revision ?? 0) + 1,
        modifiedBy: actorId,
        modifiedGeneration: this.root.generation + 1,
        contentSha256: session.contentHash.digest('hex'),
        mapPages: []
      });
      const nextRoot = clone(this.root);
      nextRoot.identities = this.identityRegistryWith(session.actor?.publicRecord);
      nextRoot.realms[realm.id] = await this.buildRealmWithCatalog(realm, entries, new Map([[session.path, session.chunks]]), this.root.generation + 1, this.commitOffset);
      const result = await this.commitRoot(nextRoot, session.actor, [{ type: 'write', realm: realm.id, path: session.path, revision: entries.get(session.path).revision }]);
      this.sessions.delete(String(id));
      this.emitWatch({ type: previous ? 'modified' : 'created', path: pigFsRealmPublicPath(realm, session.path), realm: realm.id, objectId: entries.get(session.path).objectId, generation: this.root.generation });
      return { ...result, entry: { ...clone(entries.get(session.path)), path: pigFsRealmPublicPath(realm, session.path), realm: realm.id } };
    });
  }

  async mkdir(fsPath, { actor = null, recursive = true } = {}) {
    const { realmId, path } = resolvePigFsPath(this.root, fsPath, { allowRealmRoot: false });
    const realm = this.root.realms[realmId];
    if (!realm) throw new Error(`Unknown PigFS realm ${realmId}`);
    this.assertWriter(realm, actor);
    const entries = await this.currentCatalog(realmId);
    if (entries.has(path)) {
      if (entries.get(path).type !== 'directory') throw new Error('PigFS path already exists as a file');
      return clone(entries.get(path));
    }
    const actorId = actor?.publicRecord?.identityId ?? null;
    const timestamp = Date.now();
    if (recursive) ensureParents(entries, path, timestamp, actorId, this.root.generation + 1);
    else {
      const parent = path.split('/').slice(0, -1).join('/');
      if (parent && !entries.has(parent)) throw new Error('PigFS parent directory does not exist');
    }
    entries.set(path, { objectId: crypto.randomUUID(), path, name: entryName(path), type: 'directory', size: 0, mime: null, createdAt: timestamp, modifiedAt: timestamp, revision: 1, modifiedBy: actorId, modifiedGeneration: this.root.generation + 1 });
    const nextRoot = clone(this.root);
    nextRoot.identities = this.identityRegistryWith(actor?.publicRecord);
    nextRoot.realms[realmId] = await this.buildRealmWithCatalog(realm, entries, new Map(), this.root.generation + 1, this.commitOffset);
    await this.commitRoot(nextRoot, actor, [{ type: 'mkdir', realm: realmId, path }]);
    this.emitWatch({ type: 'created', path: pigFsRealmPublicPath(realm, path), realm: realmId, objectId: entries.get(path).objectId, generation: this.root.generation });
    return { ...clone(entries.get(path)), path: pigFsRealmPublicPath(realm, path), realm: realmId };
  }

  async remove(fsPath, { actor = null, recursive = false } = {}) {
    const { realmId, path } = resolvePigFsPath(this.root, fsPath, { allowRealmRoot: false });
    const realm = this.root.realms[realmId];
    if (!realm) throw new Error(`Unknown PigFS realm ${realmId}`);
    this.assertWriter(realm, actor);
    const entries = await this.currentCatalog(realmId);
    const target = entries.get(path);
    if (!target) return false;
    if (target.type === 'directory') {
      const children = [...entries.keys()].filter((key) => key.startsWith(`${path}/`));
      if (children.length && !recursive) throw new Error('PigFS directory is not empty');
      for (const child of children) entries.delete(child);
    }
    entries.delete(path);
    const nextRoot = clone(this.root);
    nextRoot.identities = this.identityRegistryWith(actor?.publicRecord);
    nextRoot.realms[realmId] = await this.buildRealmWithCatalog(realm, entries, new Map(), this.root.generation + 1, this.commitOffset);
    await this.commitRoot(nextRoot, actor, [{ type: 'remove', realm: realmId, path, recursive: Boolean(recursive) }]);
    this.emitWatch({ type: 'deleted', path: pigFsRealmPublicPath(realm, path), realm: realmId, objectId: target.objectId ?? null, generation: this.root.generation });
    return true;
  }

  async rename(fromPath, toPath, { actor = null } = {}) {
    const from = resolvePigFsPath(this.root, fromPath, { allowRealmRoot: false });
    const to = resolvePigFsPath(this.root, toPath, { allowRealmRoot: false });
    if (from.realmId !== to.realmId) {
      const error = new Error('PigFS cross-realm rename is not supported; copy into the target realm and remove the source instead');
      error.code = 'PIG_FS_CROSS_REALM';
      throw error;
    }
    if (from.path === to.path) return this.stat(fromPath);
    if (to.path.startsWith(`${from.path}/`)) throw new Error('Cannot move a PigFS directory inside itself');
    const realm = this.root.realms[from.realmId];
    if (!realm) throw new Error(`Unknown PigFS realm ${from.realmId}`);
    this.assertWriter(realm, actor);
    const entries = await this.currentCatalog(from.realmId);
    const source = entries.get(from.path);
    if (!source) return null;
    if (entries.has(to.path)) throw new Error('PigFS destination already exists');
    const actorId = actor?.publicRecord?.identityId ?? null;
    const timestamp = Date.now();
    ensureParents(entries, to.path, timestamp, actorId, this.root.generation + 1);

    const moving = [...entries.entries()]
      .filter(([path]) => path === from.path || path.startsWith(`${from.path}/`))
      .sort((a, b) => a[0].length - b[0].length);
    for (const [oldPath] of moving) entries.delete(oldPath);
    for (const [oldPath, entry] of moving) {
      const suffix = oldPath === from.path ? '' : oldPath.slice(from.path.length + 1);
      const newPath = suffix ? `${to.path}/${suffix}` : to.path;
      if (entries.has(newPath)) throw new Error(`PigFS rename collides with existing path ${newPath}`);
      entries.set(newPath, {
        ...entry,
        path: newPath,
        name: entryName(newPath),
        modifiedAt: timestamp,
        revision: Number(entry.revision ?? 0) + 1,
        modifiedBy: actorId,
        modifiedGeneration: this.root.generation + 1
      });
    }
    const nextRoot = clone(this.root);
    nextRoot.identities = this.identityRegistryWith(actor?.publicRecord);
    nextRoot.realms[from.realmId] = await this.buildRealmWithCatalog(realm, entries, new Map(), this.root.generation + 1, this.commitOffset);
    await this.commitRoot(nextRoot, actor, [{ type: 'rename', realm: from.realmId, from: from.path, to: to.path }]);
    this.emitWatch({ type: 'renamed', path: pigFsRealmPublicPath(realm, to.path), from: pigFsRealmPublicPath(realm, from.path), realm: from.realmId, objectId: entries.get(to.path).objectId ?? null, generation: this.root.generation });
    return { ...clone(entries.get(to.path)), path: pigFsRealmPublicPath(realm, to.path), realm: from.realmId };
  }

  async grant(realmId, identityRecord, capabilities = {}, { actor } = {}) {
    const id = normalizePigFsRealmId(realmId);
    const realm = this.root.realms[id];
    if (!realm) throw new Error(`Unknown PigFS realm ${id}`);
    const governance = pigFsRealmGovernance(realm);
    if (governance !== 'shared') {
      const error = new Error(`PigFS ${governance} realm ${id} is not shareable`);
      error.code = 'PIG_FS_NOT_SHAREABLE';
      throw error;
    }
    const actorId = actor?.publicRecord?.identityId ?? null;
    if (!realmAdmin(this.root, realm, actorId)) {
      const error = new Error(`Identity is not allowed to administer realm ${id}`);
      error.code = 'PIG_FS_FORBIDDEN';
      throw error;
    }
    const target = verifyWursterIdentityRecord(identityRecord);
    if (!target.valid) throw new Error(`Invalid target Wurster Identity: ${target.error}`);
    const targetId = identityRecord.identityId;
    const nextRoot = clone(this.root);
    nextRoot.identities = this.identityRegistryWith(identityRecord, actor?.publicRecord);
    const nextRealm = nextRoot.realms[id];
    const readIds = new Set(nextRealm.access.read.identities ?? []);
    const writeIds = new Set(nextRealm.access.write.identities ?? []);
    const adminIds = new Set(nextRealm.access.admins ?? []);
    if (capabilities.read === true && nextRealm.access.read.mode === 'members') readIds.add(targetId);
    if (capabilities.write === true) {
      if (nextRealm.access.write.mode !== 'members') throw new Error('Explicit writer grants require members write mode');
      writeIds.add(targetId);
      if (nextRealm.protection === 'sealed') readIds.add(targetId);
    }
    if (capabilities.admin === true) {
      adminIds.add(targetId);
      if (nextRealm.protection === 'sealed') {
        readIds.add(targetId);
        if (nextRealm.access.write.mode === 'members') writeIds.add(targetId);
      }
    }
    nextRealm.access = normalizePigFsRealmAccess({
      read: { ...nextRealm.access.read, identities: [...readIds] },
      write: { ...nextRealm.access.write, identities: [...writeIds] },
      admins: [...adminIds]
    }, nextRealm.protection);
    if (nextRealm.protection === 'sealed' && readIds.has(targetId) && !nextRealm.keyWraps.some((wrap) => wrap.recipient === targetId)) {
      const key = this.realmKeys.get(id);
      if (!key) {
        const error = new Error(`Realm ${id} must be unlocked to grant read access`);
        error.code = 'PIG_FS_LOCKED';
        throw error;
      }
      nextRealm.keyWraps.push(wrapKeyForWursterIdentity(key, identityRecord, { realmId: id }));
      nextRealm.keyWraps.sort((a, b) => a.recipient.localeCompare(b.recipient));
    }
    await this.commitRoot(nextRoot, actor, [{ type: 'grant', realm: id, identity: targetId, capabilities: { read: Boolean(capabilities.read), write: Boolean(capabilities.write), admin: Boolean(capabilities.admin) } }]);
    return pigFsRealmCapabilities(this.root.realms[id], targetId, { signedIdentity: true });
  }

  async rekeyRealm(realmId, { actor, removeReaders = [] } = {}) {
    const id = normalizePigFsRealmId(realmId);
    const realm = this.root.realms[id];
    if (!realm) throw new Error(`Unknown PigFS realm ${id}`);
    const governance = pigFsRealmGovernance(realm);
    if (governance !== 'shared') {
      const error = new Error(`PigFS ${governance} realm ${id} is not shareable`);
      error.code = 'PIG_FS_NOT_SHAREABLE';
      throw error;
    }
    if (realm.protection !== 'sealed') throw new Error('Only sealed PigFS realms have encryption keys to rotate');
    const actorId = actor?.publicRecord?.identityId ?? null;
    if (!realmAdmin(this.root, realm, actorId)) {
      const error = new Error(`Identity is not allowed to administer realm ${id}`);
      error.code = 'PIG_FS_FORBIDDEN';
      throw error;
    }
    const oldKey = this.realmKeys.get(id);
    if (!oldKey) {
      const error = new Error(`Realm ${id} must be unlocked before rekeying`);
      error.code = 'PIG_FS_LOCKED';
      throw error;
    }
    const remove = new Set(normalizeIdentityIds(removeReaders));
    if (remove.has(actorId) && realm.access.admins.length === 1 && realm.access.admins[0] === actorId) {
      throw new Error('The last active realm admin cannot remove their own read access during rekey');
    }
    const entries = await loadPigFsRealmCatalog(this.source, realm, { realmKey: oldKey });
    const generation = this.root.generation + 1;
    const newKey = crypto.randomBytes(32);
    const nextRoot = clone(this.root);
    nextRoot.identities = this.identityRegistryWith(actor?.publicRecord);
    const nextRealm = nextRoot.realms[id];
    nextRealm.access.read.identities = nextRealm.access.read.identities.filter((value) => !remove.has(value));
    if (nextRealm.access.write.mode === 'members') nextRealm.access.write.identities = nextRealm.access.write.identities.filter((value) => !remove.has(value));
    nextRealm.access.admins = nextRealm.access.admins.filter((value) => !remove.has(value));
    nextRealm.access = normalizePigFsRealmAccess(nextRealm.access, 'sealed');
    nextRealm.keyWraps = nextRealm.access.read.identities.map((readerId) => {
      const identity = nextRoot.identities[readerId];
      if (!identity) throw new Error(`Cannot rekey realm ${id}; missing Identity ${readerId}`);
      return wrapKeyForWursterIdentity(newKey, identity, { realmId: id });
    }).sort((a, b) => a.recipient.localeCompare(b.recipient));

    const changedMaps = new Map();
    try {
      for (const [entryPath, entry] of entries) {
        if (entry.type !== 'file') continue;
        const oldChunks = await loadPigFsRealmChunks(this.source, realm, entry, oldKey);
        const newChunks = [];
        for (let index = 0; index < oldChunks.length; index += 1) {
          const chunk = oldChunks[index];
          const record = await readFsRecord(this.source, chunk.recordOffset);
          if (record.type !== PIG_FS_RECORD.DATA) throw new Error('PigFS rekey found a non-data chunk');
          let plain = record.payload;
          if (!chunk.encryption) throw new Error(`Sealed realm ${id} contains plaintext data during rekey`);
          plain = openRealmBytes(oldKey, plain, chunk.encryption, chunk.aad);
          const aad = `wurst-fs2-rekey:${id}:${generation}:${entryPath}:${index}`;
          const sealed = sealRealmBytes(newKey, plain, aad);
          const appended = await this.appendRecord(PIG_FS_RECORD.DATA, sealed.data, this.commitOffset ?? 0);
          newChunks.push({
            plainOffset: chunk.plainOffset,
            plainLength: plain.length,
            recordOffset: appended.recordStart,
            storedLength: sealed.data.length,
            plainSha256: null,
            encryption: sealed.encryption,
            aad
          });
        }
        changedMaps.set(entryPath, newChunks);
      }
      this.realmKeys.set(id, newKey);
      nextRoot.realms[id] = await this.buildRealmWithCatalog(nextRealm, entries, changedMaps, generation, this.commitOffset);
      const result = await this.commitRoot(nextRoot, actor, [{ type: 'rekey', realm: id, removedReaders: [...remove].sort() }]);
      oldKey.fill(0);
      return { ...result, realm: clone(this.root.realms[id]), removedReaders: [...remove].sort() };
    } catch (error) {
      this.realmKeys.set(id, oldKey);
      newKey.fill(0);
      throw error;
    }
  }

  async revoke(realmId, identityId, capabilities = {}, { actor } = {}) {
    const id = normalizePigFsRealmId(realmId);
    const realm = this.root.realms[id];
    if (!realm) throw new Error(`Unknown PigFS realm ${id}`);
    const governance = pigFsRealmGovernance(realm);
    if (governance !== 'shared') {
      const error = new Error(`PigFS ${governance} realm ${id} is not shareable`);
      error.code = 'PIG_FS_NOT_SHAREABLE';
      throw error;
    }
    const actorId = actor?.publicRecord?.identityId ?? null;
    if (!realmAdmin(this.root, realm, actorId)) {
      const error = new Error(`Identity is not allowed to administer realm ${id}`);
      error.code = 'PIG_FS_FORBIDDEN';
      throw error;
    }
    const targetId = String(identityId ?? '');
    if (realm.protection === 'sealed' && capabilities.read === true && realm.access.read.identities.includes(targetId)) {
      const error = new Error('Revoking read access to a sealed realm requires realm rekeying so the current snapshot is re-encrypted');
      error.code = 'PIG_FS_REKEY_REQUIRED';
      throw error;
    }
    const nextRoot = clone(this.root);
    nextRoot.identities = this.identityRegistryWith(actor?.publicRecord);
    const nextRealm = nextRoot.realms[id];
    if (capabilities.write === true && nextRealm.access.write.mode === 'members') nextRealm.access.write.identities = nextRealm.access.write.identities.filter((value) => value !== targetId);
    if (capabilities.admin === true) nextRealm.access.admins = nextRealm.access.admins.filter((value) => value !== targetId);
    nextRealm.access = normalizePigFsRealmAccess(nextRealm.access, nextRealm.protection);
    await this.commitRoot(nextRoot, actor, [{ type: 'revoke', realm: id, identity: targetId, capabilities: { read: false, write: Boolean(capabilities.write), admin: Boolean(capabilities.admin) } }]);
    return pigFsRealmCapabilities(this.root.realms[id], targetId, { signedIdentity: true });
  }

  async stat(fsPath) {
    const parsed = resolvePigFsPath(this.root, fsPath, { allowRealmRoot: true });
    return statPigFsEntry(this.source, this.root, fsPath, { realmKey: this.realmKeys.get(parsed.realmId) ?? null });
  }

  async list(fsPath = '/') {
    return listPigFsDirectory(this.source, this.root, fsPath, { realmKeys: this.realmKeys });
  }

  async read(fsPath, { offset = 0, length = null } = {}) {
    const parsed = resolvePigFsPath(this.root, fsPath, { allowRealmRoot: false });
    return readPigFsRange(this.source, this.root, fsPath, offset, length, { realmKey: this.realmKeys.get(parsed.realmId) ?? null });
  }

  watch(path = '/', listener) {
    if (typeof listener !== 'function') throw new TypeError('PigFS watch requires a listener');
    const rootPath = normalizePigFsPath(path);
    const id = crypto.randomUUID();
    this.watchers.set(id, { path: rootPath, listener });
    return () => this.watchers.delete(id);
  }

  emitWatch(event) {
    for (const watcher of this.watchers.values()) {
      if (watcher.path !== '/' && event.path !== watcher.path && !event.path.startsWith(`${watcher.path}/`) && event.from !== watcher.path && !String(event.from ?? '').startsWith(`${watcher.path}/`)) continue;
      try { watcher.listener({ format: 'wurst/pigfs-event-1', ...clone(event) }); } catch {}
    }
  }

  async object(objectId) {
    const id = String(objectId ?? '').replace(/^pigfs:\/\/object\//, '');
    for (const realm of Object.values(this.root?.realms ?? {})) {
      const catalog = await this.currentCatalog(realm.id);
      for (const entry of catalog.values()) if (entry.objectId === id) return { ...clone(entry), realm: realm.id, path: pigFsRealmPublicPath(realm, entry.path), handle: `pigfs://object/${id}` };
    }
    return null;
  }

  async readlink(fsPath) {
    const entry = await this.stat(fsPath);
    if (!entry || entry.type !== 'symlink') return null;
    return entry.target;
  }

  async symlink(targetPath, linkPath, { actor = null } = {}) {
    const target = resolvePigFsPath(this.root, targetPath, { allowRealmRoot: false });
    const link = resolvePigFsPath(this.root, linkPath, { allowRealmRoot: false });
    if (target.realmId !== link.realmId) { const error = new Error('PigFS symlinks cannot cross realm boundaries'); error.code = 'PIG_FS_CROSS_REALM'; throw error; }
    const realm = this.root.realms[link.realmId];
    this.assertWriter(realm, actor);
    const entries = await this.currentCatalog(link.realmId);
    if (entries.has(link.path)) throw new Error('PigFS symlink destination already exists');
    const actorId = actor?.publicRecord?.identityId ?? null, now = Date.now();
    ensureParents(entries, link.path, now, actorId, this.root.generation + 1);
    entries.set(link.path, { objectId: crypto.randomUUID(), path: link.path, name: entryName(link.path), type: 'symlink', target: pigFsRealmPublicPath(realm, target.path), size: 0, mime: null, createdAt: now, modifiedAt: now, revision: 1, modifiedBy: actorId, modifiedGeneration: this.root.generation + 1 });
    const nextRoot = clone(this.root); nextRoot.identities = this.identityRegistryWith(actor?.publicRecord);
    nextRoot.realms[realm.id] = await this.buildRealmWithCatalog(realm, entries, new Map(), this.root.generation + 1, this.commitOffset);
    await this.commitRoot(nextRoot, actor, [{ type: 'symlink', realm: realm.id, path: link.path, target: target.path }]);
    const result = { ...clone(entries.get(link.path)), realm: realm.id, path: pigFsRealmPublicPath(realm, link.path) };
    this.emitWatch({ type: 'created', path: result.path, realm: realm.id, objectId: result.objectId, generation: this.root.generation });
    return result;
  }

  async snapshot(fsPath = '/') {
    const path = normalizePigFsPath(fsPath);
    const entries = [];
    for (const realm of Object.values(this.root?.realms ?? {}).sort((a,b)=>a.mount.localeCompare(b.mount))) {
      if (path !== '/' && path !== realm.mount && !path.startsWith(`${realm.mount}/`) && !realm.mount.startsWith(`${path}/`)) continue;
      const catalog = await this.currentCatalog(realm.id);
      for (const entry of catalog.values()) {
        const publicPath = pigFsRealmPublicPath(realm, entry.path);
        if (path !== '/' && publicPath !== path && !publicPath.startsWith(`${path}/`)) continue;
        entries.push({ path: publicPath, objectId: entry.objectId ?? null, type: entry.type, size: Number(entry.size ?? 0), contentSha256: entry.contentSha256 ?? null, target: entry.target ?? null, realm: realm.id });
      }
    }
    entries.sort((a,b)=>a.path.localeCompare(b.path));
    const digest = `sha256:${hashJson(entries)}`;
    return { format: 'wurst/pigfs-snapshot-1', path, generation: this.root?.generation ?? 0, digest, objects: entries.length, logicalBytes: entries.filter(e=>e.type==='file').reduce((s,e)=>s+e.size,0), entries };
  }

  beginTransaction({ actor = null } = {}) {
    if (!this.root) throw new Error('PigFS is not initialized');
    const id = crypto.randomUUID();
    this.transactions.set(id, { id, actor, baseCommitHash: this.root.commitHash, baseCommitOffset: this.commitOffset, operations: [] });
    return id;
  }

  transactionWrite(id, path, data, options = {}) { const tx = this.transactions.get(String(id)); if (!tx) throw new Error('Unknown PigFS transaction'); tx.operations.push({ type:'write', path:normalizePigFsPath(path,{allowRoot:false}), data:Buffer.from(data ?? []), mime:String(options.mime||'application/octet-stream') }); return tx.operations.length; }
  transactionMkdir(id, path) { const tx=this.transactions.get(String(id)); if(!tx)throw new Error('Unknown PigFS transaction'); tx.operations.push({type:'mkdir',path:normalizePigFsPath(path,{allowRoot:false})}); }
  transactionRemove(id, path, options={}) { const tx=this.transactions.get(String(id)); if(!tx)throw new Error('Unknown PigFS transaction'); tx.operations.push({type:'remove',path:normalizePigFsPath(path,{allowRoot:false}),recursive:Boolean(options.recursive)}); }
  transactionRename(id, from, to) { const tx=this.transactions.get(String(id)); if(!tx)throw new Error('Unknown PigFS transaction'); tx.operations.push({type:'rename',from:normalizePigFsPath(from,{allowRoot:false}),to:normalizePigFsPath(to,{allowRoot:false})}); }
  abortTransaction(id) { return this.transactions.delete(String(id)); }

  async commitTransaction(id) {
    return this.withMutationLock(async () => {
      const tx=this.transactions.get(String(id)); if(!tx)throw new Error('Unknown PigFS transaction');
      if(tx.baseCommitHash!==this.root.commitHash||tx.baseCommitOffset!==this.commitOffset){const e=new Error('PigFS changed while transaction was open');e.code='PIG_FS_CONFLICT';throw e;}
      const actor=tx.actor, actorId=actor?.publicRecord?.identityId??null, generation=this.root.generation+1, now=Date.now();
      const catalogs=new Map(), changedMaps=new Map(), touched=new Set(), events=[];
      const getCatalog=async(realm)=>{if(!catalogs.has(realm.id))catalogs.set(realm.id,await this.currentCatalog(realm.id));return catalogs.get(realm.id)};
      for(const op of tx.operations){
        if(op.type==='write'){
          const r=resolvePigFsPath(this.root,op.path,{allowRealmRoot:false}), realm=this.root.realms[r.realmId]; this.assertWriter(realm,actor); const entries=await getCatalog(realm); ensureParents(entries,r.path,now,actorId,generation); const prev=entries.get(r.path); const chunks=[]; let offset=0; const bytes=op.data;
          for(let pos=0;pos<bytes.length||(!bytes.length&&pos===0);pos+=PIG_FS_DEFAULT_CHUNK_SIZE){const part=bytes.subarray(pos,Math.min(bytes.length,pos+PIG_FS_DEFAULT_CHUNK_SIZE)); if(!bytes.length&&pos===0&&part.length===0)break; const aad=`pigfs-tx-data:${realm.id}:${generation}:${r.path}:${chunks.length}`; let stored=part,encryption=null;if(realm.protection==='sealed'){const sealed=sealRealmBytes(this.realmKeys.get(realm.id),part,aad);stored=sealed.data;encryption=sealed.encryption;} const appended=await this.appendRecord(PIG_FS_RECORD.DATA,stored,this.commitOffset??0);chunks.push({plainOffset:offset,plainLength:part.length,recordOffset:appended.recordStart,storedLength:stored.length,plainSha256:realm.protection==='sealed'?null:sha256(part),encryption,aad:encryption?aad:null});offset+=part.length;}
          entries.set(r.path,{objectId:prev?.objectId??crypto.randomUUID(),path:r.path,name:entryName(r.path),type:'file',size:bytes.length,mime:op.mime,createdAt:prev?.createdAt??now,modifiedAt:now,revision:(prev?.revision??0)+1,modifiedBy:actorId,modifiedGeneration:generation,contentSha256:sha256(bytes),mapPages:[]}); changedMaps.set(`${realm.id}\0${r.path}`,chunks); touched.add(realm.id); events.push({type:prev?'modified':'created',path:op.path,realm:realm.id,objectId:entries.get(r.path).objectId});
        } else if(op.type==='mkdir'){
          const r=resolvePigFsPath(this.root,op.path,{allowRealmRoot:false}),realm=this.root.realms[r.realmId];this.assertWriter(realm,actor);const entries=await getCatalog(realm);ensureParents(entries,r.path,now,actorId,generation);if(!entries.has(r.path))entries.set(r.path,{objectId:crypto.randomUUID(),path:r.path,name:entryName(r.path),type:'directory',size:0,mime:null,createdAt:now,modifiedAt:now,revision:1,modifiedBy:actorId,modifiedGeneration:generation});touched.add(realm.id);events.push({type:'created',path:op.path,realm:realm.id,objectId:entries.get(r.path).objectId});
        } else if(op.type==='remove'){
          const r=resolvePigFsPath(this.root,op.path,{allowRealmRoot:false}),realm=this.root.realms[r.realmId];this.assertWriter(realm,actor);const entries=await getCatalog(realm),target=entries.get(r.path);if(target){const kids=[...entries.keys()].filter(k=>k.startsWith(`${r.path}/`));if(kids.length&&!op.recursive)throw new Error('PigFS directory is not empty');for(const k of kids)entries.delete(k);entries.delete(r.path);events.push({type:'deleted',path:op.path,realm:realm.id,objectId:target.objectId??null});}touched.add(realm.id);
        } else if(op.type==='rename'){
          const a=resolvePigFsPath(this.root,op.from,{allowRealmRoot:false}),b=resolvePigFsPath(this.root,op.to,{allowRealmRoot:false});if(a.realmId!==b.realmId){const e=new Error('PigFS cross-realm rename is not supported');e.code='PIG_FS_CROSS_REALM';throw e;}const realm=this.root.realms[a.realmId];this.assertWriter(realm,actor);const entries=await getCatalog(realm),src=entries.get(a.path);if(!src)continue;if(entries.has(b.path))throw new Error('PigFS destination already exists');ensureParents(entries,b.path,now,actorId,generation);const moving=[...entries.entries()].filter(([p])=>p===a.path||p.startsWith(`${a.path}/`)).sort((x,y)=>x[0].length-y[0].length);for(const [p]of moving)entries.delete(p);for(const [p,e]of moving){const suffix=p===a.path?'':p.slice(a.path.length+1),np=suffix?`${b.path}/${suffix}`:b.path;entries.set(np,{...e,path:np,name:entryName(np),modifiedAt:now,revision:Number(e.revision??0)+1,modifiedBy:actorId,modifiedGeneration:generation});}touched.add(realm.id);events.push({type:'renamed',from:op.from,path:op.to,realm:realm.id,objectId:src.objectId??null});
        }
      }
      const nextRoot=clone(this.root);nextRoot.identities=this.identityRegistryWith(actor?.publicRecord);
      for(const realmId of touched){const realm=this.root.realms[realmId],maps=new Map();for(const [k,v]of changedMaps){const [rid,path]=k.split('\0');if(rid===realmId)maps.set(path,v);}nextRoot.realms[realmId]=await this.buildRealmWithCatalog(realm,catalogs.get(realmId),maps,generation,this.commitOffset);}
      const result=await this.commitRoot(nextRoot,actor,tx.operations.map(op=>({...op,data:undefined})));this.transactions.delete(String(id));for(const event of events)this.emitWatch({...event,generation:this.root.generation});return {...result,operations:tx.operations.length};
    });
  }

  async history() {
    return verifyPigFsHistory(this.source, this.baseOffset);
  }

  close() {
    for (const key of this.realmKeys.values()) key.fill(0);
    this.realmKeys.clear();
    this.sessions.clear();
    this.transactions.clear();
    this.watchers.clear();
  }
}

export async function openPigFsBytes(buffer, baseOffset) {
  const backing = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const source = {
    size: backing.length,
    async read(offset, length) {
      const start = assertSafeOffset(offset, 'PigFS buffer read offset');
      const count = assertSafeOffset(length, 'PigFS buffer read length');
      if (start + count > this.size) throw new Error('PigFS buffer read exceeds source');
      return Buffer.from(backing.subarray(start, start + count));
    }
  };
  return verifyPigFsHistory(source, baseOffset);
}

export async function createMemoryPigFsStore(baseBytes = Buffer.alloc(0)) {
  let bytes = Buffer.isBuffer(baseBytes) ? Buffer.from(baseBytes) : Buffer.from(baseBytes ?? []);
  const source = {
    size: bytes.length,
    async read(offset, length) {
      const start = assertSafeOffset(offset, 'PigFS memory read offset');
      const count = assertSafeOffset(length, 'PigFS memory read length');
      if (start + count > bytes.length) throw new Error('PigFS memory read exceeds source');
      return Buffer.from(bytes.subarray(start, start + count));
    }
  };
  const store = new PigFsStore({
    source,
    baseOffset: bytes.length,
    append: async (chunk) => { bytes = Buffer.concat([bytes, Buffer.from(chunk)]); source.size = bytes.length; },
    sync: async () => {}
  });
  await store.init();
  return { store, bytes: () => Buffer.from(bytes), source };
}

export const PIG_FS_CHUNK_SIZE = PIG_FS_DEFAULT_CHUNK_SIZE;
