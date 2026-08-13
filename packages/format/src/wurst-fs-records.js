import crypto from 'node:crypto';

export const WURST_FS_RECORD_MAGIC = Buffer.from('W7RC');
export const WURST_FS_RECORD_END_MAGIC = Buffer.from('W7RE');
export const WURST_FS_RECORD_HEADER_SIZE = 32;
export const WURST_FS_RECORD_TRAILER_SIZE = 64;
export const WURST_FS_MAX_RECORD_PAYLOAD = 4 * 1024 * 1024;
export const WURST_FS_DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
export const WURST_FS_CATALOG_TARGET = 512 * 1024;
export const WURST_FS_MAP_TARGET = 512 * 1024;

export const WURST_FS_RECORD = Object.freeze({
  DATA: 1,
  MAP: 2,
  CATALOG: 3,
  COMMIT: 4
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
  if (body.length > WURST_FS_MAX_RECORD_PAYLOAD) throw new Error('WurstFS record payload exceeds 4 MiB');
  const start = assertSafeOffset(recordStart, 'WurstFS record offset');
  const previous = assertSafeOffset(previousCommitOffset, 'WurstFS previous commit offset');
  const seq = assertSafeOffset(sequence, 'WurstFS record sequence');

  const header = Buffer.alloc(WURST_FS_RECORD_HEADER_SIZE);
  WURST_FS_RECORD_MAGIC.copy(header, 0);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(type, 6);
  header.writeBigUInt64LE(BigInt(body.length), 8);
  header.writeBigUInt64LE(BigInt(previous), 16);
  header.writeBigUInt64LE(BigInt(seq), 24);

  const trailer = Buffer.alloc(WURST_FS_RECORD_TRAILER_SIZE);
  WURST_FS_RECORD_END_MAGIC.copy(trailer, 0);
  trailer.writeUInt16LE(1, 4);
  trailer.writeUInt16LE(type, 6);
  trailer.writeBigUInt64LE(BigInt(start), 8);
  trailer.writeBigUInt64LE(BigInt(previous), 16);
  trailer.writeBigUInt64LE(BigInt(body.length), 24);
  Buffer.from(sha256(body), 'hex').copy(trailer, 32);

  return Buffer.concat([header, body, trailer]);
}

function parseTrailer(buffer, trailerAbsoluteOffset, baseOffset, sourceSize) {
  if (buffer.length !== WURST_FS_RECORD_TRAILER_SIZE || !buffer.subarray(0, 4).equals(WURST_FS_RECORD_END_MAGIC)) return null;
  if (buffer.readUInt16LE(4) !== 1) return null;
  const type = buffer.readUInt16LE(6);
  const startBig = buffer.readBigUInt64LE(8);
  const previousBig = buffer.readBigUInt64LE(16);
  const payloadBig = buffer.readBigUInt64LE(24);
  if ([startBig, previousBig, payloadBig].some((item) => item > BigInt(Number.MAX_SAFE_INTEGER))) return null;
  const recordStart = Number(startBig);
  const previousCommitOffset = Number(previousBig);
  const payloadLength = Number(payloadBig);
  if (recordStart < baseOffset || payloadLength > WURST_FS_MAX_RECORD_PAYLOAD) return null;
  const expectedTrailer = recordStart + WURST_FS_RECORD_HEADER_SIZE + payloadLength;
  const recordEnd = expectedTrailer + WURST_FS_RECORD_TRAILER_SIZE;
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
  const start = assertSafeOffset(recordStart, 'WurstFS record offset');
  const header = await source.read(start, WURST_FS_RECORD_HEADER_SIZE);
  if (!header.subarray(0, 4).equals(WURST_FS_RECORD_MAGIC) || header.readUInt16LE(4) !== 1) throw new Error('Invalid WurstFS record header');
  const type = header.readUInt16LE(6);
  const payloadBig = header.readBigUInt64LE(8);
  const previousBig = header.readBigUInt64LE(16);
  const sequenceBig = header.readBigUInt64LE(24);
  if ([payloadBig, previousBig, sequenceBig].some((item) => item > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error('WurstFS record metadata is too large');
  const payloadLength = Number(payloadBig);
  const previousCommitOffset = Number(previousBig);
  const sequence = Number(sequenceBig);
  if (payloadLength > WURST_FS_MAX_RECORD_PAYLOAD) throw new Error('WurstFS record payload exceeds limit');
  const payload = await source.read(start + WURST_FS_RECORD_HEADER_SIZE, payloadLength);
  const trailerOffset = start + WURST_FS_RECORD_HEADER_SIZE + payloadLength;
  const trailerBytes = await source.read(trailerOffset, WURST_FS_RECORD_TRAILER_SIZE);
  const trailer = parseTrailer(trailerBytes, trailerOffset, 0, source.size);
  if (!trailer || trailer.recordStart !== start || trailer.type !== type || trailer.previousCommitOffset !== previousCommitOffset || trailer.payloadLength !== payloadLength) {
    throw new Error('WurstFS record trailer mismatch');
  }
  if (sha256(payload) !== trailer.payloadSha256) throw new Error('WurstFS record integrity check failed');
  return { type, payload, payloadLength, previousCommitOffset, sequence, recordStart: start, recordEnd: trailer.recordEnd };
}

export async function locateLatestFsCommit(source, baseOffset) {
  const base = assertSafeOffset(baseOffset, 'WurstFS base offset');
  if (source.size <= base) return null;

  const trailerOffset = source.size - WURST_FS_RECORD_TRAILER_SIZE;
  if (trailerOffset >= base) {
    const tail = await source.read(trailerOffset, WURST_FS_RECORD_TRAILER_SIZE);
    const parsed = parseTrailer(tail, trailerOffset, base, source.size);
    if (parsed) return parsed.type === WURST_FS_RECORD.COMMIT ? parsed.recordStart : (parsed.previousCommitOffset || null);
  }

  const scanLength = Math.min(source.size - base, WURST_FS_MAX_RECORD_PAYLOAD + WURST_FS_RECORD_HEADER_SIZE + WURST_FS_RECORD_TRAILER_SIZE + 4096);
  const scanStart = source.size - scanLength;
  const bytes = await source.read(scanStart, scanLength);
  for (let index = bytes.length - WURST_FS_RECORD_TRAILER_SIZE; index >= 0; index -= 1) {
    if (!bytes.subarray(index, index + 4).equals(WURST_FS_RECORD_END_MAGIC)) continue;
    const absolute = scanStart + index;
    const parsed = parseTrailer(bytes.subarray(index, index + WURST_FS_RECORD_TRAILER_SIZE), absolute, base, source.size);
    if (!parsed) continue;
    return parsed.type === WURST_FS_RECORD.COMMIT ? parsed.recordStart : (parsed.previousCommitOffset || null);
  }
  return null;
}

export function decodeLatestFsRootFromBuffer(buffer, baseOffset, expectedFormat) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const base = assertSafeOffset(baseOffset, 'WurstFS base offset');
  if (bytes.length <= base) return { root: null, commitOffset: null };

  let trailer = null;
  for (let offset = bytes.length - WURST_FS_RECORD_TRAILER_SIZE; offset >= base; offset -= 1) {
    if (!bytes.subarray(offset, offset + 4).equals(WURST_FS_RECORD_END_MAGIC)) continue;
    const parsed = parseTrailer(bytes.subarray(offset, offset + WURST_FS_RECORD_TRAILER_SIZE), offset, base, bytes.length);
    if (!parsed) continue;
    trailer = parsed;
    break;
  }
  if (!trailer) return { root: null, commitOffset: null };
  const commitOffset = trailer.type === WURST_FS_RECORD.COMMIT ? trailer.recordStart : (trailer.previousCommitOffset || null);
  if (commitOffset == null) return { root: null, commitOffset: null };
  const head = bytes.subarray(commitOffset, commitOffset + WURST_FS_RECORD_HEADER_SIZE);
  if (!head.subarray(0, 4).equals(WURST_FS_RECORD_MAGIC) || head.readUInt16LE(6) !== WURST_FS_RECORD.COMMIT) throw new Error('Invalid WurstFS commit record');
  const payloadLengthBig = head.readBigUInt64LE(8);
  if (payloadLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WurstFS commit is too large');
  const payloadLength = Number(payloadLengthBig);
  const payload = bytes.subarray(commitOffset + WURST_FS_RECORD_HEADER_SIZE, commitOffset + WURST_FS_RECORD_HEADER_SIZE + payloadLength);
  let root;
  try { root = JSON.parse(payload.toString('utf8')); } catch { throw new Error('Invalid WurstFS commit JSON'); }
  if (root?.format !== expectedFormat) throw new Error(`Unsupported WurstFS root format: ${root?.format ?? 'missing'}`);
  return { root, commitOffset };
}

export async function loadLatestFsRoot(source, baseOffset, expectedFormat) {
  const commitOffset = await locateLatestFsCommit(source, baseOffset);
  if (commitOffset == null) return { commitOffset: null, root: null };
  const record = await readFsRecord(source, commitOffset);
  if (record.type !== WURST_FS_RECORD.COMMIT) throw new Error('WurstFS commit pointer does not reference a commit record');
  let root;
  try { root = JSON.parse(record.payload.toString('utf8')); } catch { throw new Error('Invalid WurstFS commit JSON'); }
  if (root?.format !== expectedFormat) throw new Error(`Unsupported WurstFS root format: ${root?.format ?? 'missing'}`);
  return { commitOffset, root };
}
