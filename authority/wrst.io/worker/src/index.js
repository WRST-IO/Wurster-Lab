import { AUTHORITY_ROOT, ISSUER_CERTIFICATE } from './generated-authority.js';

const te = new TextEncoder();
const AUTHORITY = 'wrst.io';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CERT_DAYS = 1095;
const DEFAULT_EMAIL_FROM = 'oink@wrst.io';
const DEFAULT_EMAIL_DAILY_LIMIT = 50;
const DEFAULT_EMAIL_PER_ADDRESS_DAILY_LIMIT = 3;
const DEFAULT_EMAIL_PER_IP_DAILY_LIMIT = 10;
const DEFAULT_EMAIL_CODE_ATTEMPTS = 8;
const MAIL_RELAY_PROTOCOL = 'wrst/mail-relay-request-1';

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}
function fromBase64(value) {
  const raw = atob(String(value));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
function toBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(raw);
}
function base64Url(value) {
  return toBase64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function json(value, status = 200, extraHeaders = {}) {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      ...extraHeaders
    }
  });
}
function error(message, status = 400, code = 'bad-request') { return json({ ok: false, error: code, message }, status); }
function normalizeDomain(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw || raw.includes('://') || raw.includes('/') || raw.includes('@') || raw.includes('*') || !raw.includes('.')) throw new Error('Publisher domain is invalid');
  if (raw.length > 253 || raw.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) throw new Error('Publisher domain is invalid');
  return raw;
}
function normalizeEmail(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(raw) || raw.length > 320) throw new Error('Publisher email is invalid');
  return raw;
}
async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? te.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((part) => part.toString(16).padStart(2, '0')).join('');
}
async function issuerPrivateKey(env) {
  if (!env.WRST_ISSUER_PRIVATE_PKCS8) throw new Error('Authority issuer secret is not configured');
  return crypto.subtle.importKey('pkcs8', fromBase64(env.WRST_ISSUER_PRIVATE_PKCS8), { name: 'Ed25519' }, false, ['sign']);
}
async function issuerPublicKey(issuerCertificate = ISSUER_CERTIFICATE) {
  return crypto.subtle.importKey('spki', fromBase64(issuerCertificate.statement.issuer.publicKeySpki), { name: 'Ed25519' }, false, ['verify']);
}
async function signStatement(statement, env) {
  const key = await issuerPrivateKey(env);
  return toBase64(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, te.encode(canonicalStringify(statement)))));
}
async function verifyIssuerSignature(statement, signature, issuerCertificate = ISSUER_CERTIFICATE) {
  return crypto.subtle.verify({ name: 'Ed25519' }, await issuerPublicKey(issuerCertificate), fromBase64(signature), te.encode(canonicalStringify(statement)));
}
async function verifyPublisherRequest(request) {
  if (request?.format !== 'wurst/publisher-certificate-request-1' || request.algorithm !== 'ed25519') throw new Error('Unsupported publisher certificate request');
  const subject = request.statement?.subject;
  if ((!subject?.domain && !subject?.email) || !subject?.fingerprint || !subject?.publicKeySpki) throw new Error('wrst.io Authority requires an email or domain publisher claim');
  const domain = subject.domain ? normalizeDomain(subject.domain) : null;
  const email = subject.email ? normalizeEmail(subject.email) : null;
  const pub = fromBase64(subject.publicKeySpki);
  if (await sha256Hex(pub) !== String(subject.fingerprint).toLowerCase()) throw new Error('Publisher fingerprint mismatch');
  const key = await crypto.subtle.importKey('spki', pub, { name: 'Ed25519' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64(request.signature), te.encode(canonicalStringify(request.statement)));
  if (!valid) throw new Error('Publisher request proof-of-possession failed');
  return { ...subject, domain, email };
}
function cleanTxtData(value) {
  const text = String(value ?? '').trim();
  const pieces = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  return pieces.length ? pieces.join('') : text;
}
async function resolveTxt(name, fetchImpl = fetch) {
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name', name);
  url.searchParams.set('type', 'TXT');
  url.searchParams.set('do', 'true');
  const response = await fetchImpl(url, { headers: { accept: 'application/dns-json' } });
  if (!response.ok) throw new Error(`DNS resolver returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.Status !== 0) return [];
  return (body.Answer ?? []).filter((answer) => answer.type === 16).map((answer) => cleanTxtData(answer.data));
}
async function requestDigest(request) { return `sha256:${await sha256Hex(te.encode(canonicalStringify(request)))}`; }

async function createDomainChallenge(request, env, now = Date.now(), issuerCertificate = ISSUER_CERTIFICATE) {
  const subject = await verifyPublisherRequest(request);
  if (!subject.domain) throw new Error('Publisher request does not contain a domain claim');
  const digest = await requestDigest(request);
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(18)));
  const recordName = `_wurst-authority.${subject.domain}`;
  const recordValue = `wrst1 challenge=${nonce} key=${subject.fingerprint}`;
  const statement = {
    format: 'wurst/authority-domain-challenge-statement-1',
    authority: AUTHORITY,
    issuerFingerprint: issuerCertificate.statement.issuer.fingerprint,
    requestDigest: digest,
    subject: { domain: subject.domain, fingerprint: subject.fingerprint },
    dns: { name: recordName, type: 'TXT', value: recordValue },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
    nonce
  };
  return { format: 'wurst/authority-domain-challenge-1', algorithm: 'ed25519', statement, signature: await signStatement(statement, env) };
}
async function verifyDomainChallenge(request, challenge, fetchImpl = fetch, now = Date.now(), issuerCertificate = ISSUER_CERTIFICATE) {
  const subject = await verifyPublisherRequest(request);
  if (!subject.domain) throw new Error('Publisher request does not contain a domain claim');
  if (challenge?.format !== 'wurst/authority-domain-challenge-1' || challenge.algorithm !== 'ed25519') throw new Error('Unsupported Authority domain challenge');
  if (!await verifyIssuerSignature(challenge.statement, challenge.signature, issuerCertificate)) throw new Error('Authority challenge signature is invalid');
  const statement = challenge.statement;
  if (statement.authority !== AUTHORITY || statement.issuerFingerprint !== issuerCertificate.statement.issuer.fingerprint) throw new Error('Authority challenge belongs to a different issuer');
  if (new Date(statement.expiresAt).getTime() < now) throw new Error('Authority challenge has expired');
  if (new Date(statement.issuedAt).getTime() > now + 60_000) throw new Error('Authority challenge is not yet valid');
  if (statement.subject?.domain !== subject.domain || statement.subject?.fingerprint !== subject.fingerprint) throw new Error('Authority challenge subject mismatch');
  if (statement.requestDigest !== await requestDigest(request)) throw new Error('Authority challenge request mismatch');
  const records = await resolveTxt(statement.dns.name, fetchImpl);
  if (!records.includes(statement.dns.value)) throw new Error(`DNS proof not found at ${statement.dns.name}`);
  return {
    subject,
    claims: [{ type: 'domain', value: subject.domain, verification: { method: 'dns-txt', record: statement.dns.name, authority: AUTHORITY } }]
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
function emailVerificationReady(env) {
  return Boolean(env.WRST_MAIL_RELAY_URL && env.WRST_MAIL_RELAY_SECRET && env.EMAIL_BUDGET && env.EMAIL_ADDRESS_RATE && env.EMAIL_IP_RATE);
}

async function relayHmacHex(secret, value) {
  const key = await crypto.subtle.importKey('raw', te.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(value)));
  return [...signature].map((part) => part.toString(16).padStart(2, '0')).join('');
}

async function sendVerificationMailViaRelay({ email, code, fingerprint, expiresAt }, env, fetchImpl = fetch, now = Date.now()) {
  if (!emailVerificationReady(env)) throw new Error('WRST.IO email verification is not configured on this Worker');
  const url = new URL(String(env.WRST_MAIL_RELAY_URL));
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('WRST.IO mail relay URL must use HTTPS');
  const timestamp = String(Math.floor(now / 1000));
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(18)));
  const body = JSON.stringify({
    format: MAIL_RELAY_PROTOCOL,
    to: email,
    code,
    publisherFingerprint: fingerprint,
    expiresAt
  });
  const signature = await relayHmacHex(env.WRST_MAIL_RELAY_SECRET, `${timestamp}\n${nonce}\n${body}`);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wrst-relay-timestamp': timestamp,
      'x-wrst-relay-nonce': nonce,
      'x-wrst-relay-signature': `v1=${signature}`
    },
    body
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok !== true) {
    const relayError = new Error(result?.message || `WRST.IO mail relay returned HTTP ${response.status}`);
    relayError.status = 502;
    relayError.code = 'mail-relay-failed';
    throw relayError;
  }
  return result;
}
async function emailSealKey(env) {
  if (!env.WRST_ISSUER_PRIVATE_PKCS8) throw new Error('Authority issuer secret is not configured');
  const raw = await crypto.subtle.digest('SHA-256', te.encode(`wrst.io/email-challenge-seal/v1\u0000${env.WRST_ISSUER_PRIVATE_PKCS8}`));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function sealEmailCode(code, env, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, await emailSealKey(env), te.encode(code));
  return { cipher: 'aes-256-gcm', iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)), aad };
}
async function openEmailCode(box, env, aad) {
  if (box?.cipher !== 'aes-256-gcm' || box.aad !== aad) throw new Error('Email challenge code box is invalid');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(box.iv), additionalData: te.encode(aad) }, await emailSealKey(env), fromBase64(box.ciphertext));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('Email challenge code box is invalid');
  }
}
function timingSafeStringEqual(a, b) {
  const aa = te.encode(String(a));
  const bb = te.encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
async function reserveEmailBudget(request, env, email, now) {
  if (!emailVerificationReady(env)) throw new Error('WRST.IO email verification is not configured on this Worker');
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const emailHash = await sha256Hex(`email:${email}`);
  const ipHash = await sha256Hex(`ip:${ip}`);
  const [addressBurst, ipBurst] = await Promise.all([
    env.EMAIL_ADDRESS_RATE.limit({ key: emailHash }),
    env.EMAIL_IP_RATE.limit({ key: ipHash })
  ]);
  if (!addressBurst.success || !ipBurst.success) {
    const rateError = new Error('Too many verification emails. Try again later.');
    rateError.status = 429;
    rateError.code = 'email-rate-limited';
    throw rateError;
  }
  const id = env.EMAIL_BUDGET.idFromName('wrst-email-budget');
  const stub = env.EMAIL_BUDGET.get(id);
  const response = await stub.fetch('https://email-budget/reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      now,
      emailHash,
      ipHash,
      globalLimit: positiveInt(env.EMAIL_DAILY_LIMIT, DEFAULT_EMAIL_DAILY_LIMIT),
      emailLimit: positiveInt(env.EMAIL_PER_ADDRESS_DAILY_LIMIT, DEFAULT_EMAIL_PER_ADDRESS_DAILY_LIMIT),
      ipLimit: positiveInt(env.EMAIL_PER_IP_DAILY_LIMIT, DEFAULT_EMAIL_PER_IP_DAILY_LIMIT)
    })
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    const budgetError = new Error(body.message || 'WRST.IO email verification daily limit reached');
    budgetError.status = 429;
    budgetError.code = body.error || 'email-budget-exhausted';
    throw budgetError;
  }
  return body;
}
async function reserveEmailCodeAttempt(httpRequest, challenge, env, now) {
  if (!env.EMAIL_BUDGET) throw new Error('WRST.IO email verification budget is not configured on this Worker');
  const ip = httpRequest.headers.get('cf-connecting-ip') || 'unknown';
  const challengeHash = await sha256Hex(`challenge:${challenge?.signature ?? ''}`);
  const ipHash = await sha256Hex(`ip:${ip}`);
  const id = env.EMAIL_BUDGET.idFromName('wrst-email-budget');
  const stub = env.EMAIL_BUDGET.get(id);
  const response = await stub.fetch('https://email-budget/attempt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operation: 'attempt',
      now,
      challengeHash,
      ipHash,
      attemptLimit: positiveInt(env.EMAIL_CODE_ATTEMPTS, DEFAULT_EMAIL_CODE_ATTEMPTS)
    })
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    const attemptError = new Error(body.message || 'Too many verification code attempts. Request a new code.');
    attemptError.status = 429;
    attemptError.code = body.error || 'email-code-rate-limited';
    throw attemptError;
  }
}
async function createEmailChallenge(httpRequest, publisherRequest, env, now = Date.now(), issuerCertificate = ISSUER_CERTIFICATE, fetchImpl = fetch) {
  const subject = await verifyPublisherRequest(publisherRequest);
  if (!subject.email) throw new Error('Publisher request does not contain an email claim');
  await reserveEmailBudget(httpRequest, env, subject.email, now);
  const digest = await requestDigest(publisherRequest);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + CHALLENGE_TTL_MS).toISOString();
  const aad = `wurst-email-challenge:${issuerCertificate.statement.issuer.fingerprint}:${subject.fingerprint}:${subject.email}:${digest}`;
  const statement = {
    format: 'wurst/authority-email-challenge-statement-1',
    authority: AUTHORITY,
    issuerFingerprint: issuerCertificate.statement.issuer.fingerprint,
    requestDigest: digest,
    subject: { email: subject.email, fingerprint: subject.fingerprint },
    codeBox: await sealEmailCode(code, env, aad),
    delivery: { from: String(env.EMAIL_FROM || DEFAULT_EMAIL_FROM), to: subject.email, transport: 'https-relay' },
    issuedAt,
    expiresAt,
    nonce: base64Url(crypto.getRandomValues(new Uint8Array(18)))
  };
  await sendVerificationMailViaRelay({ email: subject.email, code, fingerprint: subject.fingerprint, expiresAt }, env, fetchImpl, now);
  return { format: 'wurst/authority-email-challenge-1', algorithm: 'ed25519', statement, signature: await signStatement(statement, env) };
}
async function verifyEmailChallenge(httpRequest, publisherRequest, challenge, code, env, now = Date.now(), issuerCertificate = ISSUER_CERTIFICATE) {
  const subject = await verifyPublisherRequest(publisherRequest);
  if (!subject.email) throw new Error('Publisher request does not contain an email claim');
  if (!/^\d{6}$/.test(String(code ?? ''))) {
    const codeError = new Error('Email verification code must contain exactly six digits');
    codeError.status = 401;
    codeError.code = 'email-code-invalid';
    throw codeError;
  }
  if (challenge?.format !== 'wurst/authority-email-challenge-1' || challenge.algorithm !== 'ed25519') throw new Error('Unsupported Authority email challenge');
  if (!await verifyIssuerSignature(challenge.statement, challenge.signature, issuerCertificate)) throw new Error('Authority email challenge signature is invalid');
  const statement = challenge.statement;
  if (statement.authority !== AUTHORITY || statement.issuerFingerprint !== issuerCertificate.statement.issuer.fingerprint) throw new Error('Authority email challenge belongs to a different issuer');
  if (new Date(statement.expiresAt).getTime() < now) throw new Error('Authority email challenge has expired');
  if (new Date(statement.issuedAt).getTime() > now + 60_000) throw new Error('Authority email challenge is not yet valid');
  if (statement.subject?.email !== subject.email || statement.subject?.fingerprint !== subject.fingerprint) throw new Error('Authority email challenge subject mismatch');
  const digest = await requestDigest(publisherRequest);
  if (statement.requestDigest !== digest) throw new Error('Authority email challenge request mismatch');
  await reserveEmailCodeAttempt(httpRequest, challenge, env, now);
  const aad = `wurst-email-challenge:${issuerCertificate.statement.issuer.fingerprint}:${subject.fingerprint}:${subject.email}:${digest}`;
  const expected = await openEmailCode(statement.codeBox, env, aad);
  if (!timingSafeStringEqual(expected, String(code))) {
    const codeError = new Error('Email verification code is incorrect');
    codeError.status = 401;
    codeError.code = 'email-code-invalid';
    throw codeError;
  }
  return {
    subject,
    claims: [{ type: 'email', value: subject.email, verification: { method: 'email-code', authority: AUTHORITY } }]
  };
}

function normalizeClaim(claim) {
  const type = String(claim?.type ?? '').toLowerCase();
  if (type === 'domain') return { type, value: normalizeDomain(claim.value), verification: claim.verification ?? { method: 'authority-issued' } };
  if (type === 'email') return { type, value: normalizeEmail(claim.value), verification: claim.verification ?? { method: 'authority-issued' } };
  throw new Error('Unsupported publisher claim');
}
function dedupeClaims(claims = []) {
  const out = [];
  const seen = new Set();
  for (const raw of claims) {
    const claim = normalizeClaim(raw);
    const key = `${claim.type}:${claim.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}
async function existingCertificateClaims(certificate, requestSubject, now, issuerCertificate = ISSUER_CERTIFICATE) {
  if (!certificate) return [];
  if (certificate.format !== 'wurst/publisher-certificate-3' || certificate.algorithm !== 'ed25519') throw new Error('Existing publisher certificate is unsupported');
  const statement = certificate.statement;
  const issuer = statement?.issuer;
  const expectedIssuer = issuerCertificate.statement.issuer;
  if (issuer?.fingerprint !== expectedIssuer.fingerprint || issuer?.publicKeySpki !== expectedIssuer.publicKeySpki || issuer?.issuerId !== expectedIssuer.issuerId) throw new Error('Existing publisher certificate belongs to a different issuer');
  if (!await verifyIssuerSignature(statement, certificate.signature, issuerCertificate)) throw new Error('Existing publisher certificate signature is invalid');
  if (statement.expiresAt && new Date(statement.expiresAt).getTime() < now) throw new Error('Existing publisher certificate has expired');
  const rawSubject = statement.subject;
  if (rawSubject?.fingerprint !== requestSubject.fingerprint || rawSubject?.publicKeySpki !== requestSubject.publicKeySpki) throw new Error('Existing publisher certificate belongs to a different publisher key');
  const claims = dedupeClaims(statement.claims ?? []);
  for (const claim of claims) {
    if (claim.type === 'domain' && claim.value !== requestSubject.domain) throw new Error('Existing certificate domain is not present in publisher request');
    if (claim.type === 'email' && claim.value !== requestSubject.email) throw new Error('Existing certificate email is not present in publisher request');
  }
  return claims;
}
async function issuePublisherCertificate(request, proof, env, existingCertificate = null, now = Date.now(), issuerCertificate = ISSUER_CERTIFICATE) {
  const subject = await verifyPublisherRequest(request);
  const prior = await existingCertificateClaims(existingCertificate, subject, now, issuerCertificate);
  const claims = dedupeClaims([...prior, ...(proof?.claims ?? [])]);
  if (!claims.length) throw new Error('No verified publisher claims were supplied');
  const days = Number(env.PUBLISHER_CERT_DAYS || DEFAULT_CERT_DAYS);
  const expiresAt = new Date(now + (Number.isFinite(days) && days > 0 ? days : DEFAULT_CERT_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  const statement = {
    format: 'wurst/publisher-certificate-statement-3',
    serial: crypto.randomUUID(),
    subject: { fingerprint: subject.fingerprint, publicKeySpki: subject.publicKeySpki },
    claims,
    issuer: issuerCertificate.statement.issuer,
    issuedAt: new Date(now).toISOString(),
    expiresAt
  };
  return {
    format: 'wurst/publisher-certificate-3',
    algorithm: 'ed25519',
    statement,
    issuerCertificate,
    signature: await signStatement(statement, env)
  };
}

function statusForError(cause) {
  if (Number.isInteger(cause?.status)) return cause.status;
  if (/DNS proof not found/.test(cause?.message || '')) return 409;
  if (/not configured/.test(cause?.message || '')) return 503;
  return 400;
}
function codeForError(cause, fallback) { return cause?.code || fallback; }

export class EmailBudget {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    if (request.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405);
    const body = await request.json();
    const now = Number(body.now) || Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (body.operation === 'attempt') {
      const challengeHash = String(body.challengeHash || '');
      const ipHash = String(body.ipHash || '');
      if (!challengeHash || !ipHash) return json({ ok: false, error: 'invalid-attempt-key' }, 400);
      const limit = positiveInt(body.attemptLimit, DEFAULT_EMAIL_CODE_ATTEMPTS);
      const key = `attempt:${day}:${challengeHash}`;
      const count = Number(await this.ctx.storage.get(key) || 0);
      if (count >= limit) return json({ ok: false, error: 'email-code-rate-limited', message: 'Too many verification code attempts. Request a new code.' }, 429);
      await this.ctx.storage.put(key, count + 1);
      return json({ ok: true, remaining: Math.max(0, limit - count - 1) });
    }
    const globalKey = `global:${day}`;
    const emailKey = `email:${day}:${String(body.emailHash || '')}`;
    const ipKey = `ip:${day}:${String(body.ipHash || '')}`;
    const globalLimit = positiveInt(body.globalLimit, DEFAULT_EMAIL_DAILY_LIMIT);
    const emailLimit = positiveInt(body.emailLimit, DEFAULT_EMAIL_PER_ADDRESS_DAILY_LIMIT);
    const ipLimit = positiveInt(body.ipLimit, DEFAULT_EMAIL_PER_IP_DAILY_LIMIT);
    const [globalCount = 0, emailCount = 0, ipCount = 0] = await Promise.all([
      this.ctx.storage.get(globalKey),
      this.ctx.storage.get(emailKey),
      this.ctx.storage.get(ipKey)
    ]);
    if (globalCount >= globalLimit) return json({ ok: false, error: 'global-daily-limit', message: 'WRST.IO has reached its verification-email budget for today' }, 429);
    if (emailCount >= emailLimit) return json({ ok: false, error: 'address-daily-limit', message: 'This email address has received enough verification messages for today' }, 429);
    if (ipCount >= ipLimit) return json({ ok: false, error: 'ip-daily-limit', message: 'This network has requested enough verification messages for today' }, 429);
    await Promise.all([
      this.ctx.storage.put(globalKey, globalCount + 1),
      this.ctx.storage.put(emailKey, emailCount + 1),
      this.ctx.storage.put(ipKey, ipCount + 1)
    ]);
    return json({ ok: true, day, global: globalCount + 1, globalLimit });
  }
}

export async function handleRequest(request, env, deps = {}) {
  const url = new URL(request.url);
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now ?? Date.now();
  const authorityRoot = deps.authorityRoot || AUTHORITY_ROOT;
  const issuerCertificate = deps.issuerCertificate || ISSUER_CERTIFICATE;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' } });
  if (request.method === 'GET' && url.pathname === '/') {
    return json({
      service: 'WRST.IO Issuing Authority',
      authority: AUTHORITY,
      protocol: 'wurst/authority-api-2',
      discovery: 'https://wrst.io/.well-known/wurst-authority',
      issuance: true,
      emailVerification: emailVerificationReady(env)
    }, 200, { 'cache-control': 'public, max-age=300' });
  }
  if (request.method === 'POST' && url.pathname === '/v1/domain/challenge') {
    try {
      const body = await request.json();
      const requestRecord = body.request ?? body;
      return json({ ok: true, challenge: await createDomainChallenge(requestRecord, env, now, issuerCertificate) });
    } catch (cause) { return error(cause.message, statusForError(cause), codeForError(cause, 'domain-challenge-rejected')); }
  }
  if (request.method === 'POST' && url.pathname === '/v1/domain/certificate') {
    try {
      const body = await request.json();
      if (!body.request || !body.challenge) return error('request and challenge are required');
      const proof = await verifyDomainChallenge(body.request, body.challenge, fetchImpl, now, issuerCertificate);
      const certificate = await issuePublisherCertificate(body.request, proof, env, body.certificate ?? null, now, issuerCertificate);
      return json({ ok: true, certificate });
    } catch (cause) { return error(cause.message, statusForError(cause), codeForError(cause, 'domain-certificate-rejected')); }
  }
  if (request.method === 'POST' && url.pathname === '/v1/email/challenge') {
    try {
      const body = await request.json();
      const requestRecord = body.request ?? body;
      return json({ ok: true, challenge: await createEmailChallenge(request, requestRecord, env, now, issuerCertificate, fetchImpl) });
    } catch (cause) { return error(cause.message, statusForError(cause), codeForError(cause, 'email-challenge-rejected')); }
  }
  if (request.method === 'POST' && url.pathname === '/v1/email/certificate') {
    try {
      const body = await request.json();
      if (!body.request || !body.challenge || body.code == null) return error('request, challenge and code are required');
      const proof = await verifyEmailChallenge(request, body.request, body.challenge, body.code, env, now, issuerCertificate);
      const certificate = await issuePublisherCertificate(body.request, proof, env, body.certificate ?? null, now, issuerCertificate);
      return json({ ok: true, certificate });
    } catch (cause) { return error(cause.message, statusForError(cause), codeForError(cause, 'email-certificate-rejected')); }
  }
  return error('Not found', 404, 'not-found');
}

export default { fetch: (request, env) => handleRequest(request, env) };
export const __test = {
  canonicalStringify,
  createDomainChallenge,
  verifyDomainChallenge,
  createEmailChallenge,
  verifyEmailChallenge,
  issuePublisherCertificate,
  resolveTxt,
  cleanTxtData,
  verifyPublisherRequest,
  existingCertificateClaims,
  emailVerificationReady,
  sendVerificationMailViaRelay,
  relayHmacHex
};
