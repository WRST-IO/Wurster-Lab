import { TRUSTED_AUTHORITIES, TRUST_BUNDLE } from './trust-data.mjs';

const te = new TextEncoder();

function fromBase64(value) {
  const raw = atob(String(value));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function sha256Hex(value) {
  const data = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function trustedRootMatchesWeb(root, trustedAuthorities = TRUSTED_AUTHORITIES) {
  return (trustedAuthorities || []).some((candidate) => candidate?.algorithm === 'ed25519' && candidate.fingerprint === root?.fingerprint && candidate.publicKeySpki === root?.publicKeySpki);
}

async function verifyEd25519Web(publicKeySpki, statement, signature) {
  const key = await crypto.subtle.importKey('spki', fromBase64(publicKeySpki), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64(signature), te.encode(canonicalStringify(statement)));
}

export async function verifyTrustBundleWeb(bundle = TRUST_BUNDLE, trustedAuthorities = TRUSTED_AUTHORITIES) {
  try {
    if (bundle?.format !== 'wurst/trust-bundle-1' || bundle.algorithm !== 'ed25519') throw new Error('Unsupported Wurst trust bundle');
    const root = bundle.statement?.root;
    if (root?.format !== 'wurst/authority-root-1') throw new Error('Trust bundle root is missing');
    if (await sha256Hex(fromBase64(root.publicKeySpki)) !== root.fingerprint) throw new Error('Trust bundle root fingerprint mismatch');
    if (!await verifyEd25519Web(root.publicKeySpki, bundle.statement, bundle.signature)) throw new Error('Trust bundle signature is invalid');
    const trusted = trustedRootMatchesWeb(root, trustedAuthorities);
    return { status: trusted ? 'verified' : 'valid-untrusted', valid: true, trusted, root, statement: bundle.statement };
  } catch (error) {
    return { status: 'invalid', valid: false, trusted: false, error: error.message };
  }
}

export async function verifyPublisherCertificateWeb(certificate, now = new Date(), trustedAuthorities = TRUSTED_AUTHORITIES, trustBundle = TRUST_BUNDLE) {
  try {
    if (!certificate || certificate.algorithm !== 'ed25519' || certificate.format !== 'wurst/publisher-certificate-3') throw new Error('Unsupported publisher certificate');
    const statement = certificate.statement;
    const rawSubject = statement?.subject;
    const issuer = statement?.issuer;
    const chainCert = certificate.issuerCertificate;
    const claims = (statement?.claims || []).map((claim) => ({ type: String(claim?.type || '').toLowerCase(), value: String(claim?.value || ''), verification: claim?.verification || {} }));
    if (!rawSubject?.fingerprint || !rawSubject?.publicKeySpki || !claims.length) throw new Error('Publisher certificate subject or claims are incomplete');
    for (const claim of claims) {
      if (claim.type === 'domain') {
        if (!claim.value || claim.value.includes('://') || claim.value.includes('/') || claim.value.includes('@')) throw new Error('Publisher certificate domain claim is invalid');
        claim.value = claim.value.toLowerCase().replace(/\.$/, '');
      } else if (claim.type === 'email') {
        claim.value = claim.value.trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(claim.value)) throw new Error('Publisher certificate email claim is invalid');
      } else throw new Error('Unsupported publisher certificate claim type');
    }
    if (issuer?.format !== 'wurst/authority-issuer-public-1' || !issuer?.fingerprint || !issuer?.publicKeySpki) throw new Error('Publisher certificate issuer is incomplete');
    const chain = chainCert?.statement;
    const root = chain?.root;
    const chainIssuer = chain?.issuer;
    if (chainCert?.format !== 'wurst/authority-issuer-certificate-1' || chainCert.algorithm !== 'ed25519' || root?.format !== 'wurst/authority-root-1' || chainIssuer?.format !== 'wurst/authority-issuer-public-1') throw new Error('Authority issuer chain is incomplete');
    if (root.authority !== chainIssuer.authority || chain?.authority !== root.authority) throw new Error('Authority issuer certificate mismatch');
    if (await sha256Hex(fromBase64(root.publicKeySpki)) !== root.fingerprint) throw new Error('Authority root fingerprint mismatch');
    if (await sha256Hex(fromBase64(chainIssuer.publicKeySpki)) !== chainIssuer.fingerprint) throw new Error('Authority issuer fingerprint mismatch');
    if (!await verifyEd25519Web(root.publicKeySpki, chain, chainCert.signature)) throw new Error('Authority issuer certificate signature is invalid');
    if (chainIssuer.fingerprint !== issuer.fingerprint || chainIssuer.publicKeySpki !== issuer.publicKeySpki || chainIssuer.issuerId !== issuer.issuerId) throw new Error('Publisher certificate issuer chain mismatch');
    if (await sha256Hex(fromBase64(rawSubject.publicKeySpki)) !== rawSubject.fingerprint) throw new Error('Publisher certificate subject fingerprint mismatch');
    if (!await verifyEd25519Web(issuer.publicKeySpki, statement, certificate.signature)) throw new Error('Publisher certificate signature is invalid');
    const domainClaim = claims.find((claim) => claim.type === 'domain')?.value;
    const emailClaim = claims.find((claim) => claim.type === 'email')?.value;
    const subject = { ...rawSubject, ...(domainClaim ? { domain: domainClaim } : {}), ...(emailClaim ? { email: emailClaim } : {}) };
    const time = (now instanceof Date ? now : new Date(now)).getTime();
    if (Number.isNaN(time)) throw new Error('Invalid certificate verification time');
    if (chain.issuedAt && time < new Date(chain.issuedAt).getTime()) return { status: 'not-yet-valid', valid: true, trusted: false, subject, claims, issuer, root };
    if (chain.expiresAt && time > new Date(chain.expiresAt).getTime()) return { status: 'expired-issuer', valid: true, trusted: false, subject, claims, issuer, root };
    if (statement.issuedAt && time < new Date(statement.issuedAt).getTime()) return { status: 'not-yet-valid', valid: true, trusted: false, subject, claims, issuer, root };
    if (statement.expiresAt && time > new Date(statement.expiresAt).getTime()) return { status: 'expired', valid: true, trusted: false, subject, claims, issuer, root };
    const trusted = trustedRootMatchesWeb(root, trustedAuthorities);
    const bundle = await verifyTrustBundleWeb(trustBundle, trustedAuthorities);
    if (bundle.valid && bundle.trusted) {
      const revokedIssuers = new Set((bundle.statement.revokedIssuers || []).map((value) => String(value).toLowerCase()));
      const revokedPublishers = new Set((bundle.statement.revokedPublishers || []).map((value) => String(value).toLowerCase()));
      if (revokedIssuers.has(String(issuer.fingerprint).toLowerCase())) return { status: 'revoked-issuer', valid: true, trusted: false, subject, claims, issuer, root, trustBundle: bundle };
      if (revokedPublishers.has(String(subject.fingerprint).toLowerCase())) return { status: 'revoked-publisher', valid: true, trusted: false, subject, claims, issuer, root, trustBundle: bundle };
    }
    return { status: trusted ? 'verified' : 'valid-untrusted', valid: true, trusted, subject, claims, issuer, root, trustBundle: bundle };
  } catch (error) {
    return { status: 'invalid', valid: false, trusted: false, error: error.message };
  }
}
