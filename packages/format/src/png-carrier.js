const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WURST_CHUNK_TYPE = 'wuSt';
const WURST_CHUNK_MAGIC = Buffer.from('WUSC');
const WURST_CHUNK_VERSION = 1;
const WURST_CHUNK_HEADER_SIZE = 24;
export const DEFAULT_PNG_CARRIER_CHUNK_SIZE = 4 * 1024 * 1024;

let crcTable = null;
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buffer) {
  if (!crcTable) crcTable = makeCrcTable();
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPngBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function makePngChunk(type, data) {
  if (typeof type !== 'string' || type.length !== 4) throw new Error('PNG chunk type must contain four characters');
  const typeBytes = Buffer.from(type, 'ascii');
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  typeBytes.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 8 + payload.length);
  return chunk;
}

function parsePngChunks(bytes) {
  if (!isPngBuffer(bytes)) throw new Error('Carrier is not a valid PNG signature');
  const chunks = [];
  let position = PNG_SIGNATURE.length;
  let sawIend = false;
  while (position + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(position);
    const type = bytes.subarray(position + 4, position + 8).toString('ascii');
    const end = position + 12 + length;
    if (end > bytes.length) throw new Error(`Corrupt PNG chunk ${type}`);
    chunks.push({ type, length, start: position, end, dataStart: position + 8, dataEnd: position + 8 + length });
    position = end;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }
  if (!sawIend) throw new Error('PNG carrier has no IEND chunk');
  if (position !== bytes.length) throw new Error('PNG carrier contains trailing bytes after IEND');
  return chunks;
}

function makeCarrierHeader(index, count, totalLength) {
  const header = Buffer.alloc(WURST_CHUNK_HEADER_SIZE);
  WURST_CHUNK_MAGIC.copy(header, 0);
  header.writeUInt16BE(WURST_CHUNK_VERSION, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt32BE(index, 8);
  header.writeUInt32BE(count, 12);
  header.writeBigUInt64BE(BigInt(totalLength), 16);
  return header;
}

function parseCarrierHeader(header) {
  if (header.length < WURST_CHUNK_HEADER_SIZE || !header.subarray(0, 4).equals(WURST_CHUNK_MAGIC)) {
    throw new Error('Invalid Undercover Wurst chunk header');
  }
  const version = header.readUInt16BE(4);
  if (version !== WURST_CHUNK_VERSION) throw new Error(`Unsupported Undercover Wurst carrier version ${version}`);
  const totalBig = header.readBigUInt64BE(16);
  if (totalBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Undercover Wurst is too large for this runtime');
  return {
    index: header.readUInt32BE(8),
    count: header.readUInt32BE(12),
    totalLength: Number(totalBig)
  };
}

export function embedWurstInPng(pngBuffer, wurstBuffer, { chunkSize = DEFAULT_PNG_CARRIER_CHUNK_SIZE } = {}) {
  const png = Buffer.isBuffer(pngBuffer) ? pngBuffer : Buffer.from(pngBuffer);
  const wurst = Buffer.isBuffer(wurstBuffer) ? wurstBuffer : Buffer.from(wurstBuffer);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 64 * 1024 || chunkSize > 64 * 1024 * 1024) {
    throw new Error('PNG Wurst carrier chunk size must be between 64 KiB and 64 MiB');
  }
  const chunks = parsePngChunks(png);
  const count = Math.max(1, Math.ceil(wurst.length / chunkSize));
  const carrierChunks = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * chunkSize;
    const payload = wurst.subarray(start, Math.min(wurst.length, start + chunkSize));
    carrierChunks.push(makePngChunk(WURST_CHUNK_TYPE, Buffer.concat([
      makeCarrierHeader(index, count, wurst.length),
      payload
    ])));
  }

  const output = [PNG_SIGNATURE];
  let inserted = false;
  for (const chunk of chunks) {
    if (chunk.type === WURST_CHUNK_TYPE) continue;
    if (chunk.type === 'IEND' && !inserted) {
      output.push(...carrierChunks);
      inserted = true;
    }
    output.push(png.subarray(chunk.start, chunk.end));
  }
  if (!inserted) throw new Error('PNG carrier has no IEND chunk');
  return Buffer.concat(output);
}

export function extractWurstFromPng(pngBuffer) {
  const png = Buffer.isBuffer(pngBuffer) ? pngBuffer : Buffer.from(pngBuffer);
  const chunks = parsePngChunks(png).filter((chunk) => chunk.type === WURST_CHUNK_TYPE);
  if (!chunks.length) throw new Error('PNG does not contain an Undercover Wurst');
  const pieces = [];
  let expectedCount = null;
  let expectedTotal = null;
  for (const chunk of chunks) {
    if (chunk.length < WURST_CHUNK_HEADER_SIZE) throw new Error('Undercover Wurst PNG chunk is truncated');
    const header = parseCarrierHeader(png.subarray(chunk.dataStart, chunk.dataStart + WURST_CHUNK_HEADER_SIZE));
    expectedCount ??= header.count;
    expectedTotal ??= header.totalLength;
    if (header.count !== expectedCount || header.totalLength !== expectedTotal) throw new Error('Inconsistent Undercover Wurst PNG chunk table');
    pieces.push({ index: header.index, data: png.subarray(chunk.dataStart + WURST_CHUNK_HEADER_SIZE, chunk.dataEnd) });
  }
  pieces.sort((a, b) => a.index - b.index);
  if (pieces.length !== expectedCount) throw new Error('Undercover Wurst PNG is missing carrier chunks');
  for (let index = 0; index < pieces.length; index += 1) {
    if (pieces[index].index !== index) throw new Error('Undercover Wurst PNG has an invalid chunk sequence');
  }
  const wurst = Buffer.concat(pieces.map((piece) => piece.data));
  if (wurst.length !== expectedTotal) throw new Error('Undercover Wurst PNG payload length mismatch');
  return wurst;
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error('Unexpected end of PNG carrier');
    offset += bytesRead;
  }
  return buffer;
}

export async function openPngWurstSource(handle, fileSize) {
  if (fileSize < PNG_SIGNATURE.length + 12) throw new Error('File is too small to be an Undercover Wurst PNG');
  const signature = await readExact(handle, PNG_SIGNATURE.length, 0);
  if (!signature.equals(PNG_SIGNATURE)) throw new Error('Invalid PNG signature');

  const pieces = [];
  let position = PNG_SIGNATURE.length;
  let sawIend = false;
  let expectedCount = null;
  let expectedTotal = null;

  while (position + 12 <= fileSize) {
    const chunkHead = await readExact(handle, 8, position);
    const length = chunkHead.readUInt32BE(0);
    const type = chunkHead.subarray(4, 8).toString('ascii');
    const end = position + 12 + length;
    if (end > fileSize) throw new Error(`Corrupt PNG chunk ${type}`);

    if (type === WURST_CHUNK_TYPE) {
      if (length < WURST_CHUNK_HEADER_SIZE) throw new Error('Undercover Wurst PNG chunk is truncated');
      const header = parseCarrierHeader(await readExact(handle, WURST_CHUNK_HEADER_SIZE, position + 8));
      expectedCount ??= header.count;
      expectedTotal ??= header.totalLength;
      if (header.count !== expectedCount || header.totalLength !== expectedTotal) throw new Error('Inconsistent Undercover Wurst PNG chunk table');
      pieces.push({
        index: header.index,
        virtualLength: length - WURST_CHUNK_HEADER_SIZE,
        physicalOffset: position + 8 + WURST_CHUNK_HEADER_SIZE
      });
    }

    position = end;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }

  if (!sawIend) throw new Error('PNG carrier has no IEND chunk');
  if (!pieces.length) throw new Error('PNG does not contain an Undercover Wurst');
  pieces.sort((a, b) => a.index - b.index);
  if (pieces.length !== expectedCount) throw new Error('Undercover Wurst PNG is missing carrier chunks');

  let virtualOffset = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (piece.index !== index) throw new Error('Undercover Wurst PNG has an invalid chunk sequence');
    piece.virtualOffset = virtualOffset;
    virtualOffset += piece.virtualLength;
  }
  if (virtualOffset !== expectedTotal) throw new Error('Undercover Wurst PNG payload length mismatch');

  async function read(positionInWurst, length) {
    if (!Number.isSafeInteger(positionInWurst) || !Number.isSafeInteger(length) || positionInWurst < 0 || length < 0 || positionInWurst + length > expectedTotal) {
      throw new Error('Invalid Undercover Wurst virtual range');
    }
    if (length === 0) return Buffer.alloc(0);
    const output = Buffer.alloc(length);
    let written = 0;
    const requestedEnd = positionInWurst + length;
    for (const piece of pieces) {
      const pieceStart = piece.virtualOffset;
      const pieceEnd = pieceStart + piece.virtualLength;
      if (pieceEnd <= positionInWurst || pieceStart >= requestedEnd) continue;
      const overlapStart = Math.max(positionInWurst, pieceStart);
      const overlapEnd = Math.min(requestedEnd, pieceEnd);
      const bytes = await readExact(handle, overlapEnd - overlapStart, piece.physicalOffset + (overlapStart - pieceStart));
      bytes.copy(output, written);
      written += bytes.length;
      if (written === length) break;
    }
    if (written !== length) throw new Error('Undercover Wurst virtual range could not be satisfied');
    return output;
  }

  return {
    size: expectedTotal,
    read,
    carrier: {
      type: 'png',
      chunkType: WURST_CHUNK_TYPE,
      chunks: pieces.length,
      physicalSize: fileSize
    }
  };
}

export { PNG_SIGNATURE, WURST_CHUNK_TYPE };
