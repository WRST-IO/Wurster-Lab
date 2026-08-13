# WRST.IO PHP mail relay

This tiny endpoint only delivers WRST.IO six-digit verification messages. It is **not** an Authority and never receives the WRST.IO issuer private key.

## Install

1. Upload `wrst-mail-relay.php` and a copy of `config.example.php` named `config.php` to the PHP host.
2. Generate a shared secret:

   ```bash
   php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
   ```

3. Put that value in `config.php` as `shared_secret`.
4. Choose `transport => 'mail'` for the host's PHP `mail()` function, or `transport => 'smtp'` and fill the SMTP block. SMTP supports STARTTLS, implicit TLS (`smtps`), LOGIN/PLAIN authentication, or no auth. IMAP/POP are receive protocols and are not used for sending.
5. Ensure `replay_cache_dir` is writable by PHP. Keep `config.php` and the replay cache out of public source repositories.
6. Copy the endpoint URL and the same shared secret into Cloudflare Worker secrets:

   ```bash
   cd authority/wrst.io/worker
   npx wrangler secret put WRST_MAIL_RELAY_URL
   npx wrangler secret put WRST_MAIL_RELAY_SECRET
   ```

7. Deploy the Authority Worker with the normal `npm run authority:worker:deploy` command from the workspace root.

The relay accepts only HMAC-authenticated `wrst/mail-relay-request-1` payloads, requires a fresh timestamp and single-use nonce, validates the six-digit code/fingerprint/expiry shape, and renders the verification mail itself.

## Local syntax/template check

```bash
php -l authority/wrst.io/mail-relay/wrst-mail-relay.php
php authority/wrst.io/mail-relay/wrst-mail-relay.php --self-test
```
