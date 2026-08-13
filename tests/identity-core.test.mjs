import assert from 'node:assert/strict';
import { base32Decode, base32Encode, generateTotpSecret, totpCode, totpUri, verifyTotp } from '../runtime/desktop/src/identity-core.mjs';

const sample = Buffer.from('hello wurst');
assert.deepEqual(base32Decode(base32Encode(sample)), sample);
const secret = generateTotpSecret();
assert.match(secret, /^[A-Z2-7]+$/);
const now = 1710000000000;
const code = totpCode(secret, now);
assert.match(code, /^\d{6}$/);
assert.equal(verifyTotp(secret, code, now), true);
assert.equal(verifyTotp(secret, '000000', now), code === '000000');
assert.match(totpUri(secret, { account: 'Personal Meat' }), /^otpauth:\/\/totp\//);
console.log('✓ Wurster Meat Locker TOTP primitives');
