import crypto from 'node:crypto';

export const WURSTER_IDENTITY_FORMAT = 'wurst/identity-1';
export const WURSTER_IDENTITY_PROOF_FORMAT = 'wurst/identity-proof-1';
export const WURSTER_IDENTITY_KEY_WRAP_FORMAT = 'wurst/identity-keywrap-1';
export const WURSTER_IDENTITY_SIGNATURE_CONTEXT = 'wurst-identity-signature-1';

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const X25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const IDENTITY_KDF = Object.freeze({ N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
const IDENTITY_KDF_SALT = Buffer.from('wurster/meat-identity-1', 'utf8');

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function sha256Hex(value) {
  return sha256Bytes(value).toString('hex');
}

function normalizeMeatphrase(value) {
  if (typeof value !== 'string') throw new Error('Meatphrase must be a string');
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('Meatphrase cannot be empty');
  return normalized;
}

function normalizeEmoji(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? Array.from(normalized).slice(0, 8).join('') : '🐷';
}

function keyFromSeed(prefix, seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('Wurster Identity key seed must be 32 bytes');
  return crypto.createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' });
}

function publicSpki(privateKey) {
  return crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
}

function importSpki(value, expectedType) {
  const key = crypto.createPublicKey({ key: Buffer.from(String(value ?? ''), 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== expectedType) throw new Error(`Expected ${expectedType} public key`);
  return key;
}

function deriveSeeds(meatphrase) {
  const normalized = normalizeMeatphrase(meatphrase);
  const master = crypto.scryptSync(normalized, IDENTITY_KDF_SALT, 64, IDENTITY_KDF);
  const signingSeed = crypto.createHmac('sha256', master.subarray(0, 32)).update('wurster-identity-signing-ed25519').digest();
  const encryptionSeed = crypto.createHmac('sha256', master.subarray(32, 64)).update('wurster-identity-encryption-x25519').digest();
  master.fill(0);
  return { signingSeed, encryptionSeed };
}

function identityCore({ signingPublicKeySpki, encryptionPublicKeySpki }) {
  return {
    format: WURSTER_IDENTITY_FORMAT,
    algorithm: {
      signing: 'ed25519',
      encryption: 'x25519'
    },
    signingPublicKeySpki,
    encryptionPublicKeySpki
  };
}

export function wursterIdentityId({ signingPublicKeySpki, encryptionPublicKeySpki } = {}) {
  if (!signingPublicKeySpki || !encryptionPublicKeySpki) throw new Error('Wurster Identity needs signing and encryption public keys');
  const digest = sha256Hex(Buffer.from(canonicalStringify(identityCore({ signingPublicKeySpki, encryptionPublicKeySpki }))));
  return `wuid:${digest}`;
}

function identitySelfStatement(record) {
  return {
    format: WURSTER_IDENTITY_FORMAT,
    identityId: record.identityId,
    name: record.name,
    emoji: record.emoji,
    algorithm: record.algorithm,
    signingPublicKeySpki: record.signingPublicKeySpki,
    encryptionPublicKeySpki: record.encryptionPublicKeySpki,
    claims: Array.isArray(record.claims) ? record.claims : []
  };
}

export function deriveWursterIdentityMaterial(meatphrase, { name = 'Personal Meat', emoji = '🐷', claims = [] } = {}) {
  const { signingSeed, encryptionSeed } = deriveSeeds(meatphrase);
  try {
    const signingPrivateKey = keyFromSeed(ED25519_PKCS8_SEED_PREFIX, signingSeed);
    const encryptionPrivateKey = keyFromSeed(X25519_PKCS8_SEED_PREFIX, encryptionSeed);
    const signingPublicKeySpki = publicSpki(signingPrivateKey);
    const encryptionPublicKeySpki = publicSpki(encryptionPrivateKey);
    const identityId = wursterIdentityId({ signingPublicKeySpki, encryptionPublicKeySpki });
    const record = {
      ...identityCore({ signingPublicKeySpki, encryptionPublicKeySpki }),
      identityId,
      name: String(name ?? '').trim().slice(0, 120) || 'Personal Meat',
      emoji: normalizeEmoji(emoji),
      claims: Array.isArray(claims) ? structuredClone(claims) : []
    };
    const statement = identitySelfStatement(record);
    record.selfSignature = crypto.sign(null, Buffer.from(canonicalStringify(statement)), signingPrivateKey).toString('base64');
    return { publicRecord: record, signingPrivateKey, encryptionPrivateKey };
  } finally {
    signingSeed.fill(0);
    encryptionSeed.fill(0);
  }
}

export function createWursterIdentityRecord(meatphrase, options = {}) {
  return structuredClone(deriveWursterIdentityMaterial(meatphrase, options).publicRecord);
}

export function verifyWursterIdentityRecord(record) {
  try {
    if (record?.format !== WURSTER_IDENTITY_FORMAT) throw new Error('Unsupported Wurster Identity format');
    if (record?.algorithm?.signing !== 'ed25519' || record?.algorithm?.encryption !== 'x25519') throw new Error('Unsupported Wurster Identity algorithms');
    const expectedId = wursterIdentityId(record);
    if (record.identityId !== expectedId) throw new Error('Wurster Identity fingerprint mismatch');
    const key = importSpki(record.signingPublicKeySpki, 'ed25519');
    importSpki(record.encryptionPublicKeySpki, 'x25519');
    const valid = crypto.verify(null, Buffer.from(canonicalStringify(identitySelfStatement(record))), key, Buffer.from(String(record.selfSignature ?? ''), 'base64'));
    if (!valid) throw new Error('Wurster Identity self-signature is invalid');
    return { valid: true, identityId: expectedId, record: structuredClone(record) };
  } catch (error) {
    return { valid: false, error: error?.message || String(error), identityId: record?.identityId ?? null };
  }
}


export function encodeWursterIdentityString(record) {
  const verified = verifyWursterIdentityRecord(record);
  if (!verified.valid) throw new Error(`Cannot encode invalid Wurster Identity: ${verified.error}`);
  return `wurstid-v1-${Buffer.from(canonicalStringify(record)).toString('base64url')}`;
}

export function decodeWursterIdentityString(value) {
  const text = String(value ?? '').trim();
  if (!text.startsWith('wurstid-v1-')) throw new Error('Invalid Wurster Identity string');
  let record;
  try { record = JSON.parse(Buffer.from(text.slice('wurstid-v1-'.length), 'base64url').toString('utf8')); }
  catch { throw new Error('Invalid Wurster Identity string payload'); }
  const verified = verifyWursterIdentityRecord(record);
  if (!verified.valid) throw new Error(`Invalid Wurster Identity string: ${verified.error}`);
  return verified.record;
}

export function signWursterIdentityPayload(materialOrMeatphrase, payload, { context = WURSTER_IDENTITY_SIGNATURE_CONTEXT } = {}) {
  const material = typeof materialOrMeatphrase === 'string' ? deriveWursterIdentityMaterial(materialOrMeatphrase) : materialOrMeatphrase;
  if (!material?.signingPrivateKey || !material?.publicRecord) throw new Error('Signing requires Wurster Identity private material');
  const statement = {
    format: WURSTER_IDENTITY_PROOF_FORMAT,
    context: String(context),
    signer: material.publicRecord.identityId,
    payload
  };
  return {
    format: WURSTER_IDENTITY_PROOF_FORMAT,
    context: statement.context,
    signer: statement.signer,
    signature: crypto.sign(null, Buffer.from(canonicalStringify(statement)), material.signingPrivateKey).toString('base64')
  };
}

export function verifyWursterIdentityPayload(identityRecord, payload, proof, { context = WURSTER_IDENTITY_SIGNATURE_CONTEXT } = {}) {
  const identity = verifyWursterIdentityRecord(identityRecord);
  if (!identity.valid) return { valid: false, error: identity.error };
  try {
    if (proof?.format !== WURSTER_IDENTITY_PROOF_FORMAT || proof.context !== String(context) || proof.signer !== identityRecord.identityId) {
      throw new Error('Wurster Identity proof metadata mismatch');
    }
    const statement = {
      format: WURSTER_IDENTITY_PROOF_FORMAT,
      context: String(context),
      signer: identityRecord.identityId,
      payload
    };
    const key = importSpki(identityRecord.signingPublicKeySpki, 'ed25519');
    const valid = crypto.verify(null, Buffer.from(canonicalStringify(statement)), key, Buffer.from(String(proof.signature ?? ''), 'base64'));
    return valid ? { valid: true, signer: identityRecord.identityId } : { valid: false, error: 'Wurster Identity payload signature is invalid' };
  } catch (error) {
    return { valid: false, error: error?.message || String(error) };
  }
}

function realmWrapAad(realmId, recipientId, ephemeralPublicKeySpki) {
  return canonicalStringify({
    format: WURSTER_IDENTITY_KEY_WRAP_FORMAT,
    realmId: String(realmId),
    recipient: String(recipientId),
    ephemeralPublicKeySpki: String(ephemeralPublicKeySpki)
  });
}

function deriveWrapKey(sharedSecret, realmId, recipientId) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    sharedSecret,
    sha256Bytes(Buffer.from(`wurst-fs-realm:${realmId}`)),
    Buffer.from(`wurst/identity-keywrap-1:${recipientId}`),
    32
  ));
}

export function wrapKeyForWursterIdentity(keyBytes, identityRecord, { realmId = 'data' } = {}) {
  const verified = verifyWursterIdentityRecord(identityRecord);
  if (!verified.valid) throw new Error(`Cannot wrap key for invalid Wurster Identity: ${verified.error}`);
  const key = Buffer.isBuffer(keyBytes) ? Buffer.from(keyBytes) : Buffer.from(keyBytes ?? []);
  if (key.length !== 32) throw new Error('Wurster Identity key-wrap expects a 32-byte key');
  const recipientPublic = importSpki(identityRecord.encryptionPublicKeySpki, 'x25519');
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const ephemeralPublicKeySpki = ephemeral.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublic });
  const kek = deriveWrapKey(shared, realmId, identityRecord.identityId);
  shared.fill(0);
  const iv = crypto.randomBytes(12);
  const aad = realmWrapAad(realmId, identityRecord.identityId, ephemeralPublicKeySpki);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  const tag = cipher.getAuthTag();
  kek.fill(0);
  key.fill(0);
  return {
    format: WURSTER_IDENTITY_KEY_WRAP_FORMAT,
    algorithm: 'x25519+hkdf-sha256+aes-256-gcm',
    realmId: String(realmId),
    recipient: identityRecord.identityId,
    ephemeralPublicKeySpki,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

export function unwrapKeyForWursterIdentity(wrap, materialOrMeatphrase, { realmId = null } = {}) {
  const material = typeof materialOrMeatphrase === 'string' ? deriveWursterIdentityMaterial(materialOrMeatphrase) : materialOrMeatphrase;
  if (!material?.encryptionPrivateKey || !material?.publicRecord) throw new Error('Unwrapping requires Wurster Identity private material');
  if (wrap?.format !== WURSTER_IDENTITY_KEY_WRAP_FORMAT || wrap.algorithm !== 'x25519+hkdf-sha256+aes-256-gcm') throw new Error('Unsupported Wurster Identity key-wrap');
  const expectedRealm = realmId == null ? String(wrap.realmId ?? '') : String(realmId);
  if (wrap.realmId !== expectedRealm) throw new Error('Wurster Identity key-wrap realm mismatch');
  if (wrap.recipient !== material.publicRecord.identityId) throw new Error('Wurster Identity key-wrap belongs to another identity');
  const ephemeralPublic = importSpki(wrap.ephemeralPublicKeySpki, 'x25519');
  const shared = crypto.diffieHellman({ privateKey: material.encryptionPrivateKey, publicKey: ephemeralPublic });
  const kek = deriveWrapKey(shared, expectedRealm, wrap.recipient);
  shared.fill(0);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(wrap.iv, 'base64'));
    decipher.setAAD(Buffer.from(realmWrapAad(expectedRealm, wrap.recipient, wrap.ephemeralPublicKeySpki)));
    decipher.setAuthTag(Buffer.from(wrap.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(wrap.ciphertext, 'base64')), decipher.final()]);
    if (plain.length !== 32) throw new Error('Invalid unwrapped WurstFS realm key length');
    return plain;
  } catch {
    throw new Error('Wurster Identity could not unwrap this realm key');
  } finally {
    kek.fill(0);
  }
}
