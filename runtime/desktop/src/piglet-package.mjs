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

export async function openPigletBytes(value) {
  const bytes = normalizePigletBytes(value);
  const source = {
    size: bytes.length,
    async read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
        throw new Error('Invalid Piglet byte range');
      }
      return bytes.subarray(offset, offset + length);
    }
  };
  const reader = await openWurstRangeSource(source);
  return { bytes, reader };
}

export async function inspectPigletBytes(value, metadata = {}) {
  const { bytes, reader } = await openPigletBytes(value);
  try {
    const signature = await verifyPackageSignatureFromReader(reader);
    return {
      ...metadata,
      bytes: bytes.length,
      sha256: pigletSha256(bytes),
      application: {
        id: reader.manifest?.id ?? null,
        name: reader.manifest?.name ?? null,
        version: reader.manifest?.version ?? null
      },
      data: {
        format: reader.manifest?.data?.format ?? null,
        writable: reader.manifest?.data?.writable === true
      },
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
