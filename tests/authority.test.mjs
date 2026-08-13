import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  createAuthorityRoot,
  deriveAuthorityRoot,
  createAuthorityIssuer,
  createPublisherKeyBundle,
  createPublisherCertificateRequest,
  createPublisherCertificateFromIssuer,
  createTrustBundle,
  verifyAuthorityIssuerCertificate,
  verifyPublisherCertificate,
  verifyTrustBundle
} from '../packages/format/src/index.js';

const rootPhrase = 'smoked-wurst cured-bratwurst crispy-sausage peppered-bacon salted-ham roasted-pork grilled-brisket seared-rib charred-steak buttered-chop garlic-cutlet mustard-schnitzel maple-salami hickory-pepperoni oak-prosciutto ember-pancetta iron-jerky copper-meatball blackened-tenderloin slowcook-sirloin hotpan-rump coldcut-belly brined-shank spiced-hock';
const issuerPhrase = 'juicy-roast lean-mince fatty-patty rustic-burger butcher-cleaver firepit-grinder skillet-smoker smoked-skewer cured-marrow crispy-bone peppered-rind salted-lard roasted-tallow grilled-crackling seared-casing';
const publisherPhrase = 'peppered-bacon smoked-wurst cured-bratwurst crispy-sausage salted-ham roasted-pork grilled-brisket seared-rib charred-steak buttered-chop garlic-cutlet mustard-schnitzel';
const issuedAt = '2026-08-12T10:00:00.000Z';
const expiresAt = '2030-08-12T10:00:00.000Z';

const derivedA = deriveAuthorityRoot({ authority: 'wrst.io', name: 'WRST.IO Root Authority', meatphrase: rootPhrase, createdAt: issuedAt });
const derivedB = deriveAuthorityRoot({ authority: 'wrst.io', name: 'WRST.IO Root Authority', meatphrase: rootPhrase, createdAt: issuedAt });
assert.equal(derivedA.fingerprint, derivedB.fingerprint);
assert.equal(derivedA.publicRecord.publicKeySpki, derivedB.publicRecord.publicKeySpki);
const generated = createAuthorityRoot({ authority: 'wrst.io', meatphrase: rootPhrase, createdAt: issuedAt });
assert.equal(generated.fingerprint, derivedA.fingerprint);
console.log('✓ WRST.IO Root Authority is deterministically recoverable from its Root Meatphrase');

const issuer = createAuthorityIssuer({
  rootMeatphrase: rootPhrase,
  rootPublic: derivedA.publicRecord,
  authority: 'wrst.io',
  issuerId: 'wrst.io-issuer-test-01',
  name: 'WRST.IO Test Issuer',
  issuerMeatphrase: issuerPhrase,
  issuedAt,
  expiresAt
});
assert.equal(verifyAuthorityIssuerCertificate(issuer.certificate, [derivedA.publicRecord], new Date('2026-08-12T11:00:00Z')).status, 'verified');

const publisher = createPublisherKeyBundle({ domain: 'example.test', email: 'dev@example.test', label: 'Example Test', meatphrase: publisherPhrase });
const request = createPublisherCertificateRequest(publisher.bundle, publisherPhrase);
const certificate = createPublisherCertificateFromIssuer({
  request,
  issuerBundle: issuer.bundle,
  issuerMeatphrase: issuerPhrase,
  issuerCertificate: issuer.certificate,
  claims: [{ type: 'domain', value: 'example.test', verification: { method: 'dns-txt', domain: 'example.test' } }],
  issuedAt,
  expiresAt
});
const trustBundle = createTrustBundle({
  rootMeatphrase: rootPhrase,
  rootPublic: derivedA.publicRecord,
  authority: 'wrst.io',
  version: 1,
  issuers: [issuer.certificate],
  generatedAt: issuedAt
});
assert.equal(verifyTrustBundle(trustBundle, [derivedA.publicRecord]).status, 'verified');
assert.equal(verifyPublisherCertificate(certificate, [derivedA.publicRecord], new Date('2026-08-12T11:00:00Z'), trustBundle).status, 'verified');

const revokedPublisher = createTrustBundle({
  rootMeatphrase: rootPhrase, rootPublic: derivedA.publicRecord, authority: 'wrst.io', version: 2,
  issuers: [issuer.certificate], revokedPublishers: [publisher.bundle.fingerprint], generatedAt: '2026-08-12T11:00:00Z'
});
assert.equal(verifyPublisherCertificate(certificate, [derivedA.publicRecord], new Date('2026-08-12T11:30:00Z'), revokedPublisher).status, 'revoked-publisher');
const revokedIssuer = createTrustBundle({
  rootMeatphrase: rootPhrase, rootPublic: derivedA.publicRecord, authority: 'wrst.io', version: 3,
  issuers: [issuer.certificate], revokedIssuers: [issuer.fingerprint], generatedAt: '2026-08-12T11:00:00Z'
});
assert.equal(verifyPublisherCertificate(certificate, [derivedA.publicRecord], new Date('2026-08-12T11:30:00Z'), revokedIssuer).status, 'revoked-issuer');
console.log('✓ Root → issuer → publisher chains verify fully offline and signed trust bundles revoke issuers or publishers');

const bundledRoot = JSON.parse(await fs.readFile(new URL('../authority/wrst.io/public/root.json', import.meta.url), 'utf8'));
const bundledIssuer = JSON.parse(await fs.readFile(new URL('../authority/wrst.io/public/issuer.json', import.meta.url), 'utf8'));
const bundledTrust = JSON.parse(await fs.readFile(new URL('../authority/wrst.io/public/trust-bundle.json', import.meta.url), 'utf8'));
assert.equal(bundledRoot.authority, 'wrst.io');
assert.equal(verifyAuthorityIssuerCertificate(bundledIssuer, [bundledRoot]).status, 'verified');
assert.equal(verifyTrustBundle(bundledTrust, [bundledRoot]).status, 'verified');
console.log(`✓ bundled ${bundledRoot.development ? 'development' : 'production'} wrst.io trust material is internally valid`);
