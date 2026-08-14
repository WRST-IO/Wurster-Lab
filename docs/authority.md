---
title: WRST.IO Authority
group: Security & Trust
groupOrder: 4
order: 4
---

# WRST.IO Authority

`wrst.io` is the official Wurster project domain and the **only Authority root trusted by default in Wurster V1**. WRST.IO is a project, not a company, incorporated entity or identity provider. Its Authority is a convenience trust service for Wurst publisher claims, not a network dependency and not a requirement for valid Wursts.

The certificate formats remain extensible, but V1 intentionally ships no third-party Authority root, delegated public sub-authority program or root-management UI.

## Offline-first trust chain

```text
WRST.IO Root Authority          offline Root Meatphrase
        |
        | signs rarely
        v
WRST.IO Issuing Authority      Cloudflare Worker key
        |
        | signs verified publisher claims
        v
Publisher certificate          embedded in each signed Wurst
        |
        | publisher signs locally
        v
.wurst / .wrst                 verifies offline
```

A Wurster runtime ships the Root Authority **public** key and a Root-signed trust bundle. The Root private key is never deployed. A Wurst carrying a valid issuer and publisher chain can therefore be verified on a machine that has never contacted `authority.wrst.io`.

The domain is not the cryptographic trust anchor. The pinned Ed25519 Root public key is. Moving the website or Authority endpoint does not invalidate already issued certificates.

UI wording is therefore **Verified by WRST.IO**. `authority.wrst.io` is only the technical issuance endpoint.

## Verified claims

WRST.IO only certifies facts it actually checked. `wurst/publisher-certificate-3` binds the publisher public key to a list of independently verified claims.

Current V1 claim types are:

- `domain` — control of a DNS namespace proven by a short-lived TXT challenge.
- `email` — control of an email inbox proven by a short-lived six-digit code sent by WRST.IO.

A publisher label such as `John Doe` or `Fantastic Wurst Studio` remains self-declared unless a future verification method explicitly proves that identity. A certificate must never silently promote an unverified label or contact field into a verified claim.

A certificate may contain more than one verified claim for the same publisher key. For example, verifying a domain first and an email later produces one certificate containing both claims.

## Root Meatphrase

The production Root is deterministically derived from a 24-token Meatphrase (264 bits of generated dictionary entropy). The phrase is the recovery material for the Root private key.

Run production bootstrap only on the trusted operator machine. The command refuses non-interactive/CI output by default:

```bash
npm run authority:bootstrap
```

Bootstrap prints the Root Meatphrase once together with its public fingerprint. If an operator supplies a phrase file instead of letting Wurster generate one, production bootstrap requires exactly 24 space-separated tokens; the separate issuer phrase uses 16 tokens. Print the phrase and fingerprint, then run `npm run authority:root-check` and type the phrase back from paper before storing it offline. Wurster does not write the Root private key to disk.

The repository initially contains a conspicuously marked **development Root** so tests can run before production bootstrap. `npm run authority:production-check` fails while that development Root is active.

## Online issuer

Bootstrap also creates a separate Ed25519 Issuing Authority. Its private key is encrypted locally as:

```text
authority/wrst.io/private/issuer.wurstissuer
```

That directory is gitignored and excluded from Wurster Lab release ZIPs. The encrypted backup has its own Issuer Meatphrase. The Cloudflare Worker receives only the decrypted issuer PKCS#8 key through the `WRST_ISSUER_PRIVATE_PKCS8` Worker secret.

The Root Meatphrase never goes to Cloudflare.

## Domain verification

Domain issuance keeps the Authority itself stateless:

1. MeatGrinder creates a publisher key locally and a signed `.wurstreq` proof-of-possession.
2. `POST /v1/domain/challenge` returns an issuer-signed, ten-minute DNS TXT challenge bound to the request digest and publisher fingerprint.
3. The publisher places the exact TXT value at `_wurst-authority.<publisher-domain>`.
4. `POST /v1/domain/certificate` checks the signed challenge, publisher proof-of-possession and DNS TXT record.
5. The Worker returns a `wurst/publisher-certificate-3` that contains the verified `domain` claim.


Example CLI flow:

```bash
meatgrinder publisher create --domain example.com --label "Example"
meatgrinder publisher request example.com.wurstkey
meatgrinder authority challenge example.com.wurstreq
# publish the TXT record printed by the challenge
meatgrinder authority complete example.com.wurstreq --challenge example.com.wurstchallenge
```

## Email verification

An email-capable publisher request can be verified without changing or uploading the publisher private key:

1. MeatGrinder sends the signed `.wurstreq` to `POST /v1/email/challenge`.
2. WRST.IO generates a random six-digit code and sends it from `oink@wrst.io` to the requested address.
3. The code is sealed inside the issuer-signed challenge; it is not returned to the requesting page or CLI in plaintext.
4. The user enters the code into MeatGrinder, the CLI or the WRST.IO verification page.
5. `POST /v1/email/certificate` checks the challenge and code and issues or extends the publisher certificate with an `email` claim.

CLI example:

```bash
meatgrinder publisher create --email pig@example.com --label "Example"
meatgrinder publisher request pig@example.com.wurstkey
meatgrinder authority email-challenge pig@example.com.wurstreq
meatgrinder authority email-complete pig@example.com.wurstreq \
  --challenge pig@example.com.wurstmailchallenge
```

If a certificate already contains a domain claim, pass it with `--certificate` while completing the email flow to merge both verified claims into the next certificate.

Email transport is deliberately separated from certificate issuance. The Cloudflare Worker generates and seals the verification code, applies rate/budget limits and signs the eventual certificate, but it does **not** use Cloudflare Email Sending. Instead it sends one HMAC-authenticated `wrst/mail-relay-request-1` delivery job over HTTPS to the small PHP relay in `authority/wrst.io/mail-relay/`.

The PHP host receives no Authority signing key. It accepts only fresh signed verification jobs, rejects replayed nonces, renders the WRST.IO verification mail itself and can deliver through either PHP `mail()` or an explicitly configured SMTP submission server. IMAP and POP are receive protocols and are not part of the send path.

The Worker still applies deliberately conservative abuse controls: per-address and per-client burst limits, per-day address/client limits, an exact global daily send budget, and a hard limit on code guesses for each challenge. Operational counters contain hashes rather than plaintext target addresses.

## Browser verification page

`wrst.io/verify/` accepts a `.wurstreq` and can run the same domain/email claim flows from a static GitHub Pages frontend. The request contains only public publisher material plus proof-of-possession. Publisher private keys and Meatphrases are never uploaded to the page or Authority.

The resulting `.wurstcert` can be downloaded and supplied to MeatGrinder. Desktop MeatGrinder can also obtain and store the same certificate directly in its local signer locker.

## Revocation and freshness

Immediate revocation knowledge and indefinite offline operation cannot both be guaranteed. Wurster therefore separates certificate validity from the freshness of local revocation data.

`wurst/trust-bundle-1` is Root-signed and contains active issuer certificates plus revoked issuer and publisher fingerprints. Runtimes can verify it offline. A newer Wurster release or explicitly updated public trust data can carry a newer bundle without making ordinary Wurst launches contact the Authority.

Operator commands that change trust data require the Root Meatphrase:

```bash
npm run authority:rotate-issuer
npm run authority:revoke -- --publisher <64-hex-fingerprint>
npm run authority:revoke -- --issuer <64-hex-fingerprint>
```

Issuer rotation preserves the same Root and adds a new Root-certified online issuer. Revocation increments and re-signs the trust bundle.

## Static discovery and active issuance

The Eleventy/GitHub Pages site publishes `https://wrst.io/.well-known/wurst-authority` as a static discovery document pointing at the public Root and Root-signed Trust Bundle while declaring supported claim methods and the active issuance endpoint. `npm run authority:sync` generates it automatically from `authority/wrst.io/public/`, and Eleventy passes the whole `.well-known` directory through unchanged.

`authority.wrst.io` is intentionally narrower: it performs the active cryptographic challenge/certificate operations and exposes only lightweight service status at `/`. Public trust-chain publication does not depend on Worker availability.

Normal Wurst verification does not require either endpoint to be reachable because the certificate chain and pinned Root are verified locally.

## Wurster Lab operator realm

The normal development workspace is disposable and release exports never include `authority/wrst.io/private/`. `WursterLab.wurst` carries operator state in its personal sealed `/operator` realm.

It stores exactly the public production Root, Issuer certificate, Trust Bundle and the already-encrypted `issuer.wurstissuer` backup. Root and Issuer Meatphrases are deliberately not stored in the Wurst.

The Lab validates the Root fingerprint, Root→Issuer signature, Trust Bundle signature and issuer-backup fingerprint before it marks the operator kit ready. It can then materialize a local production workspace without exposing that private realm to another maintainer who updates `/workspace`.
