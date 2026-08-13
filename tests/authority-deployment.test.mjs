import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { __test as workerTest } from '../authority/wrst.io/worker/src/index.js';

const root = path.resolve(import.meta.dirname, '..');
const workerConfigPath = path.join(root, 'authority', 'wrst.io', 'worker', 'wrangler.jsonc');
const removedEmailConfig = path.join(root, 'authority', 'wrst.io', 'worker', 'wrangler.email.jsonc');
const relayPath = path.join(root, 'authority', 'wrst.io', 'mail-relay', 'wrst-mail-relay.php');
const relayConfigPath = path.join(root, 'authority', 'wrst.io', 'mail-relay', 'config.example.php');
const discoveryPath = path.join(root, 'site', 'src', '.well-known', 'wurst-authority');
const eleventy = await fs.readFile(path.join(root, 'site', '.eleventy.js'), 'utf8');
const workerSource = await fs.readFile(path.join(root, 'authority', 'wrst.io', 'worker', 'src', 'index.js'), 'utf8');
const workerConfig = JSON.parse(await fs.readFile(workerConfigPath, 'utf8'));
const discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8'));
const relayConfig = await fs.readFile(relayConfigPath, 'utf8');

assert.equal(await fs.stat(removedEmailConfig).then(() => true, () => false), false, 'There must be one current Worker config, not an email variant');
assert.equal(Object.hasOwn(workerConfig, 'send_email'), false, 'Cloudflare Email Sending binding must not be part of the Authority');
assert.equal(Object.hasOwn(workerConfig, 'migrations'), false, 'Pre-1.0 Worker config must not carry legacy DO migrations');
assert.equal(workerConfig.exports.EmailBudget.type, 'durable-object');
assert.equal(workerConfig.exports.EmailBudget.storage, 'sqlite');
assert.deepEqual(workerConfig.secrets.required.sort(), ['WRST_ISSUER_PRIVATE_PKCS8', 'WRST_MAIL_RELAY_SECRET', 'WRST_MAIL_RELAY_URL'].sort());
assert.match(workerSource, /sendVerificationMailViaRelay/);
assert.doesNotMatch(workerSource, /env\.EMAIL\.send|send_email/);
assert.equal(workerSource.includes("url.pathname === '/.well-known/wurst-authority'"), false);

assert.equal(discovery.format, 'wurst/authority-discovery-1');
assert.equal(discovery.authority, 'wrst.io');
assert.equal(discovery.issuance.baseUrl, 'https://authority.wrst.io');
assert.equal(discovery.claims.domain.supported, true);
assert.equal(discovery.claims.email.supported, true);
assert.equal(discovery.trust.root, '/.well-known/wurst-authority-root.json');
assert.equal(discovery.trust.bundle, '/.well-known/wurst-trust-bundle.json');
assert.match(eleventy, /src\/\.well-known/);

assert.match(relayConfig, /'transport' => 'mail'/);
assert.match(relayConfig, /'smtp'/);
const lint = spawnSync('php', ['-l', relayPath], { encoding: 'utf8' });
assert.equal(lint.status, 0, lint.stderr || lint.stdout);
const selfTest = spawnSync('php', [relayPath, '--self-test'], { encoding: 'utf8' });
assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);
assert.match(selfTest.stdout, /self-test/);
const relayVectorSecret = 'cross-language-relay-secret-0123456789abcdef';
const relayVectorValue = '1786615200\nnonce_abcdefghijklmnopqrstuvwxyz\n{"format":"wrst/mail-relay-request-1"}';
const workerHmac = await workerTest.relayHmacHex(relayVectorSecret, relayVectorValue);
const phpHmac = spawnSync('php', ['-r', `echo hash_hmac('sha256', ${JSON.stringify(relayVectorValue)}, ${JSON.stringify(relayVectorSecret)});`], { encoding: 'utf8' });
assert.equal(phpHmac.status, 0, phpHmac.stderr);
assert.equal(phpHmac.stdout, workerHmac, 'Worker and PHP relay must sign the exact same request bytes');

// Exercise the self-contained SMTP transport against a local fake submission
// server. This catches command sequencing/auth/DATA regressions without sending
// any real mail or depending on a vendor SDK.
let smtpTranscript = '';
let smtpData = '';
const smtpServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 local.test ESMTP\r\n');
  let buffer = '';
  let inData = false;
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      if (inData) {
        const marker = buffer.indexOf('\r\n.\r\n');
        if (marker < 0) break;
        smtpData += buffer.slice(0, marker);
        buffer = buffer.slice(marker + 5);
        inData = false;
        socket.write('250 2.0.0 queued\r\n');
        continue;
      }
      const end = buffer.indexOf('\r\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      smtpTranscript += `${line}\n`;
      if (line.startsWith('EHLO ')) socket.write('250-local.test\r\n250 AUTH LOGIN PLAIN\r\n');
      else if (line === 'AUTH LOGIN') socket.write('334 VXNlcm5hbWU6\r\n');
      else if (line === Buffer.from('relay-user').toString('base64')) socket.write('334 UGFzc3dvcmQ6\r\n');
      else if (line === Buffer.from('relay-pass').toString('base64')) socket.write('235 2.7.0 authenticated\r\n');
      else if (line.startsWith('MAIL FROM:')) socket.write('250 2.1.0 sender ok\r\n');
      else if (line.startsWith('RCPT TO:')) socket.write('250 2.1.5 recipient ok\r\n');
      else if (line === 'DATA') { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('500 unexpected command\r\n');
    }
  });
});
await new Promise((resolve, reject) => { smtpServer.once('error', reject); smtpServer.listen(0, '127.0.0.1', resolve); });
const smtpPort = smtpServer.address().port;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrst-relay-test-'));
const smtpPhp = path.join(tempDir, 'smtp-test.php');
await fs.writeFile(smtpPhp, `<?php\ndefine('WRST_MAIL_RELAY_LIBRARY_ONLY', true);\nrequire ${JSON.stringify(relayPath)};\n$message = wrst_build_message(['to'=>'erna@example.test','code'=>'381492','publisherFingerprint'=>str_repeat('a',64),'expiresAt'=>'2026-08-13T12:00:00.000Z'], ['from_email'=>'oink@wrst.io','from_name'=>'WRST.IO Wurst Authority']);\nwrst_send_smtp($message, ['host'=>'127.0.0.1','port'=>${smtpPort},'security'=>'none','auth'=>'login','username'=>'relay-user','password'=>'relay-pass','helo'=>'wrst.io','timeout_seconds'=>5,'verify_peer'=>false]);\n`);
const smtpChild = spawn('php', [smtpPhp], { stdio: ['ignore', 'pipe', 'pipe'] });
let smtpErr = '';
smtpChild.stderr.on('data', (chunk) => { smtpErr += chunk; });
const smtpExit = await new Promise((resolve) => smtpChild.on('close', resolve));
smtpServer.close();
await fs.rm(tempDir, { recursive: true, force: true });
assert.equal(smtpExit, 0, smtpErr);
assert.match(smtpTranscript, /AUTH LOGIN/);
assert.match(smtpTranscript, /MAIL FROM:<oink@wrst\.io>/);
assert.match(smtpTranscript, /RCPT TO:<erna@example\.test>/);
assert.match(smtpData, /MIME-Version: 1\.0/);
assert.match(smtpData, /Content-Type: multipart\/alternative/);

console.log('✓ Authority deployment is split into static GitHub Pages discovery, cryptographic Cloudflare issuance and a configurable HMAC-authenticated PHP mail relay');
