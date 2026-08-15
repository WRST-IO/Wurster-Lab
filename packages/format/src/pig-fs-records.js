import crypto from 'node:crypto';

export const PIG_FS_RECORD_MAGIC = Buffer.from('W7RC');
export const PIG_FS_RECORD_END_MAGIC = Buffer.from('W7RE');
export const PIG_FS_RECORD_HEADER_SIZE = 32;
export const PIG_FS_RECORD_TRAILER_SIZE = 64;
export const PIG_FS_MAX_RECORD_PAYLOAD = 4 * 1024 * 1024;
export const PIG_FS_DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
export const PIG_FS_CATALOG_TARGET = 512 * 1024;
export const PIG_FS_MAP_TARGET = 512 * 1024;

export const PIG_FS_RECORD = Object.freeze({
  DATA: 1,
  MAP: 2,
  CATALOG: 3,
  COMMIT: 4,
  // WRST v7 system arena records. These share the crash-safe W7RC framing
  // with PigFS so both layers may coexist in one append-only physical tail.
  // They are not PigFS objects and are never exposed through app PigFS APIs.
  OBJECT_DATA: 16,
  OBJECT_PAGE: 17,
  RELATION_PAGE: 18,
  BASE_PAGE: 19,
  EXTENT_PAGE: 20,
  ROOT_COMMIT: 21
});

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertSafeOffset(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid ${label}`);
  return number;
}

export function makeFsRecord(type, payload, { recordStart, previousCommitOffset = 0, sequence = 0 } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? Buffer.alloc(0));
  if (body.length > PIG_FS_MAX_RECORD_PAYLOAD) throw new Error('PigFS record payload exceeds 4 MiB');
  const start = assertSafeOffset(recordStart, 'PigFS record offset');
  const previous = assertSafeOffset(previousCommitOffset, 'PigFS previous commit offset');
  const seq = assertSafeOffset(sequence, 'PigFS record sequence');

  const header = Buffer.alloc(PIG_FS_RECORD_HEADER_SIZE);
  PIG_FS_RECORD_MAGIC.copy(header, 0);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(type, 6);
  header.writeBigUInt64LE(BigInt(body.length), 8);
  header.writeBigUInt64LE(BigInt(previous), 16);
  header.writeBigUInt64LE(BigInt(seq), 24);

  const trailer = Buffer.alloc(PIG_FS_RECORD_TRAILER_SIZE);
  PIG_FS_RECORD_END_MAGIC.copy(trailer, 0);
  trailer.writeUInt16LE(1, 4);
  trailer.writeUInt16LE(type, 6);
  trailer.writeBigUInt64LE(BigInt(start), 8);
  trailer.writeBigUInt64LE(BigInt(previous), 16);
  trailer.writeBigUInt64LE(BigInt(body.length), 24);
  Buffer.from(sha256(body), 'hex').copy(trailer, 32);

  return Buffer.concat([header, body, trailer]);
}

export function parseFsRecordTrailer(buffer, trailerAbsoluteOffset, baseOffset, sourceSize) {
  if (buffer.length !== PIG_FS_RECORD_TRAILER_SIZE || !buffer.subarray(0, 4).equals(PIG_FS_RECORD_END_MAGIC)) return null;
  if (buffer.readUInt16LE(4) !== 1) return null;
  const type = buffer.readUInt16LE(6);
  const startBig = buffer.readBigUInt64LE(8);
  const previousBig = buffer.readBigUInt64LE(16);
  const payloadBig = buffer.readBigUInt64LE(24);
  if ([startBig, previousBig, payloadBig].some((item) => item > BigInt(Number.MAX_SAFE_INTEGER))) return null;
  const recordStart = Number(startBig);
  const previousCommitOffset = Number(previousBig);
  const payloadLength = Number(payloadBig);
  if (recordStart < baseOffset || payloadLength > PIG_FS_MAX_RECORD_PAYLOAD) return null;
  const expectedTrailer = recordStart + PIG_FS_RECORD_HEADER_SIZE + payloadLength;
  const recordEnd = expectedTrailer + PIG_FS_RECORD_TRAILER_SIZE;
  if (expectedTrailer !== trailerAbsoluteOffset || recordEnd > sourceSize) return null;
  return {
    type,
    recordStart,
    previousCommitOffset,
    payloadLength,
    payloadSha256: buffer.subarray(32, 64).toString('hex'),
    recordEnd
  };
}

export async function readFsRecord(source, recordStart) {
  const start = assertSafeOffset(recordStart, 'PigFS record offset');
  const header = await source.read(start, PIG_FS_RECORD_HEADER_SIZE);
  if (!header.subarray(0, 4).equals(PIG_FS_RECORD_MAGIC) || header.readUInt16LE(4) !== 1) throw new Error('Invalid PigFS record header');
  const type = header.readUInt16LE(6);
  const payloadBig = header.readBigUInt64LE(8);
  const previousBig = header.readBigUInt64LE(16);
  const sequenceBig = header.readBigUInt64LE(24);
  if ([payloadBig, previousBig, sequenceBig].some((item) => item > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error('PigFS record metadata is too large');
  const payloadLength = Number(payloadBig);
  const previousCommitOffset = Number(previousBig);
  const sequence = Number(sequenceBig);
  if (payloadLength > PIG_FS_MAX_RECORD_PAYLOAD) throw new Error('PigFS record payload exceeds limit');
  const payload = await source.read(start + PIG_FS_RECORD_HEADER_SIZE, payloadLength);
  const trailerOffset = start + PIG_FS_RECORD_HEADER_SIZE + payloadLength;
  const trailerBytes = await source.read(trailerOffset, PIG_FS_RECORD_TRAILER_SIZE);
  const trailer = parseFsRecordTrailer(trailerBytes, trailerOffset, 0, source.size);
  if (!trailer || trailer.recordStart !== start || trailer.type !== type || trailer.previousCommitOffset !== previousCommitOffset || trailer.payloadLength !== payloadLength) {
    throw new Error('PigFS record trailer mismatch');
  }
  if (sha256(payload) !== trailer.payloadSha256) throw new Error('PigFS record integrity check failed');
  return { type, payload, payloadLength, previousCommitOffset, sequence, recordStart: start, recordEnd: trailer.recordEnd };
}

export async function locateLatestRecord(source, baseOffset, { types = null } = {}) {
  const base = assertSafeOffset(baseOffset, 'record base offset');
  if (!source || typeof source.read !== 'function' || !Number.isSafeInteger(source.size)) throw new Error('Record locator requires a random-access source');
  if (source.size <= base) return null;
  const wanted = types == null ? null : new Set(Array.isArray(types) ? types : [types]);

  // First recover the last fully written record even when EOF contains arbitrary
  // uncommitted bytes. After that, records are physically contiguous and their
  // trailers let us walk backwards without trusting any uncommitted root.
  async function findTrailerBefore(endExclusive) {
    let end = Math.min(Number(endExclusive), source.size);
    const scanWindow = 1024 * 1024;
    while (end - base >= PIG_FS_RECORD_TRAILER_SIZE) {
      const start = Math.max(base, end - scanWindow);
      const bytes = await source.read(start, end - start);
      for (let index = bytes.length - PIG_FS_RECORD_TRAILER_SIZE; index >= 0; index -= 1) {
        if (!bytes.subarray(index, index + 4).equals(PIG_FS_RECORD_END_MAGIC)) continue;
        const absolute = start + index;
        const parsed = parseFsRecordTrailer(bytes.subarray(index, index + PIG_FS_RECORD_TRAILER_SIZE), absolute, base, source.size);
        if (parsed && parsed.recordEnd <= endExclusive) return parsed;
      }
      if (start === base) break;
      end = start + PIG_FS_RECORD_TRAILER_SIZE - 1;
    }
    return null;
  }

  let current = await findTrailerBefore(source.size);
  while (current) {
    if (!wanted || wanted.has(current.type)) return current;
    if (current.recordStart <= base) break;
    const trailerOffset = current.recordStart - PIG_FS_RECORD_TRAILER_SIZE;
    let previous = null;
    if (trailerOffset >= base) {
      const trailer = await source.read(trailerOffset, PIG_FS_RECORD_TRAILER_SIZE);
      previous = parseFsRecordTrailer(trailer, trailerOffset, base, source.size);
      if (previous && previous.recordEnd !== current.recordStart) previous = null;
    }
    current = previous || await findTrailerBefore(current.recordStart);
  }
  return null;
}

export async function locateLatestFsCommit(source, baseOffset) {
  const record = await locateLatestRecord(source, baseOffset, { types: PIG_FS_RECORD.COMMIT });
  return record?.recordStart ?? null;
}

export function decodeLatestFsRootFromBuffer(buffer, baseOffset, expectedFormat) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const base = assertSafeOffset(baseOffset, 'PigFS base offset');
  if (bytes.length <= base) return { root: null, commitOffset: null };

  let trailer = null;
  for (let offset = bytes.length - PIG_FS_RECORD_TRAILER_SIZE; offset >= base; offset -= 1) {
    if (!bytes.subarray(offset, offset + 4).equals(PIG_FS_RECORD_END_MAGIC)) continue;
    const parsed = parseFsRecordTrailer(bytes.subarray(offset, offset + PIG_FS_RECORD_TRAILER_SIZE), offset, base, bytes.length);
    if (!parsed || parsed.type !== PIG_FS_RECORD.COMMIT) continue;
    trailer = parsed;
    break;
  }
  if (!trailer) return { root: null, commitOffset: null };
  const commitOffset = trailer.recordStart;
  const head = bytes.subarray(commitOffset, commitOffset + PIG_FS_RECORD_HEADER_SIZE);
  if (!head.subarray(0, 4).equals(PIG_FS_RECORD_MAGIC) || head.readUInt16LE(6) !== PIG_FS_RECORD.COMMIT) throw new Error('Invalid PigFS commit record');
  const payloadLengthBig = head.readBigUInt64LE(8);
  if (payloadLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PigFS commit is too large');
  const payloadLength = Number(payloadLengthBig);
  const payload = bytes.subarray(commitOffset + PIG_FS_RECORD_HEADER_SIZE, commitOffset + PIG_FS_RECORD_HEADER_SIZE + payloadLength);
  let root;
  try { root = JSON.parse(payload.toString('utf8')); } catch { throw new Error('Invalid PigFS commit JSON'); }
  if (root?.format !== expectedFormat) throw new Error(`Unsupported PigFS root format: ${root?.format ?? 'missing'}`);
  return { root, commitOffset };
}


export async function loadFsRootAt(source, commitOffset, expectedFormat) {
  if (commitOffset == null) return { root: null, commitOffset: null };
  const offset = assertSafeOffset(commitOffset, 'PigFS commit offset');
  const record = await readFsRecord(source, offset);
  if (record.type !== PIG_FS_RECORD.COMMIT) throw new Error('Authoritative PigFS state head does not point to a COMMIT record');
  let root;
  try { root = JSON.parse(record.payload.toString('utf8')); } catch { throw new Error('Invalid PigFS commit JSON'); }
  if (root?.format !== expectedFormat) throw new Error(`Unsupported PigFS root format: ${root?.format ?? 'missing'}`);
  return { root, commitOffset: offset };
}

export async function loadLatestFsRoot(source, baseOffset, expectedFormat) {
  const commitOffset = await locateLatestFsCommit(source, baseOffset);
  if (commitOffset == null) return { commitOffset: null, root: null };
  const record = await readFsRecord(source, commitOffset);
  if (record.type !== PIG_FS_RECORD.COMMIT) throw new Error('PigFS commit pointer does not reference a commit record');
  let root;
  try { root = JSON.parse(record.payload.toString('utf8')); } catch { throw new Error('Invalid PigFS commit JSON'); }
  if (root?.format !== expectedFormat) throw new Error(`Unsupported PigFS root format: ${root?.format ?? 'missing'}`);
  return { commitOffset, root };
}
