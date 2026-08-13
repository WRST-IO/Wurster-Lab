# WRST.IO Cloudflare Issuing Authority

A deliberately small cryptographic issuer for `authority.wrst.io`. WRST.IO is the official Wurster project domain, not a company or incorporated identity provider.

The trust anchor is the offline WRST.IO Root public key bundled with Wurster. This Worker holds only the separate rotatable Issuer private key. Public discovery and trust-chain JSON are published statically by the Eleventy/GitHub Pages site at `https://wrst.io/.well-known/wurst-authority`.

## What the Worker does

- `GET /` returns only lightweight service status and points to the static discovery document.
- `POST /v1/domain/challenge` verifies publisher proof-of-possession and returns an issuer-signed DNS challenge.
- `POST /v1/domain/certificate` checks the DNS TXT proof and issues or extends a `wurst/publisher-certificate-3`.
- `POST /v1/email/challenge` generates/seals a six-digit code and sends a narrowly scoped HMAC-authenticated delivery job to the PHP mail relay.
- `POST /v1/email/certificate` verifies the code and issues or extends the certificate with the verified email claim.

The Worker no longer publishes `/.well-known` trust material and does not use Cloudflare Email Sending.

## Worker secrets

```text
WRST_ISSUER_PRIVATE_PKCS8
WRST_MAIL_RELAY_URL
WRST_MAIL_RELAY_SECRET
```

`WRST_MAIL_RELAY_URL` must be an HTTPS URL for the deployed `wrst-mail-relay.php`. `WRST_MAIL_RELAY_SECRET` must match `authority/wrst.io/mail-relay/config.php` on that host. The Root private key is never deployed anywhere online.

Set the relay secrets interactively:

```bash
cd authority/wrst.io/worker
npx wrangler secret put WRST_MAIL_RELAY_URL
npx wrangler secret put WRST_MAIL_RELAY_SECRET
```

The issuer secret is normally populated through the operator workflow:

```bash
npm run authority:worker-secret | (cd authority/wrst.io/worker && npx wrangler secret put WRST_ISSUER_PRIVATE_PKCS8)
```

## Abuse controls

Email verification keeps operational counters in a SQLite-backed `EmailBudget` Durable Object and uses Cloudflare rate-limit bindings for bursts. Default limits are:

```text
50 verification emails / UTC day globally
3 / destination address / UTC day
10 / client IP / UTC day
1 new mail / address / minute
5 new mails / client IP / minute
8 code guesses / challenge
```

Only hashes of destination/IP identifiers enter the budget object. The PHP relay does not receive the issuer key and cannot issue certificates.

## Deploy

```bash
npm install
npm run authority:production-check
npm run authority:worker:deploy
```

There is one current Wrangler configuration only: `wrangler.jsonc`.
