import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  createAuthorityIssuer,
  createAuthorityRoot,
  createPublisherKeyBundle,
  createPublisherCertificateRequest,
  createPackageSignature,
  createTrustBundle,
  decodeWurst,
  encodeWurst,
  unlockAuthorityIssuerPrivateKey,
  verifyPublisherCertificate
} from '../packages/format/src/index.js';
import { EmailBudget, handleRequest, __test as workerTest } from '../authority/wrst.io/worker/src/index.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const rootPhrase = 'root-one root-two root-three root-four root-five root-six root-seven root-eight root-nine root-ten root-eleven root-twelve root-thirteen root-fourteen root-fifteen root-sixteen root-seventeen root-eighteen root-nineteen root-twenty root-twentyone root-twentytwo root-twentythree root-twentyfour';
const issuerPhrase = 'issuer-one issuer-two issuer-three issuer-four issuer-five issuer-six issuer-seven issuer-eight issuer-nine issuer-ten issuer-eleven issuer-twelve issuer-thirteen issuer-fourteen issuer-fifteen issuer-sixteen';
const rootFixture = createAuthorityRoot({ authority: 'wrst.io', name: 'WRST.IO Test Root', meatphrase: rootPhrase, createdAt: '2026-01-01T00:00:00.000Z' });
const issuerFixture = createAuthorityIssuer({
  rootMeatphrase: rootPhrase,
  rootPublic: rootFixture.publicRecord,
  authority: 'wrst.io',
  issuerId: 'wrst.io-test-issuer-1',
  name: 'WRST.IO Test Issuer',
  issuerMeatphrase: issuerPhrase,
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2030-01-01T00:00:00.000Z'
});
const trustBundle = createTrustBundle({
  rootMeatphrase: rootPhrase,
  rootPublic: rootFixture.publicRecord,
  authority: 'wrst.io',
  version: 1,
  issuers: [issuerFixture.certificate],
  generatedAt: '2026-01-01T00:00:00.000Z'
});
const issuerPrivateKey = unlockAuthorityIssuerPrivateKey(issuerFixture.bundle, issuerPhrase);
const TEST_ISSUER_PKCS8 = issuerPrivateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const root = rootFixture.publicRecord;
const workerDeps = { authorityRoot: rootFixture.publicRecord, issuerCertificate: issuerFixture.certificate };

const phrase = 'peppered-bacon smoked-wurst cured-bratwurst crispy-sausage salted-ham roasted-pork grilled-brisket seared-rib charred-steak buttered-chop garlic-cutlet mustard-schnitzel';
const publisher = createPublisherKeyBundle({ domain: 'worker.example.test', email: 'dev@worker.example.test', label: 'Worker Test', meatphrase: phrase });
const publisherRequest = createPublisherCertificateRequest(publisher.bundle, phrase);
const env = { WRST_ISSUER_PRIVATE_PKCS8: TEST_ISSUER_PKCS8, PUBLISHER_CERT_DAYS: '365' };
const now = Date.parse('2026-08-12T11:00:00.000Z');

const statusResponse = await handleRequest(new Request('https://authority.wrst.io/'), env, { now, ...workerDeps });
assert.equal(statusResponse.status, 200);
const statusBody = await statusResponse.json();
assert.equal(statusBody.discovery, 'https://wrst.io/.well-known/wurst-authority');
const removedDiscoveryResponse = await handleRequest(new Request('https://authority.wrst.io/.well-known/wurst-authority'), env, { now, ...workerDeps });
assert.equal(removedDiscoveryResponse.status, 404, 'Public discovery belongs to static wrst.io, not the issuing Worker');


const challengeResponse = await handleRequest(new Request('https://authority.wrst.io/v1/domain/challenge', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: publisherRequest })
}), env, { now, ...workerDeps });
assert.equal(challengeResponse.status, 200);
const challengeBody = await challengeResponse.json();
assert.equal(challengeBody.ok, true);
assert.equal(challengeBody.challenge.statement.dns.name, '_wurst-authority.worker.example.test');

const dnsValue = challengeBody.challenge.statement.dns.value;
const dnsFetch = async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 16, data: `"${dnsValue}"` }] }), {
  status: 200, headers: { 'content-type': 'application/dns-json' }
});
const certResponse = await handleRequest(new Request('https://authority.wrst.io/v1/domain/certificate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: publisherRequest, challenge: challengeBody.challenge })
}), env, { now: now + 60_000, fetchImpl: dnsFetch, ...workerDeps });
assert.equal(certResponse.status, 200);
const certBody = await certResponse.json();
assert.equal(certBody.ok, true);
const verified = verifyPublisherCertificate(certBody.certificate, [root], new Date(now + 120_000), trustBundle);
assert.equal(verified.status, 'verified');
assert.equal(verified.subject.domain, 'worker.example.test');
assert.equal(verified.subject.email, undefined, 'DNS issuance must not attest the request email claim');
const unsigned = decodeWurst(encodeWurst({ manifest: { format: 'wurst/7', id: 'io.wrst.worker-cert', name: 'Worker Cert Wurst', version: '0.20.0', entry: 'index.html', type: 'widget', application: { protection: 'public' }, protection: { storedIdentity: true }, capabilities: {}, security: { signed: true } }, files: [{ path: 'index.html', data: Buffer.from('<h1>worker cert</h1>'), scope: 'app', mime: 'text/html' }] }));
assert.doesNotThrow(() => createPackageSignature(unsigned, publisher.bundle, phrase, { certificate: certBody.certificate }), 'A domain-only Authority certificate must be allowed to attest the key/domain subset of a publisher identity that also carries an unverified email claim');
console.log('✓ stateless Cloudflare Authority Worker issues an offline-verifiable publisher certificate after signed DNS proof');


const budgetStorageMap = new Map();
const budgetStorage = {
  get: async (key) => budgetStorageMap.get(key),
  put: async (key, value) => { budgetStorageMap.set(key, value); }
};
const emailBudget = new EmailBudget({ storage: budgetStorage });
let sentEmail = null;
const relaySecret = 'test-relay-secret-that-is-long-enough-for-hmac-fixtures';
function relayFetchCapture(setter) {
  return async (input, init = {}) => {
    assert.equal(String(input), 'https://mail.example.test/wrst-mail-relay.php');
    const bodyText = String(init.body || '');
    const body = JSON.parse(bodyText);
    const timestamp = String(init.headers['x-wrst-relay-timestamp']);
    const nonce = String(init.headers['x-wrst-relay-nonce']);
    const signature = String(init.headers['x-wrst-relay-signature']);
    assert.match(timestamp, /^\d+$/);
    assert.match(nonce, /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(signature, `v1=${await workerTest.relayHmacHex(relaySecret, `${timestamp}\n${nonce}\n${bodyText}`)}`);
    setter(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
const emailEnv = {
  ...env,
  EMAIL_FROM: 'oink@wrst.io',
  EMAIL_DAILY_LIMIT: '50',
  EMAIL_PER_ADDRESS_DAILY_LIMIT: '3',
  EMAIL_PER_IP_DAILY_LIMIT: '10',
  WRST_MAIL_RELAY_URL: 'https://mail.example.test/wrst-mail-relay.php',
  WRST_MAIL_RELAY_SECRET: relaySecret,
  EMAIL_ADDRESS_RATE: { limit: async () => ({ success: true }) },
  EMAIL_IP_RATE: { limit: async () => ({ success: true }) },
  EMAIL_BUDGET: {
    idFromName: () => ({ name: 'budget' }),
    get: () => ({ fetch: (input, init) => emailBudget.fetch(new Request(input, init)) })
  }
};
const emailChallengeResponse = await handleRequest(new Request('https://authority.wrst.io/v1/email/challenge', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify({ request: publisherRequest })
}), emailEnv, { now: now + 180_000, fetchImpl: relayFetchCapture((body) => { sentEmail = body; }), ...workerDeps });
if (emailChallengeResponse.status !== 200) console.log('EMAIL CHALLENGE ERROR', await emailChallengeResponse.clone().text());
assert.equal(emailChallengeResponse.status, 200);
const emailChallengeBody = await emailChallengeResponse.json();
assert.equal(emailChallengeBody.ok, true);
assert.equal(emailChallengeBody.challenge.statement.subject.email, 'dev@worker.example.test');
assert.equal(sentEmail.format, 'wrst/mail-relay-request-1');
assert.equal(sentEmail.to, 'dev@worker.example.test');
const code = sentEmail.code;
assert.match(code, /^\d{6}$/);
assert.equal(JSON.stringify(emailChallengeBody.challenge).includes(code), false, 'Six-digit email code must not be recoverable from the client challenge payload as plaintext');

const failedRelayResponse = await handleRequest(new Request('https://authority.wrst.io/v1/email/challenge', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.77' }, body: JSON.stringify({ request: publisherRequest })
}), {
  ...emailEnv,
  EMAIL_BUDGET: {
    idFromName: () => ({ name: 'failed-relay-budget' }),
    get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }) })
  }
}, { now: now + 181_000, fetchImpl: async () => new Response(JSON.stringify({ ok: false, message: 'mail transport unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }), ...workerDeps });
assert.equal(failedRelayResponse.status, 502);
assert.equal((await failedRelayResponse.json()).error, 'mail-relay-failed');


const wrongEmailCertificate = await handleRequest(new Request('https://authority.wrst.io/v1/email/certificate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: publisherRequest, challenge: emailChallengeBody.challenge, code: code === '000000' ? '000001' : '000000', certificate: certBody.certificate })
}), emailEnv, { now: now + 200_000, ...workerDeps });
assert.equal(wrongEmailCertificate.status, 401);

// A six-digit code has only one million possibilities. The Worker must not allow
// an attacker to brute-force a live challenge. The first wrong attempt above
// already consumed one slot, so seven more wrong submissions are accepted as
// invalid codes and the ninth total attempt is rate-limited before comparison.
for (let attempt = 0; attempt < 7; attempt += 1) {
  const response = await handleRequest(new Request('https://authority.wrst.io/v1/email/certificate', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify({ request: publisherRequest, challenge: emailChallengeBody.challenge, code: code === '111111' ? '222222' : '111111', certificate: certBody.certificate })
  }), emailEnv, { now: now + 201_000 + attempt, ...workerDeps });
  assert.equal(response.status, 401);
}
const blockedEmailCertificate = await handleRequest(new Request('https://authority.wrst.io/v1/email/certificate', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify({ request: publisherRequest, challenge: emailChallengeBody.challenge, code, certificate: certBody.certificate })
}), emailEnv, { now: now + 209_000, ...workerDeps });
assert.equal(blockedEmailCertificate.status, 429);
const blockedBody = await blockedEmailCertificate.json();
assert.equal(blockedBody.error, 'email-code-rate-limited');

// A fresh challenge resets the guess budget while preserving the daily delivery
// budget. Use a new in-memory Durable Object here to keep the successful issuance
// path independent from the brute-force fixture above.
const successBudgetStorageMap = new Map();
const successBudget = new EmailBudget({ storage: {
  get: async (key) => successBudgetStorageMap.get(key),
  put: async (key, value) => { successBudgetStorageMap.set(key, value); }
} });
const successEmailEnv = {
  ...emailEnv,
  EMAIL_BUDGET: {
    idFromName: () => ({ name: 'success-budget' }),
    get: () => ({ fetch: (input, init) => successBudget.fetch(new Request(input, init)) })
  }
};
let successCode = null;
const successChallengeResponse = await handleRequest(new Request('https://authority.wrst.io/v1/email/challenge', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.8' }, body: JSON.stringify({ request: publisherRequest })
}), successEmailEnv, { now: now + 210_000, fetchImpl: relayFetchCapture((body) => { successCode = body.code; }), ...workerDeps });
assert.equal(successChallengeResponse.status, 200);
const successChallengeBody = await successChallengeResponse.json();
assert.match(successCode, /^\d{6}$/);

const emailCertificateResponse = await handleRequest(new Request('https://authority.wrst.io/v1/email/certificate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: publisherRequest, challenge: successChallengeBody.challenge, code: successCode, certificate: certBody.certificate })
}), successEmailEnv, { now: now + 220_000, ...workerDeps });
assert.equal(emailCertificateResponse.status, 200);
const emailCertBody = await emailCertificateResponse.json();
const emailVerified = verifyPublisherCertificate(emailCertBody.certificate, [root], new Date(now + 230_000), trustBundle);
assert.equal(emailVerified.status, 'verified');
assert.deepEqual(emailVerified.claims.map((claim) => [claim.type, claim.value]), [
  ['domain', 'worker.example.test'],
  ['email', 'dev@worker.example.test']
]);
assert.doesNotThrow(() => createPackageSignature(unsigned, publisher.bundle, phrase, { certificate: emailCertBody.certificate }));
console.log('✓ WRST.IO email verification HMACs a six-digit relay job, caps guesses and merges email + domain claims into one offline certificate');
// Email is a first-class verification path. A publisher does not need a domain
// claim at all; WRST.IO certifies only the email/key pair that was actually
// proven by the six-digit challenge.
const emailOnlyPhrase = 'email-only publisher meatphrase without domain claim twelve tokens exactly enough for fixture';
const emailOnlyPublisher = createPublisherKeyBundle({ email: 'erna@example.test', label: 'Oma Erna', meatphrase: emailOnlyPhrase });
const emailOnlyRequest = createPublisherCertificateRequest(emailOnlyPublisher.bundle, emailOnlyPhrase);
const emailOnlyBudgetMap = new Map();
const emailOnlyBudget = new EmailBudget({ storage: {
  get: async (key) => emailOnlyBudgetMap.get(key),
  put: async (key, value) => { emailOnlyBudgetMap.set(key, value); }
} });
let emailOnlyCode = null;
const emailOnlyEnv = {
  ...emailEnv,
  EMAIL_BUDGET: {
    idFromName: () => ({ name: 'email-only-budget' }),
    get: () => ({ fetch: (input, init) => emailOnlyBudget.fetch(new Request(input, init)) })
  }
};
const emailOnlyChallengeResponse = await handleRequest(new Request('https://authority.wrst.io/v1/email/challenge', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify({ request: emailOnlyRequest })
}), emailOnlyEnv, { now: now + 240_000, fetchImpl: relayFetchCapture((body) => { emailOnlyCode = body.code; }), ...workerDeps });
assert.equal(emailOnlyChallengeResponse.status, 200);
const emailOnlyChallenge = (await emailOnlyChallengeResponse.json()).challenge;
assert.match(emailOnlyCode, /^\d{6}$/);
const emailOnlyCertificateResponse = await handleRequest(new Request('https://authority.wrst.io/v1/email/certificate', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify({ request: emailOnlyRequest, challenge: emailOnlyChallenge, code: emailOnlyCode })
}), emailOnlyEnv, { now: now + 250_000, ...workerDeps });
assert.equal(emailOnlyCertificateResponse.status, 200);
const emailOnlyCertificate = (await emailOnlyCertificateResponse.json()).certificate;
const emailOnlyVerified = verifyPublisherCertificate(emailOnlyCertificate, [root], new Date(now + 260_000), trustBundle);
assert.equal(emailOnlyVerified.status, 'verified');
assert.deepEqual(emailOnlyVerified.claims.map((claim) => [claim.type, claim.value]), [['email', 'erna@example.test']]);
assert.equal(emailOnlyVerified.subject.domain, undefined);
console.log('✓ WRST.IO email verification works independently without any domain claim');

