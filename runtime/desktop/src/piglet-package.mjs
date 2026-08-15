import crypto from 'node:crypto';
import { openWurstRangeSource, verifyPackageSignatureFromReader } from '@wurster/format';

export const PIGLET_MIME = 'application/vnd.wrst.wurst';
export const MAX_PIGLET_BYTES = 512 * 1024 * 1024;

export function normalizePigletBytes(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : value instanceof ArrayBuffer
        ? Buffer.from(value)
        : Buffer.from(value ?? []);
  if (!bytes.length) throw new Error('Piglet Wurst is empty');
  if (bytes.length > MAX_PIGLET_BYTES) throw new Error(`Piglet Wurst exceeds ${MAX_PIGLET_BYTES} byte runtime limit`);
  return bytes;
}

export function pigletSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function pigletByteSource(value) {
  const bytes = normalizePigletBytes(value);
  return {
    size: bytes.length,
    async read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
        throw new Error('Invalid Piglet byte range');
      }
      return bytes.subarray(offset, offset + length);
    }
  };
}

export async function sha256PigletSource(source, { chunkSize = 4 * 1024 * 1024 } = {}) {
  const hash = crypto.createHash('sha256');
  for (let offset = 0; offset < source.size; offset += chunkSize) {
    hash.update(await source.read(offset, Math.min(chunkSize, source.size - offset)));
  }
  return hash.digest('hex');
}

export async function openPigletSource(source) {
  if (!source || typeof source.read !== 'function' || !Number.isSafeInteger(source.size) || source.size <= 0) throw new Error('Piglet source requires size and range reads');
  if (source.size > MAX_PIGLET_BYTES) throw new Error(`Piglet Wurst exceeds ${MAX_PIGLET_BYTES} byte runtime limit`);
  return openWurstRangeSource(source);
}

export async function inspectPigletSource(source, metadata = {}) {
  const reader = await openPigletSource(source);
  try {
    const signature = await verifyPackageSignatureFromReader(reader);
    return {
      ...metadata,
      bytes: source.size,
      sha256: metadata.sha256 ?? null,
      application: {
        id: reader.manifest?.id ?? null,
        name: reader.manifest?.name ?? null,
        version: reader.manifest?.version ?? null
      },
      data: {
        format: reader.manifest?.pigfs?.format ?? null,
        writable: reader.manifest?.pigfs?.writable === true
      },
      capabilities: structuredClone(reader.manifest?.capabilities ?? {}),
      piglink: reader.manifest?.piglink ? {
        format: reader.manifest.piglink.format ?? null,
        headless: reader.manifest.piglink.headless === true,
        actions: Object.keys(reader.manifest.piglink.actions ?? {}),
        events: Object.keys(reader.manifest.piglink.events ?? {})
      } : null,
      protection: {
        application: reader.manifest?.application?.protection ?? 'public',
        sealed: reader.manifest?.application?.protection === 'sealed' || reader.entries().some((entry) => Boolean(entry.encryption))
      },
      signature: {
        status: signature.status,
        publisher: signature.publisher ?? null,
        error: signature.error ?? null
      }
    };
  } finally {
    await reader.close().catch(() => {});
  }
}

export async function openPigletBytes(value) {
  const bytes = normalizePigletBytes(value);
  const reader = await openPigletSource(pigletByteSource(bytes));
  return { bytes, reader };
}

export async function inspectPigletBytes(value, metadata = {}) {
  const bytes = normalizePigletBytes(value);
  return inspectPigletSource(pigletByteSource(bytes), { ...metadata, sha256: metadata.sha256 ?? pigletSha256(bytes) });
}
