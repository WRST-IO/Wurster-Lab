import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(value) {
  const normalized = String(value ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!normalized) throw new Error('Invalid Base32 secret');
  let bits = 0;
  let buffer = 0;
  const out = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid Base32 secret');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(bytes = 20) {
  const size = Number(bytes);
  if (!Number.isInteger(size) || size < 16 || size > 64) throw new Error('TOTP secret must be between 16 and 64 bytes');
  return base32Encode(crypto.randomBytes(size));
}

export function totpCode(secret, timeMs = Date.now(), { digits = 6, period = 30 } = {}) {
  const key = base32Decode(secret);
  const counter = Math.floor(Number(timeMs) / 1000 / period);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(counterBytes).digest();
  key.fill(0);
  const offset = digest[digest.length - 1] & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(number % (10 ** digits)).padStart(digits, '0');
}

export function verifyTotp(secret, code, timeMs = Date.now(), { digits = 6, period = 30, window = 1 } = {}) {
  const normalized = String(code ?? '').replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return false;
  for (let step = -window; step <= window; step += 1) {
    const expected = totpCode(secret, Number(timeMs) + step * period * 1000, { digits, period });
    if (crypto.timingSafeEqual(Buffer.from(normalized), Buffer.from(expected))) return true;
  }
  return false;
}

export function totpUri(secret, { issuer = 'Wurster', account = 'Meat Locker' } = {}) {
  const label = `${issuer}:${account}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
