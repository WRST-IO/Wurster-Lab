import crypto from 'node:crypto';
import {
  PIG_FS_MAX_RECORD_PAYLOAD,
  PIG_FS_RECORD,
  locateLatestRecord,
  makeFsRecord,
  readFsRecord
} from './pig-fs-records.js';

export const WURST_OBJECT_STORE_FORMAT = 'wurst/object-store-1';
export const WURST_OBJECT_FORMAT = 'wurst/object-1';
export const WURST_BASE_BLOB_FORMAT = 'wurst/base-blob-1';
export const WURST_RELATIONSHIP_FORMAT = 'wurst/object-relationship-1';
export const WURST_INDEX_PAGE_FORMAT = 'wurst/object-index-page-1';
export const WURST_OBJECT_TX_FORMAT = 'wurst/object-transaction-1';
export const WURST_MAX_PIGLET_DEPTH = 64;

const INDEX_MAX_ITEMS = 32;
const DATA_CHUNK = Math.min(4 * 1024 * 1024, PIG_FS_MAX_RECORD_PAYLOAD);

function clone(value) { return value == null ? value : structuredClone(value); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}
function canonical(value) { return JSON.stringify(sorted(value)); }
function hashJson(value) { return sha256(Buffer.from(canonical(value))); }
function safeInt(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid ${label}`);
  return number;
}
function objectKey(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 160 || id.includes('\u0000')) throw new Error('Invalid Wurst Object ID');
  return id;
}
function extentKey(offset) { return String(safeInt(offset, 'extent virtual offset')).padStart(20, '0'); }
function relationshipKey(parentId, childId) { return `${objectKey(parentId)}\u0000${objectKey(childId)}`; }
function actorAllowed(rule, actorId) {
  if (rule == null || rule === 'open') return true;
  const id = actorId == null ? null : String(actorId);
  const list = Array.isArray(rule) ? rule.map(String) : [String(rule)];
  return Boolean(id && list.includes(id));
}
function authorityError(operation, objectId) {
  const error = new Error(`Actor is not authorized to ${operation} Wurst object ${objectId}`);
  error.code = 'WURST_OBJECT_FORBIDDEN';
  return error;
}
function normalizeGovernance(value = null) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    state: clone(source.state ?? 'open'),
    relationship: clone(source.relationship ?? 'open'),
    delete: clone(source.delete ?? source.relationship ?? 'open'),
    upgrade: clone(source.upgrade ?? source.state ?? 'open')
  };
}
function pageType(indexName) {
  if (indexName === 'objects') return PIG_FS_RECORD.OBJECT_PAGE;
  if (indexName === 'bases') return PIG_FS_RECORD.BASE_PAGE;
  if (indexName.startsWith('relationship:')) return PIG_FS_RECORD.RELATION_PAGE;
  if (indexName.startsWith('extent:')) return PIG_FS_RECORD.EXTENT_PAGE;
  throw new Error(`Unknown Wurst object index: ${indexName}`);
}
function rootStateProjection(root) {
  return {
    format: root.format,
    generation: root.generation,
    previousRootCommitOffset: root.previousRootCommitOffset ?? null,
    previousRootCommitHash: root.previousRootCommitHash ?? null,
    arenaTail: root.arenaTail,
    rootObjectId: root.rootObjectId,
    objectTableRoot: root.objectTableRoot ?? null,
    relationshipByParentRoot: root.relationshipByParentRoot ?? null,
    relationshipByChildRoot: root.relationshipByChildRoot ?? null,
    baseIndexRoot: root.baseIndexRoot ?? null
  };
}
function computeRootStateHash(root) { return hashJson(rootStateProjection(root)); }
function computeRootCommitHash(root) { return hashJson({ stateHash: root.stateHash, authorization: root.authorization ?? null }); }

class PersistentCowIndex {
  constructor(store, indexName) {
    this.store = store;
    this.indexName = indexName;
    this.type = pageType(indexName);
  }
  async _read(pointer) {
    if (!pointer) return null;
    const record = await readFsRecord(this.store.source, safeInt(pointer.recordOffset, 'index page offset'));
    if (record.type !== this.type) throw new Error(`Wurst object index ${this.indexName} points to the wrong record type`);
    const actual = sha256(record.payload);
    if (pointer.sha256 && actual !== pointer.sha256) throw new Error(`Wurst object index ${this.indexName} page hash mismatch`);
    let page;
    try { page = JSON.parse(record.payload.toString('utf8')); } catch { throw new Error(`Invalid Wurst object index page: ${this.indexName}`); }
    if (page?.format !== WURST_INDEX_PAGE_FORMAT || page.index !== this.indexName || !['leaf', 'branch'].includes(page.kind)) throw new Error(`Invalid Wurst object index page shape: ${this.indexName}`);
    return page;
  }
  async _write(page) {
    const body = Buffer.from(canonical(page));
    const appended = await this.store.appendRecord(this.type, body);
    const first = page.kind === 'leaf' ? page.entries[0]?.[0] ?? '' : page.children[0]?.first ?? '';
    const last = page.kind === 'leaf' ? page.entries.at(-1)?.[0] ?? '' : page.children.at(-1)?.last ?? '';
    const count = page.kind === 'leaf' ? page.entries.length : page.children.reduce((sum, item) => sum + Number(item.count ?? 0), 0);
    return { recordOffset: appended.recordStart, sha256: sha256(body), first, last, count, level: page.kind === 'leaf' ? 0 : Math.max(...page.children.map((item) => Number(item.level ?? 0))) + 1 };
  }
  _childIndex(children, key) {
    for (let index = 0; index < children.length; index += 1) if (key <= children[index].last) return index;
    return Math.max(0, children.length - 1);
  }
  async get(root, key) {
    let pointer = root;
    while (pointer) {
      const page = await this._read(pointer);
      if (page.kind === 'leaf') {
        const found = page.entries.find(([candidate]) => candidate === key);
        return found ? clone(found[1]) : null;
      }
      pointer = page.children[this._childIndex(page.children, key)] ?? null;
    }
    return null;
  }
  async floor(root, key) {
    let pointer = root;
    let best = null;
    while (pointer) {
      const page = await this._read(pointer);
      if (page.kind === 'leaf') {
        for (const entry of page.entries) {
          if (entry[0] > key) break;
          best = entry;
        }
        return best ? [best[0], clone(best[1])] : null;
      }
      let index = this._childIndex(page.children, key);
      while (index > 0 && page.children[index].first > key) index -= 1;
      pointer = page.children[index] ?? null;
    }
    return null;
  }
  async entries(root) {
    if (!root) return [];
    const page = await this._read(root);
    if (page.kind === 'leaf') return page.entries.map(([key, value]) => [key, clone(value)]);
    const result = [];
    for (const child of page.children) result.push(...await this.entries(child));
    return result;
  }
  async range(root, { gte = null, lt = null, limit = Infinity } = {}) {
    if (!root || limit <= 0) return [];
    const lower = gte == null ? null : String(gte);
    const upper = lt == null ? null : String(lt);
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
    const result = [];
    const visit = async (pointer) => {
      if (!pointer || result.length >= max) return;
      if (lower != null && pointer.last && pointer.last < lower) return;
      if (upper != null && pointer.first && pointer.first >= upper) return;
      const page = await this._read(pointer);
      if (page.kind === 'leaf') {
        for (const [key, value] of page.entries) {
          if (lower != null && key < lower) continue;
          if (upper != null && key >= upper) break;
          result.push([key, clone(value)]);
          if (result.length >= max) break;
        }
        return;
      }
      for (const child of page.children) {
        if (result.length >= max) break;
        if (lower != null && child.last && child.last < lower) continue;
        if (upper != null && child.first && child.first >= upper) break;
        await visit(child);
      }
    };
    await visit(root);
    return result;
  }
  async _set(pointer, key, value) {
    if (!pointer) return [await this._write({ format: WURST_INDEX_PAGE_FORMAT, index: this.indexName, kind: 'leaf', entries: [[key, clone(value)]] })];
    const page = await this._read(pointer);
    if (page.kind === 'leaf') {
      const entries = page.entries.map(([entryKey, entryValue]) => [entryKey, clone(entryValue)]);
      const found = entries.findIndex(([entryKey]) => entryKey === key);
      if (found >= 0) entries[found] = [key, clone(value)];
      else {
        const index = entries.findIndex(([entryKey]) => entryKey > key);
        entries.splice(index < 0 ? entries.length : index, 0, [key, clone(value)]);
      }
      if (entries.length <= INDEX_MAX_ITEMS) return [await this._write({ ...page, entries })];
      const middle = Math.ceil(entries.length / 2);
      return [
        await this._write({ format: WURST_INDEX_PAGE_FORMAT, index: this.indexName, kind: 'leaf', entries: entries.slice(0, middle) }),
        await this._write({ format: WURST_INDEX_PAGE_FORMAT, index: this.indexName, kind: 'leaf', entries: entries.slice(middle) })
      ];
    }
    const children = page.children.map(clone);
    const childIndex = this._childIndex(children, key);
    const replacement = await this._set(children[childIndex], key, value);
    children.splice(childIndex, 1, ...replacement);
    if (children.length <= INDEX_MAX_ITEMS) return [await this._write({ ...page, children })];
    const middle = Math.ceil(children.length / 2);
    return [
      await this._write({ format: WURST_INDEX_PAGE_FORMAT, index: this.indexName, kind: 'branch', children: children.slice(0, middle) }),
      await this._write({ format: WURST_INDEX_PAGE_FORMAT, index: this.indexName, kind: 'branch', children: children.slice(middle) })
    ];
  }
  async set(root, key, value) {
    const result = await this._set(root, String(key), value);
    if (result.length === 1) return result[0];
    return this._write({ format: WURST_INDEX_PAGE_FORMAT, index: this.indexName, kind: 'branch', children: result });
  }
  async _remove(pointer, key) {
    if (!pointer) return null;
    const page = await this._read(pointer);
    if (page.kind === 'leaf') {
      const entries = page.entries.filter(([entryKey]) => entryKey !== key);
      if (!entries.length) return null;
      if (entries.length === page.entries.length) return pointer;
      return this._write({ ...page, entries });
    }
    const children = page.children.map(clone);
    const index = this._childIndex(children, key);
    const next = await this._remove(children[index], key);
    if (!next) children.splice(index, 1); else children[index] = next;
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    return this._write({ ...page, children });
  }
  remove(root, key) { return this._remove(root, String(key)); }
}

export async function loadLatestWurstObjectRoot(source, baseOffset) {
  const base = safeInt(baseOffset, 'Wurst object store base offset');
  let end = source.size;
  while (end > base) {
    const prefix = end === source.size ? source : {
      size: end,
      async read(offset, length) {
        const start = safeInt(offset, 'Wurst object recovery offset');
        const wanted = safeInt(length, 'Wurst object recovery length');
        if (start + wanted > end) throw new Error('Wurst object recovery read exceeds candidate tail');
        return source.read(start, wanted);
      }
    };
    const located = await locateLatestRecord(prefix, base, { types: PIG_FS_RECORD.ROOT_COMMIT });
    if (!located) return { root: null, commitOffset: null };
    try {
      const record = await readFsRecord(prefix, located.recordStart);
      let root;
      try { root = JSON.parse(record.payload.toString('utf8')); } catch { throw new Error('Invalid Wurst object root commit JSON'); }
      if (root?.format !== WURST_OBJECT_STORE_FORMAT) throw new Error(`Unsupported Wurst object store format: ${root?.format ?? 'missing'}`);
      if (root.stateHash !== computeRootStateHash(root) || root.commitHash !== computeRootCommitHash(root)) throw new Error('Wurst object root commit integrity mismatch');
      return { root, commitOffset: located.recordStart };
    } catch {
      // A complete-looking but corrupt/unpublished tail record is still garbage.
      // Recovery walks backward until it finds the newest fully valid Root Commit.
      end = located.recordStart;
    }
  }
  return { root: null, commitOffset: null };
}

export class WurstObjectStore {
  constructor({ source, baseOffset, append, sync = async () => {}, appendRecord = null, maxDepth = WURST_MAX_PIGLET_DEPTH, verifyPublisherTransition = null } = {}) {
    if (!source || typeof source.read !== 'function' || !Number.isSafeInteger(source.size)) throw new Error('Wurst object store requires a random-access source');
    if (typeof append !== 'function' && typeof appendRecord !== 'function') throw new Error('Wurst object store requires append(bytes) or appendRecord()');
    this.source = source;
    this.baseOffset = safeInt(baseOffset, 'Wurst object store base offset');
    this.append = append;
    this.appendRecordImpl = appendRecord;
    this.sync = sync;
    this.maxDepth = Math.max(1, Math.min(256, Number(maxDepth) || WURST_MAX_PIGLET_DEPTH));
    this.verifyPublisherTransition = typeof verifyPublisherTransition === 'function' ? verifyPublisherTransition : null;
    this.root = null;
    this.commitOffset = null;
    this.nextOffset = source.size;
    this.sequence = 0;
    this.appendTail = Promise.resolve();
    this.mutationTail = Promise.resolve();
    this.transactions = new Map();
  }
  async init() {
    const loaded = await loadLatestWurstObjectRoot(this.source, this.baseOffset);
    this.root = loaded.root;
    this.commitOffset = loaded.commitOffset;
    this.nextOffset = this.source.size;
    return this;
  }
  index(name) { return new PersistentCowIndex(this, name); }
  async appendRecord(type, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? []);
    const task = this.appendTail.then(async () => {
      if (this.appendRecordImpl) {
        const result = await this.appendRecordImpl(type, body, { previousCommitOffset: this.commitOffset ?? 0, sequence: ++this.sequence });
        this.nextOffset = Math.max(this.nextOffset, Number(result.recordEnd ?? result.recordStart + body.length));
        this.source.size = Math.max(this.source.size, this.nextOffset);
        return { recordStart: result.recordStart, recordEnd: result.recordEnd ?? this.nextOffset, payloadLength: body.length };
      }
      const recordStart = this.nextOffset;
      const record = makeFsRecord(type, body, { recordStart, previousCommitOffset: this.commitOffset ?? 0, sequence: ++this.sequence });
      await this.append(record);
      this.nextOffset += record.length;
      this.source.size = this.nextOffset;
      return { recordStart, recordEnd: this.nextOffset, payloadLength: body.length };
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
    try { return await fn(); } finally { release(); }
  }
  async _commitRoot(nextRoot, { authorization = null, generation = null } = {}) {
    const root = clone(nextRoot);
    root.format = WURST_OBJECT_STORE_FORMAT;
    root.generation = generation == null ? Number(this.root?.generation ?? 0) + 1 : Math.max(1, Number(generation));
    root.previousRootCommitOffset = this.commitOffset ?? null;
    root.previousRootCommitHash = this.root?.commitHash ?? null;
    root.arenaTail = this.nextOffset;
    root.authorization = authorization == null ? null : clone(authorization);
    root.stateHash = computeRootStateHash(root);
    root.commitHash = computeRootCommitHash(root);
    const appended = await this.appendRecord(PIG_FS_RECORD.ROOT_COMMIT, Buffer.from(canonical(root)));
    await this.sync();
    this.root = root;
    this.commitOffset = appended.recordStart;
    return { root: clone(root), commitOffset: this.commitOffset };
  }
  async initializeHostRoot({ objectId = crypto.randomUUID(), applicationId = null, packageDigest = null, baseBlobHash = null, baseSize = this.baseOffset, virtualSize = this.baseOffset, stateRevision = 0, relationshipRevision = 0, stateHash = null, stateHead = null, publisher = null, governance = null } = {}) {
    if (this.root) return clone(await this.object(this.root.rootObjectId));
    const id = objectKey(objectId);
    let objectRoot = null;
    objectRoot = await this.index('objects').set(objectRoot, id, {
      format: WURST_OBJECT_FORMAT,
      objectId: id,
      hostRoot: true,
      applicationId: applicationId ?? null,
      packageDigest: packageDigest ?? null,
      baseBlobHash: baseBlobHash ?? null,
      baseSize: safeInt(baseSize, 'host root immutable base size'),
      virtualSize: safeInt(virtualSize, 'host root virtual size'),
      stateRevision: safeInt(stateRevision, 'host root state revision'),
      relationshipRevision: safeInt(relationshipRevision, 'host root relationship revision'),
      stateHash: stateHash ?? null,
      stateHead: stateHead == null ? null : safeInt(stateHead, 'host root state head'),
      extentRoot: null,
      governance: normalizeGovernance(governance),
      publisher: clone(publisher ?? null),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const nextRoot = {
      rootObjectId: id,
      objectTableRoot: objectRoot,
      relationshipByParentRoot: null,
      relationshipByChildRoot: null,
      baseIndexRoot: null
    };
    await this._commitRoot(nextRoot, { generation: 1 });
    return this.object(id);
  }
  async syncHostState({ stateRevision, stateHash = null, stateHead = null, virtualSize = null, actorId = null } = {}) {
    if (!this.root) throw new Error('Wurst object store is not initialized');
    return this.withMutationLock(async () => {
      const host = await this.object(this.root.rootObjectId);
      if (!host?.hostRoot) throw new Error('Wurst object store host root is missing');
      this._assertObjectAuthority(host, 'state', actorId);
      const next = clone(this.root);
      const updated = {
        ...host,
        stateRevision: stateRevision == null ? host.stateRevision : safeInt(stateRevision, 'host root state revision'),
        stateHash: stateHash ?? null,
        stateHead: stateHead == null ? null : safeInt(stateHead, 'host root state head'),
        virtualSize: virtualSize == null ? host.virtualSize : safeInt(virtualSize, 'host root virtual size'),
        updatedAt: Date.now()
      };
      next.objectTableRoot = await this.index('objects').set(next.objectTableRoot, host.objectId, updated);
      await this._commitRoot(next);
      return clone(updated);
    });
  }

  async object(rawId, root = this.root) {
    if (!root) return null;
    return this.index('objects').get(root.objectTableRoot, objectKey(rawId));
  }
  async objects({ liveOnly = false } = {}) {
    if (!this.root) return [];
    const all = (await this.index('objects').entries(this.root.objectTableRoot)).map(([, value]) => value);
    if (!liveOnly) return all;
    const live = new Set(await this.reachableObjectIds());
    return all.filter((item) => live.has(item.objectId));
  }
  async base(rawHash, root = this.root) {
    if (!root) return null;
    return this.index('bases').get(root.baseIndexRoot, String(rawHash));
  }
  async directChildren(parentId, root = this.root) {
    if (!root) return [];
    const parent = objectKey(parentId);
    const prefix = `${parent}\u0000`;
    // All direct-child keys occupy one contiguous prefix interval. Persistent
    // page bounds let this prune unrelated branches instead of scanning every
    // relationship in the Root Wurst.
    const entries = await this.index('relationship:parent').range(root.relationshipByParentRoot, {
      gte: prefix,
      lt: `${parent}\u0001`
    });
    return entries.map(([, value]) => clone(value));
  }
  async parentOf(childId, root = this.root) {
    if (!root) return null;
    return this.index('relationship:child').get(root.relationshipByChildRoot, objectKey(childId));
  }
  async reachableObjectIds(rootId = this.root?.rootObjectId, root = this.root) {
    if (!rootId || !root) return [];
    const result = [];
    const visited = new Set();
    const queue = [{ id: objectKey(rootId), depth: 0 }];
    while (queue.length) {
      const { id, depth } = queue.shift();
      if (visited.has(id)) throw new Error('Wurst object graph contains a cycle');
      if (depth > this.maxDepth) throw new Error(`Wurst object graph exceeds maximum Piglet depth ${this.maxDepth}`);
      visited.add(id); result.push(id);
      for (const relation of await this.directChildren(id, root)) queue.push({ id: relation.childObjectId, depth: depth + 1 });
    }
    return result;
  }
  async verifyGraph({ deep = true } = {}) {
    if (!this.root) return { valid: true, objects: 0, relationships: 0, maxDepth: 0 };
    const objects = await this.objects();
    const ids = new Set(objects.map((item) => item.objectId));
    if (!ids.has(this.root.rootObjectId)) throw new Error('Wurst object store root object is missing');
    const relations = (await this.index('relationship:parent').entries(this.root.relationshipByParentRoot)).map(([, value]) => value);
    for (const relation of relations) {
      if (!ids.has(relation.parentObjectId) || !ids.has(relation.childObjectId)) throw new Error('Wurst relationship references a missing object');
      const reverse = await this.parentOf(relation.childObjectId);
      if (!reverse || reverse.parentObjectId !== relation.parentObjectId) throw new Error('Wurst relationship indexes disagree');
    }
    let maxDepth = 0;
    if (deep) {
      const visited = new Set();
      const walk = async (id, depth) => {
        if (depth > this.maxDepth) throw new Error(`Wurst object graph exceeds maximum Piglet depth ${this.maxDepth}`);
        if (visited.has(id)) throw new Error('Wurst object graph contains a cycle');
        visited.add(id); maxDepth = Math.max(maxDepth, depth);
        for (const relation of await this.directChildren(id)) await walk(relation.childObjectId, depth + 1);
      };
      await walk(this.root.rootObjectId, 0);
    }
    return { valid: true, objects: objects.length, relationships: relations.length, maxDepth };
  }
  _assertObjectAuthority(object, operation, actorId) {
    if (!object) throw new Error('Unknown Wurst object');
    const rule = object.governance?.[operation] ?? 'open';
    if (!actorAllowed(rule, actorId)) throw authorityError(operation, object.objectId);
  }
  async _writeArenaData(bytes) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    const parts = [];
    for (let offset = 0; offset < data.length || (data.length === 0 && offset === 0); offset += DATA_CHUNK) {
      const chunk = data.subarray(offset, Math.min(data.length, offset + DATA_CHUNK));
      if (!chunk.length && data.length === 0) break;
      const record = await this.appendRecord(PIG_FS_RECORD.OBJECT_DATA, chunk);
      parts.push({ length: chunk.length, recordOffset: record.recordStart, sha256: sha256(chunk) });
    }
    return parts;
  }
  async _copySourceToExtents(source, start, length, indexName, root = null, virtualStart = start) {
    let extentRoot = root;
    let logical = 0;
    for (let offset = 0; offset < length; offset += DATA_CHUNK) {
      const wanted = Math.min(DATA_CHUNK, length - offset);
      const bytes = Buffer.from(await source.read(start + offset, wanted));
      if (bytes.length !== wanted) throw new Error('Wurst object source truncated while importing');
      const records = await this._writeArenaData(bytes);
      for (const record of records) {
        const virtualOffset = virtualStart + logical;
        extentRoot = await this.index(indexName).set(extentRoot, extentKey(virtualOffset), { virtualOffset, length: record.length, recordOffset: record.recordOffset, sha256: record.sha256 });
        logical += record.length;
      }
    }
    return extentRoot;
  }
  async _ensureBase(source, baseSize, baseBlobHash = null, root = this.root) {
    const size = safeInt(baseSize, 'Wurst immutable base size');
    const hasher = crypto.createHash('sha256');
    for (let offset = 0; offset < size; offset += DATA_CHUNK) hasher.update(await source.read(offset, Math.min(DATA_CHUNK, size - offset)));
    const hash = hasher.digest('hex');
    if (baseBlobHash && String(baseBlobHash).replace(/^sha256:/, '') !== hash) throw new Error('Wurst immutable base hash changed while importing');
    const id = `sha256:${hash}`;
    const existing = await this.base(id, root);
    if (existing) return { base: existing, baseIndexRoot: root?.baseIndexRoot ?? null };
    const extentRoot = await this._copySourceToExtents(source, 0, size, `extent:base:${id}`, null, 0);
    const base = { format: WURST_BASE_BLOB_FORMAT, baseBlobHash: id, size, extentRoot, createdAt: Date.now() };
    const baseIndexRoot = await this.index('bases').set(root?.baseIndexRoot ?? null, id, base);
    return { base, baseIndexRoot };
  }
  async promote({ parentObjectId = null, locator = null, source, baseSize, applicationId = null, packageDigest = null, publisher = null, objectId = null, stateRevision = 0, stateHash = null, stateHead = null, governance = null, actorId = null } = {}) {
    if (!this.root) throw new Error('Wurst object store is not initialized');
    if (!source || typeof source.read !== 'function' || !Number.isSafeInteger(source.size)) throw new Error('Wurst object promotion requires a range source');
    const parentId = parentObjectId == null ? this.root.rootObjectId : objectKey(parentObjectId);
    const parent = await this.object(parentId);
    if (!parent) throw new Error(`Unknown parent Wurst object ${parentId}`);
    this._assertObjectAuthority(parent, 'relationship', actorId);
    const existingRelations = await this.directChildren(parentId);
    if (locator != null) {
      const found = existingRelations.find((relation) => relation.locator === String(locator));
      if (found) return this.object(found.childObjectId);
    }
    const immutableSize = safeInt(baseSize, 'Wurst immutable base size');
    if (immutableSize > source.size) throw new Error('Wurst immutable base exceeds source');
    let nextRoot = clone(this.root);
    const ensured = await this._ensureBase(source, immutableSize, null, nextRoot);
    nextRoot.baseIndexRoot = ensured.baseIndexRoot;
    const id = objectKey(objectId ?? crypto.randomUUID());
    if (await this.object(id, nextRoot)) throw new Error(`Wurst Object ID already exists: ${id}`);
    let extentRoot = null;
    if (source.size > immutableSize) extentRoot = await this._copySourceToExtents(source, immutableSize, source.size - immutableSize, `extent:object:${id}`, null, immutableSize);
    const now = Date.now();
    const object = {
      format: WURST_OBJECT_FORMAT,
      objectId: id,
      hostRoot: false,
      applicationId: applicationId ?? null,
      packageDigest: packageDigest ?? null,
      baseBlobHash: ensured.base.baseBlobHash,
      baseSize: immutableSize,
      virtualSize: source.size,
      stateRevision: safeInt(stateRevision, 'Wurst object state revision'),
      relationshipRevision: 0,
      stateHash: stateHash ?? null,
      stateHead: stateHead == null ? null : safeInt(stateHead, 'Wurst object state head'),
      extentRoot,
      governance: normalizeGovernance(governance),
      publisher: clone(publisher ?? null),
      createdAt: now,
      updatedAt: now
    };
    nextRoot.objectTableRoot = await this.index('objects').set(nextRoot.objectTableRoot, id, object);
    const relation = { format: WURST_RELATIONSHIP_FORMAT, parentObjectId: parentId, childObjectId: id, locator: locator == null ? null : String(locator), createdAt: now };
    nextRoot.relationshipByParentRoot = await this.index('relationship:parent').set(nextRoot.relationshipByParentRoot, relationshipKey(parentId, id), relation);
    nextRoot.relationshipByChildRoot = await this.index('relationship:child').set(nextRoot.relationshipByChildRoot, id, relation);
    const parentNext = { ...parent, relationshipRevision: Number(parent.relationshipRevision ?? 0) + 1, updatedAt: now };
    const childNext = { ...object, relationshipRevision: 1, updatedAt: now };
    nextRoot.objectTableRoot = await this.index('objects').set(nextRoot.objectTableRoot, parentId, parentNext);
    nextRoot.objectTableRoot = await this.index('objects').set(nextRoot.objectTableRoot, id, childNext);
    await this._commitRoot(nextRoot);
    return this.object(id);
  }
  async importObjectSnapshot({ parentObjectId, relation = null, source, object } = {}) {
    if (!this.root) throw new Error('Wurst object store is not initialized');
    if (!object || object.hostRoot) throw new Error('Object snapshot import requires a non-root Wurst object');
    const parentId = objectKey(parentObjectId);
    if (!await this.object(parentId)) throw new Error(`Unknown parent Wurst object ${parentId}`);
    const id = objectKey(object.objectId);
    if (await this.object(id)) throw new Error(`Wurst Object ID already exists: ${id}`);
    const ensured = await this._ensureBase(source, object.baseSize, object.baseBlobHash, this.root);
    let extentRoot = null;
    if (source.size > object.baseSize) extentRoot = await this._copySourceToExtents(source, object.baseSize, source.size - object.baseSize, `extent:object:${id}`, null, object.baseSize);
    const nextRoot = clone(this.root);
    nextRoot.baseIndexRoot = ensured.baseIndexRoot;
    nextRoot.objectTableRoot = await this.index('objects').set(nextRoot.objectTableRoot, id, {
      ...clone(object),
      objectId: id,
      hostRoot: false,
      baseBlobHash: ensured.base.baseBlobHash,
      extentRoot,
      virtualSize: source.size
    });
    const rel = {
      format: WURST_RELATIONSHIP_FORMAT,
      parentObjectId: parentId,
      childObjectId: id,
      locator: relation?.locator == null ? null : String(relation.locator),
      createdAt: relation?.createdAt ?? object.createdAt ?? Date.now()
    };
    nextRoot.relationshipByParentRoot = await this.index('relationship:parent').set(nextRoot.relationshipByParentRoot, relationshipKey(parentId, id), rel);
    nextRoot.relationshipByChildRoot = await this.index('relationship:child').set(nextRoot.relationshipByChildRoot, id, rel);
    await this._commitRoot(nextRoot);
    return this.object(id);
  }

  async findChild(parentObjectId, locator) {
    const target = String(locator ?? '');
    for (const relation of await this.directChildren(parentObjectId)) if (relation.locator === target) return this.object(relation.childObjectId);
    return null;
  }
  async _readExtentValue(value, relativeOffset, length) {
    const record = await readFsRecord(this.source, value.recordOffset);
    if (record.type !== PIG_FS_RECORD.OBJECT_DATA) throw new Error('Wurst object extent points to non-data arena record');
    if (value.sha256 && sha256(record.payload) !== value.sha256) throw new Error('Wurst object extent payload hash mismatch');
    return Buffer.from(record.payload.subarray(relativeOffset, relativeOffset + length));
  }
  async _readExtentRange(indexName, extentRoot, offset, length) {
    const start = safeInt(offset, 'Wurst object read offset');
    const wanted = safeInt(length, 'Wurst object read length');
    if (wanted === 0) return Buffer.alloc(0);
    const index = this.index(indexName);
    const end = start + wanted;
    const lowerKey = extentKey(start);
    const upperKey = extentKey(end);
    const floor = await index.floor(extentRoot, lowerKey);
    const ranged = await index.range(extentRoot, { gte: lowerKey, lt: upperKey });
    const entries = floor && floor[0] !== ranged[0]?.[0] ? [floor, ...ranged] : ranged;
    const chunks = [];
    let cursor = start;
    for (const [, extent] of entries) {
      const extentStart = Number(extent.virtualOffset), extentEnd = extentStart + Number(extent.length);
      if (extentEnd <= cursor) continue;
      if (extentStart >= end) break;
      if (extentStart > cursor) throw new Error('Wurst object virtual address space contains a hole');
      const from = Math.max(cursor, extentStart);
      const to = Math.min(end, extentEnd);
      chunks.push(await this._readExtentValue(extent, from - extentStart, to - from));
      cursor = to;
      if (cursor >= end) break;
    }
    if (cursor !== end) throw new Error('Wurst object virtual address space is truncated');
    return Buffer.concat(chunks, wanted);
  }
  async openObjectSource(rawId) {
    const id = objectKey(rawId);
    const store = this;
    const current = await this.object(id);
    if (!current) throw new Error(`Unknown Wurst object ${id}`);
    if (current.hostRoot) throw new Error('The physical root Wurst is opened through its host file reader');
    return {
      kind: 'root-object',
      objectId: id,
      get size() { return store._sourceSizeCache?.get(id) ?? current.virtualSize; },
      async refresh() {
        const object = await store.object(id);
        if (!object) throw new Error(`Unknown Wurst object ${id}`);
        store._sourceSizeCache ??= new Map();
        store._sourceSizeCache.set(id, object.virtualSize);
        return object;
      },
      async read(offset, length) {
        const object = await store.object(id);
        if (!object) throw new Error(`Unknown Wurst object ${id}`);
        const start = safeInt(offset, 'Wurst object source offset');
        const wanted = safeInt(length, 'Wurst object source length');
        if (start + wanted > object.virtualSize) throw new Error('Wurst object source range exceeds virtual size');
        if (!wanted) return Buffer.alloc(0);
        const parts = [];
        let cursor = start;
        if (cursor < object.baseSize) {
          const base = await store.base(object.baseBlobHash);
          if (!base) throw new Error(`Wurst immutable base is missing: ${object.baseBlobHash}`);
          const take = Math.min(wanted, object.baseSize - cursor);
          parts.push(await store._readExtentRange(`extent:base:${object.baseBlobHash}`, base.extentRoot, cursor, take));
          cursor += take;
        }
        if (cursor < start + wanted) parts.push(await store._readExtentRange(`extent:object:${id}`, object.extentRoot, cursor, start + wanted - cursor));
        return Buffer.concat(parts, wanted);
      }
    };
  }
  async beginObjectAppend(rawId, { actorId = null } = {}) {
    const thisStore = this;
    const id = objectKey(rawId);
    const object = await this.object(id);
    if (!object || object.hostRoot) throw new Error(`Unknown mutable Wurst object ${id}`);
    this._assertObjectAuthority(object, 'state', actorId);
    const txId = this.beginTransaction({ actorId });
    await this.readObject(txId, id, { state: true });
    const tx = this.transactions.get(txId);
    tx.writeSet.set(id, { stateRevision: object.stateRevision });
    const prepared = [];
    let size = object.virtualSize;
    let preparedStateHash;
    let preparedStateHead;
    let finalized = false;
    const handle = {
      id: txId,
      objectId: id,
      get size() { return size; },
      async append(bytes) {
        if (finalized) throw new Error('Wurst object append transaction is already prepared');
        const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
        // PigFS records are appended verbatim into the virtual Wurst tail. If
        // the prepared record is the logical PigFS COMMIT, capture its state
        // hash so Wurst Object identity remains independent from physical
        // extent layout. Malformed/non-PigFS bytes simply have no such hint.
        if (data.length >= 32 + 64 && data.subarray(0, 4).toString('ascii') === 'W7RC' && data.readUInt16LE(6) === PIG_FS_RECORD.COMMIT) {
          const payloadLength = Number(data.readBigUInt64LE(8));
          if (Number.isSafeInteger(payloadLength) && payloadLength >= 0 && 32 + payloadLength + 64 === data.length) {
            try {
              const commit = JSON.parse(data.subarray(32, 32 + payloadLength).toString('utf8'));
              if (commit?.format === 'wurst/pigfs-1' && typeof commit.stateHash === 'string') {
                preparedStateHash = commit.stateHash;
                preparedStateHead = size;
              }
            } catch {}
          }
        }
        const start = size;
        for (let offset = 0; offset < data.length; offset += DATA_CHUNK) {
          const chunk = data.subarray(offset, Math.min(data.length, offset + DATA_CHUNK));
          const records = await thisStore._writeArenaData(chunk);
          for (const record of records) {
            prepared.push({ virtualOffset: size, length: record.length, recordOffset: record.recordOffset, sha256: record.sha256 });
            size += record.length;
          }
        }
        return { offset: start, length: data.length };
      },
      prepare({ stateHash = undefined } = {}) {
        if (!finalized) {
          tx.operations.push({ type: 'state-append', objectId: id, expectedVirtualSize: object.virtualSize, extents: prepared.map(clone), virtualSize: size, stateHash: stateHash === undefined ? preparedStateHash : stateHash, stateHead: preparedStateHead });
          finalized = true;
        }
        return txId;
      },
      async commit(options = {}) {
        handle.prepare(options);
        const result = await thisStore.commitTransaction(txId);
        thisStore._sourceSizeCache ??= new Map();
        thisStore._sourceSizeCache.set(id, size);
        return result;
      },
      abort() { return thisStore.abortTransaction(txId); }
    };
    return handle;
  }
  beginTransaction({ actorId = null } = {}) {
    if (!this.root) throw new Error('Wurst object store is not initialized');
    const id = crypto.randomUUID();
    this.transactions.set(id, { format: WURST_OBJECT_TX_FORMAT, id, actorId: actorId == null ? null : String(actorId), readSet: new Map(), writeSet: new Map(), operations: [] });
    return id;
  }
  async readObject(txId, rawId, { state = false, relationship = false, package: packageIdentity = false } = {}) {
    const tx = this.transactions.get(String(txId));
    if (!tx) throw new Error('Unknown Wurst object transaction');
    const object = await this.object(rawId);
    if (!object) throw new Error(`Unknown Wurst object ${rawId}`);
    const dependency = tx.readSet.get(object.objectId) ?? {};
    if (state) dependency.stateRevision = object.stateRevision;
    if (relationship) dependency.relationshipRevision = object.relationshipRevision;
    if (packageIdentity) dependency.packageDigest = object.packageDigest;
    tx.readSet.set(object.objectId, dependency);
    return clone(object);
  }
  abortTransaction(id) { return this.transactions.delete(String(id)); }
  _validateDependency(object, dependency, id) {
    if (!object) { const error = new Error(`Wurst object disappeared during transaction: ${id}`); error.code = 'WURST_SESSION_CONFLICT'; throw error; }
    for (const [field, expected] of Object.entries(dependency ?? {})) if (object[field] !== expected) { const error = new Error(`Wurst object dependency changed: ${id}.${field}`); error.code = 'WURST_SESSION_CONFLICT'; error.objectId = id; error.dimension = field; throw error; }
  }
  async _applyTransaction(candidateRoot, tx) {
    let nextRoot = clone(candidateRoot);
    for (const [id, dependency] of tx.readSet) this._validateDependency(await this.object(id, nextRoot), dependency, id);
    for (const [id, dependency] of tx.writeSet) this._validateDependency(await this.object(id, nextRoot), dependency, id);
    const changed = new Set();
    for (const operation of tx.operations) {
      if (operation.type === 'state-append') {
        const object = await this.object(operation.objectId, nextRoot);
        this._assertObjectAuthority(object, 'state', tx.actorId);
        if (object.virtualSize !== operation.expectedVirtualSize) { const error = new Error('Wurst object virtual size changed during transaction'); error.code = 'WURST_SESSION_CONFLICT'; throw error; }
        let extentRoot = object.extentRoot;
        for (const extent of operation.extents) extentRoot = await this.index(`extent:object:${object.objectId}`).set(extentRoot, extentKey(extent.virtualOffset), extent);
        const updated = { ...object, extentRoot, virtualSize: operation.virtualSize, stateRevision: Number(object.stateRevision ?? 0) + 1, stateHash: operation.stateHash === undefined ? object.stateHash : operation.stateHash, stateHead: operation.stateHead === undefined ? object.stateHead ?? null : operation.stateHead, updatedAt: Date.now() };
        nextRoot.objectTableRoot = await this.index('objects').set(nextRoot.objectTableRoot, object.objectId, updated);
        changed.add(object.objectId);
      } else if (operation.type === 'reparent') {
        nextRoot = await this._applyReparent(nextRoot, operation.childObjectId, operation.parentObjectId, { actorId: tx.actorId, locator: operation.locator });
        changed.add(operation.childObjectId); changed.add(operation.parentObjectId);
      } else if (operation.type === 'detach') {
        nextRoot = await this._applyDetach(nextRoot, operation.childObjectId, { actorId: tx.actorId });
        changed.add(operation.childObjectId);
      } else if (operation.type === 'base-upgrade') {
        const object = await this.object(operation.objectId, nextRoot);
        this._assertObjectAuthority(object, 'upgrade', tx.actorId);
        const updated = { ...object, packageDigest: operation.packageDigest, baseBlobHash: operation.baseBlobHash, baseSize: operation.baseSize, virtualSize: operation.baseSize, extentRoot: null, stateRevision: Number(object.stateRevision ?? 0) + 1, stateHash: null, stateHead: null, publisher: clone(operation.publisher ?? null), updatedAt: Date.now() };
        nextRoot.objectTableRoot = await this.index('objects').set(nextRoot.objectTableRoot, object.objectId, updated);
        changed.add(object.objectId);
      }
    }
    return { root: nextRoot, changed: [...changed] };
  }
  async commitTransactions(ids) {
    return this.withMutationLock(async () => {
      const txs = ids.map((id) => this.transactions.get(String(id))).filter(Boolean);
      if (!txs.length) throw new Error('No Wurst object transactions to commit');
      let candidate = clone(this.root);
      const accepted = [], rejected = [];
      for (const tx of txs) {
        try {
          const applied = await this._applyTransaction(candidate, tx);
          candidate = applied.root;
          accepted.push({ tx, changed: applied.changed });
        } catch (error) {
          rejected.push({ tx, error });
        }
      }
      if (accepted.length) await this._commitRoot(candidate);
      for (const { tx } of [...accepted, ...rejected]) this.transactions.delete(tx.id);
      if (accepted.length === 1 && txs.length === 1 && !rejected.length) return { ok: true, generation: this.root.generation, changed: accepted[0].changed, root: clone(this.root) };
      return {
        ok: rejected.length === 0,
        generation: this.root?.generation ?? 0,
        accepted: accepted.map(({ tx, changed }) => ({ id: tx.id, changed })),
        rejected: rejected.map(({ tx, error }) => ({ id: tx.id, code: error.code ?? null, error: error.message }))
      };
    });
  }
  commitTransaction(id) { return this.commitTransactions([String(id)]); }
  async _assertNoCycle(candidateRoot, childId, parentId) {
    if (childId === parentId) throw new Error('A Wurst object cannot parent itself');
    let current = parentId;
    const visited = new Set([childId]);
    for (let depth = 0; current; depth += 1) {
      if (depth >= this.maxDepth) throw new Error(`Wurst object graph exceeds maximum Piglet depth ${this.maxDepth}`);
      if (visited.has(current)) throw new Error('Wurst object reparent would create a cycle');
      visited.add(current);
      const relation = await this.parentOf(current, candidateRoot);
      current = relation?.parentObjectId ?? null;
    }
  }
  async _applyDetach(candidateRoot, rawChildId, { actorId = null } = {}) {
    let nextRoot = clone(candidateRoot);
    const childId = objectKey(rawChildId);
    const child = await this.object(childId, nextRoot);
    if (!child || childId === nextRoot.rootObjectId) throw new Error('Cannot detach the root Wurst object');
    this._assertObjectAuthority(child, 'relationship', actorId);
    const relation = await this.parentOf(childId, nextRoot);
    if (!relation) return nextRoot;
    const parent = await this.object(relation.parentObjectId, nextRoot);
    this._assertObjectAuthority(parent, 'relationship', actorId);
    nextRoot.relationshipByParentRoot = await this.index('relationship:parent').remove(nextRoot.relationshipByParentRoot, relationshipKey(relation.parentObjectId, childId));
    nextRoot.relationshipByChildRoot = await this.index('relationship:child').remove(nextRoot.relationshipByChildRoot, childId);
    const now = Date.now();
    nextRoot.objectTableRoot = await this.index('objects').set(nextRoot.objectTableRoot, parent.objectId, { ...parent, relationshipRevision: Number(parent.relationshipRevision ?? 0) + 1, updatedAt: now });
    nextRoot.objectTableRoot = await this.index('objects').set(nextRoot.objectTableRoot, child.objectId, { ...child, relationshipRevision: Number(child.relationshipRevision ?? 0) + 1, updatedAt: now });
    return nextRoot;
  }
  async _applyReparent(candidateRoot, rawChildId, rawParentId, { actorId = null, locator = null } = {}) {
    let nextRoot = clone(candidateRoot);
    const childId = objectKey(rawChildId), parentId = objectKey(rawParentId);
    const child = await this.object(childId, nextRoot), parent = await this.object(parentId, nextRoot);
    if (!child || !parent) throw new Error('Unknown Wurst object in reparent operation');
    if (childId === nextRoot.rootObjectId) throw new Error('Cannot reparent the root Wurst object');
    this._assertObjectAuthority(child, 'relationship', actorId); this._assertObjectAuthority(parent, 'relationship', actorId);
    await this._assertNoCycle(nextRoot, childId, parentId);
    const old = await this.parentOf(childId, nextRoot);
    if (old?.parentObjectId === parentId && (locator == null || old.locator === String(locator))) return nextRoot;
    if (old) nextRoot = await this._applyDetach(nextRoot, childId, { actorId });
    const parentLatest = await this.object(parentId, nextRoot), childLatest = await this.object(childId, nextRoot);
    const relation = { format: WURST_RELATIONSHIP_FORMAT, parentObjectId: parentId, childObjectId: childId, locator: locator == null ? old?.locator ?? null : String(locator), createdAt: old?.createdAt ?? Date.now() };
    nextRoot.relationshipByParentRoot = await this.index('relationship:parent').set(nextRoot.relationshipByParentRoot, relationshipKey(parentId, childId), relation);
    nextRoot.relationshipByChildRoot = await this.index('relationship:child').set(nextRoot.relationshipByChildRoot, childId, relation);
    const now = Date.now();
    nextRoot.objectTableRoot = await this.index('objects').set(nextRoot.objectTableRoot, parentId, { ...parentLatest, relationshipRevision: Number(parentLatest.relationshipRevision ?? 0) + 1, updatedAt: now });
    nextRoot.objectTableRoot = await this.index('objects').set(nextRoot.objectTableRoot, childId, { ...childLatest, relationshipRevision: Number(childLatest.relationshipRevision ?? 0) + 1, updatedAt: now });
    return nextRoot;
  }
  async reparent(childObjectId, parentObjectId, { actorId = null, locator = null } = {}) {
    const tx = this.beginTransaction({ actorId });
    await this.readObject(tx, childObjectId, { relationship: true });
    await this.readObject(tx, parentObjectId, { relationship: true });
    const current = await this.parentOf(childObjectId);
    if (current?.parentObjectId) await this.readObject(tx, current.parentObjectId, { relationship: true });
    this.transactions.get(tx).operations.push({ type: 'reparent', childObjectId: objectKey(childObjectId), parentObjectId: objectKey(parentObjectId), locator });
    return this.commitTransaction(tx);
  }
  async detach(childObjectId, { actorId = null } = {}) {
    const tx = this.beginTransaction({ actorId });
    await this.readObject(tx, childObjectId, { relationship: true });
    const current = await this.parentOf(childObjectId);
    if (current?.parentObjectId) await this.readObject(tx, current.parentObjectId, { relationship: true });
    this.transactions.get(tx).operations.push({ type: 'detach', childObjectId: objectKey(childObjectId) });
    return this.commitTransaction(tx);
  }
  async deleteSubtree(childObjectId, options = {}) { return this.detach(childObjectId, options); }
  async transitionBase(rawId, source, { baseSize, packageDigest, publisher = null, actorId = null, approved = false } = {}) {
    const id = objectKey(rawId), object = await this.object(id);
    if (!object) throw new Error(`Unknown Wurst object ${id}`);
    this._assertObjectAuthority(object, 'upgrade', actorId);
    const oldPublisher = object.publisher?.fingerprint ?? null, nextPublisher = publisher?.fingerprint ?? null;
    if (oldPublisher && nextPublisher && oldPublisher !== nextPublisher && !approved) {
      const rotated = this.verifyPublisherTransition
        ? await this.verifyPublisherTransition({ object: clone(object), previousPublisher: clone(object.publisher), nextPublisher: clone(publisher), packageDigest })
        : false;
      if (!rotated) { const error = new Error('Wurst base upgrade changes publisher and requires a verified key rotation or explicit approval'); error.code = 'WURST_PACKAGE_TRANSITION_APPROVAL_REQUIRED'; throw error; }
    }
    const ensured = await this._ensureBase(source, baseSize, null, this.root);
    const tx = this.beginTransaction({ actorId });
    await this.readObject(tx, id, { state: true, package: true });
    this.transactions.get(tx).operations.push({ type: 'base-upgrade', objectId: id, baseBlobHash: ensured.base.baseBlobHash, baseSize: ensured.base.size, packageDigest, publisher });
    // Make the prepared base reachable from the candidate root if commit succeeds.
    const originalApply = this.transactions.get(tx);
    originalApply.preparedBaseIndexRoot = ensured.baseIndexRoot;
    const result = await this.withMutationLock(async () => {
      const live = this.transactions.get(tx);
      let candidate = clone(this.root); candidate.baseIndexRoot = live.preparedBaseIndexRoot;
      const applied = await this._applyTransaction(candidate, live);
      await this._commitRoot(applied.root); this.transactions.delete(tx);
      return { ok: true, generation: this.root.generation, changed: applied.changed, root: clone(this.root) };
    });
    return result;
  }
  async materializeSubtree(rawId, { createFile, identityMode = 'preserve' } = {}) {
    const rootId = objectKey(rawId), object = await this.object(rootId);
    if (!object || object.hostRoot) throw new Error('Subtree materialization requires a non-root Wurst object');
    if (typeof createFile !== 'function') throw new Error('Subtree materialization requires createFile(source, callback)');
    if (!['preserve', 'copy'].includes(identityMode)) throw new Error('Wurst subtree identityMode must be preserve or copy');

    const live = [];
    const visited = new Set();
    const walk = async (id, depth) => {
      if (depth > this.maxDepth) throw new Error(`Wurst subtree exceeds maximum Piglet depth ${this.maxDepth}`);
      if (visited.has(id)) throw new Error('Wurst subtree contains a cycle');
      visited.add(id); live.push(id);
      for (const relation of await this.directChildren(id)) await walk(relation.childObjectId, depth + 1);
    };
    await walk(rootId, 0);

    // Move/extraction keeps the persistent object world. Export/copy deliberately
    // creates a second object world. App payload is never inspected or rewritten;
    // only system-owned relationship references use this remap table.
    const idMap = new Map(live.map((id) => [id, identityMode === 'copy' ? crypto.randomUUID() : id]));
    const rootSource = await this.openObjectSource(rootId);

    return createFile(rootSource, async (targetStore, targetRootMeta = {}) => {
      if (!targetStore?.initializeHostRoot || !targetStore?.importObjectSnapshot) throw new Error('Subtree materializer requires a Wurst Object Store target');
      await targetStore.initializeHostRoot({
        objectId: idMap.get(rootId),
        applicationId: object.applicationId,
        packageDigest: object.packageDigest,
        baseBlobHash: object.baseBlobHash,
        baseSize: object.baseSize,
        virtualSize: rootSource.size,
        stateRevision: object.stateRevision,
        // Becoming a standalone root changes this object's containment edge.
        relationshipRevision: Number(object.relationshipRevision ?? 0) + 1,
        stateHash: object.stateHash,
        stateHead: object.stateHead ?? null,
        publisher: object.publisher,
        governance: object.governance,
        ...targetRootMeta
      });

      const queue = [rootId];
      while (queue.length) {
        const parentOld = queue.shift();
        const parentNew = idMap.get(parentOld);
        for (const relation of await this.directChildren(parentOld)) {
          const childOld = relation.childObjectId;
          const sourceObject = await this.object(childOld);
          const source = await this.openObjectSource(childOld);
          const copiedObject = { ...clone(sourceObject), objectId: idMap.get(childOld), hostRoot: false };
          await targetStore.importObjectSnapshot({
            parentObjectId: parentNew,
            relation: { ...clone(relation), parentObjectId: parentNew, childObjectId: copiedObject.objectId },
            source,
            object: copiedObject
          });
          queue.push(childOld);
        }
      }
      await targetStore.verifyGraph({ deep: true });
      return { rootObjectId: idMap.get(rootId), objectIds: Object.fromEntries(idMap), identityMode };
    });
  }

  async stats() {
    const all = await this.objects(), liveIds = new Set(await this.reachableObjectIds());
    return { format: WURST_OBJECT_STORE_FORMAT, generation: this.root?.generation ?? 0, rootObjectId: this.root?.rootObjectId ?? null, objects: all.length, liveObjects: all.filter((item) => liveIds.has(item.objectId)).length, unreachableObjects: all.filter((item) => !liveIds.has(item.objectId)).length, arenaTail: this.root?.arenaTail ?? this.baseOffset };
  }
  close() { this.transactions.clear(); }
}

export async function createMemoryWurstObjectStore(baseBytes = Buffer.alloc(0), { baseOffset = null, verifyPublisherTransition = null } = {}) {
  let bytes = Buffer.isBuffer(baseBytes) ? Buffer.from(baseBytes) : Buffer.from(baseBytes ?? []);
  const source = {
    size: bytes.length,
    async read(offset, length) {
      const start = safeInt(offset, 'memory Wurst object read offset'), wanted = safeInt(length, 'memory Wurst object read length');
      if (start + wanted > bytes.length) throw new Error('Memory Wurst object read exceeds source');
      return Buffer.from(bytes.subarray(start, start + wanted));
    }
  };
  let syncCount = 0;
  const store = new WurstObjectStore({
    source,
    baseOffset: baseOffset == null ? bytes.length : safeInt(baseOffset, 'memory Wurst object base offset'),
    append: async (chunk) => { bytes = Buffer.concat([bytes, Buffer.from(chunk)]); source.size = bytes.length; },
    sync: async () => { syncCount += 1; },
    verifyPublisherTransition
  });
  await store.init();
  return { store, source, bytes: () => Buffer.from(bytes), syncCount: () => syncCount };
}
