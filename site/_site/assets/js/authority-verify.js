import { verifyPublisherCertificateWeb } from '/assets/wurster/wurster.min.js';
const DEFAULT_AUTHORITY = 'https://authority.wrst.io';
let authorityBase = DEFAULT_AUTHORITY;
const $ = (selector) => document.querySelector(selector);
const te = new TextEncoder();
let requestRecord = null;
let certificateRecord = null;
let domainChallenge = null;
let emailChallenge = null;
let authorityMetadata = null;
let certificateVerified = false;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function bytesFromBase64(value) {
  const raw = atob(String(value));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((part) => part.toString(16).padStart(2, '0')).join('');
}
async function verifyRequest(record) {
  if (record?.format !== 'wurst/publisher-certificate-request-1' || record.algorithm !== 'ed25519') throw new Error('This is not a supported Wurst publisher request.');
  const subject = record.statement?.subject;
  if ((!subject?.domain && !subject?.email) || !subject?.fingerprint || !subject?.publicKeySpki) throw new Error('The publisher request has no verifiable domain or email claim.');
  const spki = bytesFromBase64(subject.publicKeySpki);
  if (await sha256Hex(spki) !== String(subject.fingerprint).toLowerCase()) throw new Error('Publisher key fingerprint mismatch.');
  const key = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, bytesFromBase64(record.signature), te.encode(canonical(record.statement)));
  if (!valid) throw new Error('Publisher proof-of-possession signature is invalid.');
  return subject;
}
async function readJson(file) {
  if (!file) return null;
  return JSON.parse(await file.text());
}
function status(message, kind = '') {
  const el = $('#verifyStatus');
  el.textContent = message;
  el.dataset.kind = kind;
}
function claimList(cert) {
  if (!cert) return [];
  if (cert.format === 'wurst/publisher-certificate-3') return Array.isArray(cert.statement?.claims) ? cert.statement.claims : [];
  const s = cert.statement?.subject ?? {};
  return [
    ...(s.domain ? [{ type: 'domain', value: s.domain }] : []),
    ...(s.email ? [{ type: 'email', value: s.email }] : [])
  ];
}
function hasClaim(type) { return claimList(certificateRecord).some((claim) => claim.type === type); }
function paintCertificate() {
  const result = $('#certificateResult');
  if (!certificateRecord || !certificateVerified) { result.classList.add('hidden'); return; }
  const claims = claimList(certificateRecord);
  if (!claims.length) { result.classList.add('hidden'); return; }
  $('#certificateClaims').textContent = claims.map((claim) => `${claim.type}: ${claim.value}`).join(' · ');
  result.classList.remove('hidden');
  if (hasClaim('domain')) $('#domainCard')?.classList.add('claim-done');
  if (hasClaim('email')) $('#emailCard')?.classList.add('claim-done');
}
async function authorityPost(pathname, payload) {
  const response = await fetch(new URL(pathname, authorityBase), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `WRST.IO returned HTTP ${response.status}`);
  return body;
}
function downloadJson(record, name) {
  const blob = new Blob([`${JSON.stringify(record, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function certificateName() {
  const s = requestRecord?.statement?.subject ?? {};
  return `${String(s.domain || s.email || 'publisher').replace(/[^a-z0-9._-]+/gi, '_')}.wurstcert`;
}
async function loadRequest(file) {
  requestRecord = await readJson(file);
  const subject = await verifyRequest(requestRecord);
  if (certificateRecord && certificateVerified) { const certStatus = await verifyPublisherCertificateWeb(certificateRecord); if (certStatus.subject?.fingerprint !== subject.fingerprint) { certificateRecord = null; certificateVerified = false; $('#certificateFileName').textContent = 'Optional, to add another verified claim'; } }
  $('#requestFileName').textContent = file.name;
  $('#subjectFingerprint').textContent = subject.fingerprint;
  $('#subjectDomain').textContent = subject.domain || '—';
  $('#subjectEmail').textContent = subject.email || '—';
  $('#subjectCard').classList.remove('hidden');
  $('#claimActions').classList.remove('hidden');
  $('#domainCard').classList.toggle('hidden', !subject.domain);
  $('#emailCard').classList.toggle('hidden', !subject.email);
  $('#emailUnavailable').classList.toggle('hidden', Boolean(authorityMetadata?.claims?.email?.supported));
  $('#emailBegin').disabled = !authorityMetadata?.claims?.email?.supported;
  domainChallenge = null; emailChallenge = null;
  $('#domainChallenge').classList.add('hidden'); $('#domainReady').classList.remove('hidden');
  $('#emailChallenge').classList.add('hidden'); $('#emailReady').classList.remove('hidden');
  status('Signed publisher request verified locally. Choose a claim to prove.', 'good');
  paintCertificate();
}

$('#requestFile').addEventListener('change', async (event) => {
  try { await loadRequest(event.target.files?.[0]); } catch (error) { requestRecord = null; status(error.message, 'bad'); }
});
$('#certificateFile').addEventListener('change', async (event) => {
  try {
    const candidate = await readJson(event.target.files?.[0]);
    const verification = await verifyPublisherCertificateWeb(candidate);
    if (verification?.status !== 'verified') throw new Error(verification?.error || `certificate status is ${verification?.status || 'invalid'}`);
    if (requestRecord && verification.subject?.fingerprint !== requestRecord.statement?.subject?.fingerprint) throw new Error('Certificate belongs to a different publisher key.');
    certificateRecord = candidate; certificateVerified = true;
    $('#certificateFileName').textContent = event.target.files?.[0]?.name || 'Existing certificate loaded';
    paintCertificate();
    status('Existing WRST.IO certificate verified locally. A new claim can be merged for the same publisher key.', 'good');
  } catch (error) { certificateRecord = null; certificateVerified = false; paintCertificate(); status(`Certificate could not be verified: ${error.message}`, 'bad'); }
});
$('#domainBegin').addEventListener('click', async () => {
  try {
    if (!requestRecord) throw new Error('Choose a .wurstreq first.');
    status('Asking WRST.IO for a DNS challenge…');
    const body = await authorityPost('/v1/domain/challenge', { request: requestRecord });
    domainChallenge = body.challenge;
    $('#domainRecordName').textContent = domainChallenge.statement.dns.name;
    $('#domainRecordValue').textContent = domainChallenge.statement.dns.value;
    $('#domainReady').classList.add('hidden'); $('#domainChallenge').classList.remove('hidden');
    status('DNS challenge ready. Nothing has been certified yet.');
  } catch (error) { status(error.message, 'bad'); }
});
$('#domainComplete').addEventListener('click', async () => {
  try {
    status('WRST.IO is checking DNS…');
    const body = await authorityPost('/v1/domain/certificate', { request: requestRecord, challenge: domainChallenge, certificate: certificateRecord });
    certificateRecord = body.certificate;
    certificateVerified = (await verifyPublisherCertificateWeb(certificateRecord))?.status === 'verified';
    if (!certificateVerified) throw new Error('WRST.IO returned a certificate this browser cannot verify against its pinned trust data.');
    paintCertificate();
    status('Domain verified. The downloaded certificate can now be checked offline.', 'good');
  } catch (error) { status(error.message, 'bad'); }
});
$('#emailBegin').addEventListener('click', async () => {
  try {
    if (!authorityMetadata?.claims?.email?.supported) throw new Error('WRST.IO email verification is not supported by this discovery document.');
    status('Asking WRST.IO to send a verification code…');
    const body = await authorityPost('/v1/email/challenge', { request: requestRecord });
    emailChallenge = body.challenge;
    $('#emailReady').classList.add('hidden'); $('#emailChallenge').classList.remove('hidden');
    $('#emailCode').focus();
    status('Mail sent. Enter the six-digit code.');
  } catch (error) { status(error.message, 'bad'); }
});
$('#emailComplete').addEventListener('click', async () => {
  try {
    const code = $('#emailCode').value.replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(code)) throw new Error('Enter all six digits from the WRST.IO email.');
    status('WRST.IO is checking the code…');
    const body = await authorityPost('/v1/email/certificate', { request: requestRecord, challenge: emailChallenge, code, certificate: certificateRecord });
    certificateRecord = body.certificate;
    certificateVerified = (await verifyPublisherCertificateWeb(certificateRecord))?.status === 'verified';
    if (!certificateVerified) throw new Error('WRST.IO returned a certificate this browser cannot verify against its pinned trust data.');
    paintCertificate();
    status('Email verified. The certificate remains verifiable offline.', 'good');
  } catch (error) { status(error.message, 'bad'); }
});
$('#emailCode').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
$('#downloadCertificate').addEventListener('click', () => certificateRecord && downloadJson(certificateRecord, certificateName()));

try {
  const response = await fetch('/.well-known/wurst-authority');
  authorityMetadata = response.ok ? await response.json() : null;
  if (authorityMetadata?.issuance?.baseUrl) authorityBase = authorityMetadata.issuance.baseUrl;
} catch { authorityMetadata = null; }
