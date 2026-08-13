# WRST.IO Authority operator

WRST.IO deliberately separates public trust publication, cryptographic issuance and mail transport:

```text
wrst.io / GitHub Pages
  static /.well-known/wurst-authority + public Root/Issuer/Trust Bundle

        authority.wrst.io / Cloudflare Worker
          proof-of-possession, DNS checks, code verification, certificate signing
          holds only WRST_ISSUER_PRIVATE_PKCS8

                PHP mail host
                  HMAC-authenticated six-digit-code delivery only
                  holds no Authority signing key
```

`wrst.io` is the official Wurster project domain, not a company or incorporated identity provider.

## One-time production ceremony

Run this only on the machine you intend to trust as the Authority operator. Bootstrap refuses non-interactive/CI output by default so a Root phrase cannot casually land in build logs.

```bash
npm install
npm run authority:bootstrap
npm run authority:verify
npm run authority:root-check
npm run authority:production-check
```

The 24-token Root Meatphrase reconstructs the Root private key and stays offline. The separate issuer key is stored encrypted as `authority/wrst.io/private/issuer.wurstissuer`; its Issuer Meatphrase is separate. The private directory is excluded from Git and normal release ZIPs.

Public operator material is synchronized with:

```bash
npm run authority:sync
```

That writes the pinned runtime trust data, Worker public issuer material, and the static Eleventy files including:

```text
site/src/.well-known/wurst-authority
site/src/.well-known/wurst-authority-root.json
site/src/.well-known/wurst-trust-bundle.json
```

Eleventy passes `site/src/.well-known/` through unchanged, so the GitHub Pages deployment automatically publishes the discovery document at `https://wrst.io/.well-known/wurst-authority`.

## Cloudflare issuing Worker

Install/login once:

```bash
npm install --prefix authority/wrst.io/worker
cd authority/wrst.io/worker
npx wrangler login
cd ../../..
```

Set the issuer secret without putting it in source:

```bash
npm run authority:worker-secret | (cd authority/wrst.io/worker && npx wrangler secret put WRST_ISSUER_PRIVATE_PKCS8)
```

The Worker performs real cryptographic work: it validates signed publisher requests, signs short-lived challenges, resolves DNS proofs, verifies email codes and signs publisher certificates. It is not merely a JSON host.

## PHP mail relay

Files ready for a normal PHP web host live in:

```text
authority/wrst.io/mail-relay/wrst-mail-relay.php
authority/wrst.io/mail-relay/config.example.php
```

Upload the endpoint and copy `config.example.php` to `config.php`. Generate a shared relay secret:

```bash
php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
```

Put that value in `config.php`. The relay supports either the host's native PHP `mail()` function or direct SMTP with STARTTLS/implicit TLS and LOGIN/PLAIN auth. IMAP/POP are intentionally absent because they are receive protocols.

Then set the same secret and endpoint URL on the Worker:

```bash
cd authority/wrst.io/worker
npx wrangler secret put WRST_MAIL_RELAY_URL
npx wrangler secret put WRST_MAIL_RELAY_SECRET
cd ../../..
```

The relay accepts only fresh HMAC-authenticated WRST verification jobs, has short-lived replay protection, builds the message itself and never receives `WRST_ISSUER_PRIVATE_PKCS8`.

## Deploy

After the PHP endpoint is configured:

```bash
npm run authority:production-check
npm run authority:worker:deploy
```

There is one Worker configuration. Email verification becomes available because the relay URL/secret are present, not because a separate Cloudflare Email product is enabled.

## GitHub Pages

`site/src/CNAME` is `wrst.io`. The Pages workflow syncs Authority public data, builds the Web runtime and Eleventy site, and publishes the result. `authority.wrst.io` remains the Worker custom domain; the static public discovery lives on `wrst.io`.

## Recovery / rotation

```bash
npm run authority:verify
npm run authority:rotate-issuer
npm run authority:revoke -- --publisher <fingerprint>
npm run authority:revoke -- --issuer <fingerprint>
```

Rotation/revocation require the offline Root Meatphrase because they produce Root-signed trust material.
