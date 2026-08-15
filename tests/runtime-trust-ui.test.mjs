import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { secureTrustPresentation, verificationTrustRoute } from '../runtime/desktop/src/publisher-trust-presentation.mjs';

const publisher = {
  domain: 'yourwurstdomain.tld',
  label: 'Your Wurst Studio',
  fingerprint: 'a'.repeat(64)
};
const signature = { status: 'signed', valid: true, publisher };

const verified = secureTrustPresentation({
  signature,
  publisherTrust: { kind: 'domain', trusted: true, domain: { domain: 'yourwurstdomain.tld' } }
});
assert.equal(verified.level, 'verified');
assert.equal(verified.publisher, 'yourwurstdomain.tld');
assert.equal(verified.fingerprint, publisher.fingerprint);
assert.match(verified.detail, /DNS/);
assert.equal(verificationTrustRoute({ kind: 'domain', domain: { domain: 'yourwurstdomain.tld' } }), 'Live DNS · yourwurstdomain.tld');

const authorityVerified = secureTrustPresentation({
  signature: { ...signature, publisher: { ...publisher, email: 'pig@example.com' } },
  publisherTrust: {
    kind: 'authority', trusted: true, authority: 'WRST.IO',
    certificate: { subject: { fingerprint: publisher.fingerprint, publicKeySpki: 'test', email: 'pig@example.com' }, claims: [{ type: 'email', value: 'pig@example.com', verification: { method: 'email-code' } }] }
  }
});
assert.equal(authorityVerified.level, 'verified');
assert.equal(authorityVerified.publisher, 'pig@example.com', 'Authority presentation must prefer the exact certified claim over a self-declared domain/label');
assert.match(authorityVerified.detail, /Verified by WRST\.IO/);
assert.match(authorityVerified.detail, /email: pig@example\.com/);

const unknown = secureTrustPresentation({ signature, publisherTrust: { kind: 'signed-unknown', trusted: false } });
assert.equal(unknown.level, 'signed');
assert.match(unknown.detail, /not independently verified/i);

const conflict = secureTrustPresentation({
  signature,
  publisherTrust: { kind: 'domain-conflict', trusted: false, domain: { domain: 'yourwurstdomain.tld' } }
});
assert.equal(conflict.level, 'danger');
assert.match(conflict.detail, /does not authorize/);

const unsigned = secureTrustPresentation({ signature: { status: 'unsigned', valid: false, publisher: null }, publisherTrust: { kind: 'unsigned' } });
assert.equal(unsigned.level, 'warning');
assert.equal(unsigned.publisher, null);

const root = path.resolve(import.meta.dirname, '..');
const preload = await fs.readFile(path.join(root, 'runtime/desktop/src/wurst-preload.cjs'), 'utf8');
assert.match(preload, /querySelectorAll\('wurst-identity'\)/);
assert.match(preload, /wurst:identity:anchors/);
assert.match(preload, /clippedElementGeometry/);
assert.match(preload, /overflowX/);
assert.match(preload, /clipWidth/);


const trustedSurfaceRuntime = await fs.readFile(path.join(root, 'runtime/desktop/src/trusted-surface-runtime.mjs'), 'utf8');
assert.match(trustedSurfaceRuntime, /wurster:identity:layout/);
assert.match(trustedSurfaceRuntime, /controlBounds/);
const identityControl = await fs.readFile(path.join(root, 'runtime/desktop/src/identity-control.html'), 'utf8');
assert.match(identityControl, /wurster-identity-layout/);

const installer = await fs.readFile(path.join(root, 'runtime/desktop/build/installer.nsh'), 'utf8');
assert.match(installer, /Wurster\.Wurst\\shell\\VerifyWurstIdentity/);
assert.match(installer, /Wurster\.Wrst\\shell\\VerifyWurstIdentity/);
assert.match(installer, /--verify-wurst-identity/);
assert.doesNotMatch(installer, /\*\\shell\\VerifyWurstIdentity/);

for (const relative of ['runtime/desktop/src/launcher.html', 'runtime/desktop/src/settings.html', 'docs/meatgrinder.md']) {
  const text = await fs.readFile(path.join(root, relative), 'utf8');
  assert.doesNotMatch(text, /vwgame/i);
  assert.match(text, /yourwurstdomain/i);
}
const desktopMain = await fs.readFile(path.join(root, 'runtime/desktop/src/main.mjs'), 'utf8');
assert.match(desktopMain, /publisherCertificate: signerMaterial\?\.certificate/, 'GUI-signed Wursts must carry a stored WRST.IO publisher certificate');
assert.match(desktopMain, /\/v1\/email\/challenge/);
assert.match(await fs.readFile(path.join(root, 'runtime/desktop/src/launcher.html'), 'utf8'), /Verify with WRST\.IO/);
assert.match(await fs.readFile(path.join(root, 'runtime/desktop/src/settings.html'), 'utf8'), /oink@wrst\.io/);

console.log('✓ Wurst Identity trusted surface presentation, exact WRST.IO claims and scoped Windows verification verb');
