<?php
declare(strict_types=1);

const WRST_RELAY_FORMAT = 'wrst/mail-relay-request-1';
const WRST_RELAY_MAX_BODY = 32768;
const WRST_RELAY_MAX_SKEW = 300;

function wrst_json_response(int $status, array $body): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
    exit;
}

function wrst_fail(string $message, int $status = 400, string $code = 'bad-request'): never {
    wrst_json_response($status, ['ok' => false, 'error' => $code, 'message' => $message]);
}

function wrst_header(string $name): string {
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    return trim((string)($_SERVER[$key] ?? ''));
}

function wrst_header_value(string $value): string {
    return trim(str_replace(["\r", "\n"], '', $value));
}

function wrst_encode_header(string $value): string {
    return '=?UTF-8?B?' . base64_encode($value) . '?=';
}

function wrst_html_escape(string $value): string {
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
}

function wrst_build_message(array $payload, array $config): array {
    $to = (string)$payload['to'];
    $code = (string)$payload['code'];
    $fingerprint = strtolower((string)$payload['publisherFingerprint']);
    $expiresAt = (string)$payload['expiresAt'];
    $fromEmail = (string)$config['from_email'];
    $fromName = (string)$config['from_name'];
    $short = substr($fingerprint, 0, 12) . '…' . substr($fingerprint, -8);
    $subject = 'Your WRST.IO verification code';
    $text = "WRST.IO verification\n\nYour verification code is {$code}.\n\nEmail: {$to}\nPublisher key: {$short}\nExpires: {$expiresAt}\n\nOnly enter this code into MeatGrinder or on wrst.io. If you did not request this, ignore this email.\n\nOink responsibly.\nWRST.IO · {$fromEmail}";
    $html = '<!doctype html><html><body style="margin:0;background:#fff4f5;color:#2d2431;font-family:Inter,Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:34px 20px"><div style="background:#fffafa;border:1px solid #eedfe2;border-radius:24px;padding:30px;text-align:center"><div style="font-size:38px">🐷</div><h1 style="margin:8px 0 4px;font-size:24px">WRST.IO verification</h1><p style="margin:0 0 24px;color:#83727a">Someone is asking WRST.IO to verify this email for a Wurst publisher key.</p><div style="font:800 34px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:8px;background:#fde6ea;border-radius:16px;padding:18px 12px;color:#c43f5c">' . wrst_html_escape($code) . '</div><p style="margin:22px 0 0;font-size:13px"><strong>' . wrst_html_escape($to) . '</strong><br><span style="color:#83727a">Publisher ' . wrst_html_escape($short) . '</span></p><p style="margin:18px 0 0;font-size:12px;color:#83727a">Expires ' . wrst_html_escape($expiresAt) . '. Enter the code only in MeatGrinder or on wrst.io. If you did not request this, ignore the message.</p></div><p style="text-align:center;color:#9a8990;font-size:11px;margin:16px 0 0">A good Wurst does not verify itself. · ' . wrst_html_escape($fromEmail) . '</p></div></body></html>';
    return compact('to', 'subject', 'text', 'html', 'fromEmail', 'fromName');
}

function wrst_mime_message(array $message): array {
    $boundary = 'wrst_' . bin2hex(random_bytes(12));
    $headers = [
        'From: ' . wrst_encode_header($message['fromName']) . ' <' . $message['fromEmail'] . '>',
        'Reply-To: ' . $message['fromEmail'],
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
        'Date: ' . gmdate('D, d M Y H:i:s') . ' +0000',
        'Message-ID: <' . bin2hex(random_bytes(12)) . '@wrst.io>',
    ];
    $body = "--{$boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($message['text']))
        . "\r\n--{$boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($message['html']))
        . "\r\n--{$boundary}--\r\n";
    return ['headers' => $headers, 'body' => $body];
}

function wrst_smtp_read($stream): array {
    $lines = [];
    while (($line = fgets($stream, 4096)) !== false) {
        $lines[] = rtrim($line, "\r\n");
        if (strlen($line) >= 4 && $line[3] !== '-') break;
    }
    if (!$lines) throw new RuntimeException('SMTP server closed the connection');
    $code = (int)substr($lines[count($lines) - 1], 0, 3);
    return [$code, implode("\n", $lines)];
}

function wrst_smtp_expect($stream, array $expected, ?string $command = null): string {
    if ($command !== null) {
        if (fwrite($stream, $command . "\r\n") === false) throw new RuntimeException('SMTP write failed');
    }
    [$code, $reply] = wrst_smtp_read($stream);
    if (!in_array($code, $expected, true)) throw new RuntimeException("SMTP rejected request ({$code}): {$reply}");
    return $reply;
}

function wrst_send_smtp(array $message, array $smtp): void {
    $host = trim((string)($smtp['host'] ?? ''));
    $port = (int)($smtp['port'] ?? 0);
    $security = strtolower((string)($smtp['security'] ?? 'starttls'));
    $auth = strtolower((string)($smtp['auth'] ?? 'login'));
    $timeout = max(1, min(60, (int)($smtp['timeout_seconds'] ?? 15)));
    if ($host === '' || $port < 1 || $port > 65535) throw new RuntimeException('SMTP host/port are not configured');
    if (!in_array($security, ['starttls', 'smtps', 'none'], true)) throw new RuntimeException('SMTP security must be starttls, smtps, or none');
    if (!in_array($auth, ['login', 'plain', 'none'], true)) throw new RuntimeException('SMTP auth must be login, plain, or none');
    $verify = (bool)($smtp['verify_peer'] ?? true);
    $context = stream_context_create(['ssl' => [
        'verify_peer' => $verify,
        'verify_peer_name' => $verify,
        'allow_self_signed' => !$verify,
        'peer_name' => $host,
    ]]);
    $target = ($security === 'smtps' ? 'ssl://' : 'tcp://') . $host . ':' . $port;
    $errno = 0; $errstr = '';
    $stream = @stream_socket_client($target, $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT, $context);
    if (!$stream) throw new RuntimeException("SMTP connection failed: {$errstr} ({$errno})");
    stream_set_timeout($stream, $timeout);
    try {
        wrst_smtp_expect($stream, [220]);
        $helo = preg_replace('/[^A-Za-z0-9.-]/', '', (string)($smtp['helo'] ?? 'wrst.io')) ?: 'wrst.io';
        wrst_smtp_expect($stream, [250], 'EHLO ' . $helo);
        if ($security === 'starttls') {
            wrst_smtp_expect($stream, [220], 'STARTTLS');
            if (!stream_socket_enable_crypto($stream, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) throw new RuntimeException('SMTP STARTTLS negotiation failed');
            wrst_smtp_expect($stream, [250], 'EHLO ' . $helo);
        }
        $username = (string)($smtp['username'] ?? '');
        $password = (string)($smtp['password'] ?? '');
        if ($auth === 'login') {
            wrst_smtp_expect($stream, [334], 'AUTH LOGIN');
            wrst_smtp_expect($stream, [334], base64_encode($username));
            wrst_smtp_expect($stream, [235], base64_encode($password));
        } elseif ($auth === 'plain') {
            wrst_smtp_expect($stream, [235], 'AUTH PLAIN ' . base64_encode("\0{$username}\0{$password}"));
        }
        wrst_smtp_expect($stream, [250], 'MAIL FROM:<' . $message['fromEmail'] . '>');
        wrst_smtp_expect($stream, [250, 251], 'RCPT TO:<' . $message['to'] . '>');
        wrst_smtp_expect($stream, [354], 'DATA');
        $mime = wrst_mime_message($message);
        $headers = array_merge([
            'To: <' . $message['to'] . '>',
            'Subject: ' . wrst_encode_header($message['subject']),
        ], $mime['headers']);
        $data = implode("\r\n", $headers) . "\r\n\r\n" . $mime['body'];
        $data = preg_replace('/(^|\r\n)\./', '$1..', $data);
        if (fwrite($stream, $data . "\r\n.\r\n") === false) throw new RuntimeException('SMTP DATA write failed');
        wrst_smtp_expect($stream, [250]);
        @fwrite($stream, "QUIT\r\n");
    } finally {
        fclose($stream);
    }
}

function wrst_send_php_mail(array $message, array $mailConfig): void {
    $mime = wrst_mime_message($message);
    $headers = implode("\r\n", $mime['headers']);
    $extra = '';
    $envelope = trim((string)($mailConfig['envelope_from'] ?? ''));
    if ($envelope !== '') $extra = '-f' . escapeshellarg($envelope);
    $ok = $extra === ''
        ? mail($message['to'], wrst_encode_header($message['subject']), $mime['body'], $headers)
        : mail($message['to'], wrst_encode_header($message['subject']), $mime['body'], $headers, $extra);
    if (!$ok) throw new RuntimeException('PHP mail() returned false');
}

function wrst_claim_nonce(string $dir, string $timestamp, string $nonce): void {
    if ($dir === '') throw new RuntimeException('Replay cache directory is not configured');
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Could not create replay cache directory');
    $key = hash('sha256', $timestamp . "\n" . $nonce);
    $file = rtrim($dir, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $key . '.nonce';
    $handle = @fopen($file, 'x');
    if ($handle === false) wrst_fail('Relay request was already used', 409, 'relay-replay');
    fwrite($handle, (string)(time() + WRST_RELAY_MAX_SKEW));
    fclose($handle);
    @chmod($file, 0600);
    if (random_int(1, 50) === 1) {
        foreach (glob(rtrim($dir, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . '*.nonce') ?: [] as $candidate) {
            if (@filemtime($candidate) !== false && filemtime($candidate) < time() - WRST_RELAY_MAX_SKEW) @unlink($candidate);
        }
    }
}

function wrst_validate_config(array $config): void {
    $secret = (string)($config['shared_secret'] ?? '');
    if (strlen($secret) < 32 || str_contains($secret, 'CHANGE_ME')) throw new RuntimeException('shared_secret must be a random secret of at least 32 characters');
    if (!filter_var((string)($config['from_email'] ?? ''), FILTER_VALIDATE_EMAIL)) throw new RuntimeException('from_email is invalid');
    if (!in_array((string)($config['transport'] ?? ''), ['mail', 'smtp'], true)) throw new RuntimeException('transport must be mail or smtp');
}

if (defined('WRST_MAIL_RELAY_LIBRARY_ONLY') && WRST_MAIL_RELAY_LIBRARY_ONLY) return;

if (PHP_SAPI === 'cli' && in_array('--self-test', $argv ?? [], true)) {
    $fixture = ['to' => 'erna@example.test', 'code' => '381492', 'publisherFingerprint' => str_repeat('a', 64), 'expiresAt' => '2026-08-13T12:00:00.000Z'];
    $message = wrst_build_message($fixture, ['from_email' => 'oink@wrst.io', 'from_name' => 'WRST.IO Wurst Authority']);
    if (!str_contains($message['text'], '381492') || !str_contains($message['html'], '381492')) throw new RuntimeException('mail template self-test failed');
    echo "✓ WRST.IO PHP mail relay self-test\n";
    exit(0);
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') wrst_fail('POST required', 405, 'method-not-allowed');
$configPath = getenv('WRST_MAIL_RELAY_CONFIG') ?: (__DIR__ . '/config.php');
if (!is_file($configPath)) wrst_fail('Mail relay is not configured', 503, 'relay-not-configured');
$config = require $configPath;
if (!is_array($config)) wrst_fail('Mail relay configuration is invalid', 503, 'relay-not-configured');
try { wrst_validate_config($config); } catch (Throwable $e) { wrst_fail($e->getMessage(), 503, 'relay-not-configured'); }

$raw = file_get_contents('php://input');
if (!is_string($raw) || $raw === '' || strlen($raw) > WRST_RELAY_MAX_BODY) wrst_fail('Invalid relay request body', 400, 'invalid-body');
$timestamp = wrst_header('X-WRST-Relay-Timestamp');
$nonce = wrst_header('X-WRST-Relay-Nonce');
$signature = wrst_header('X-WRST-Relay-Signature');
if (!preg_match('/^\d{10,13}$/', $timestamp) || abs(time() - (int)$timestamp) > WRST_RELAY_MAX_SKEW) wrst_fail('Relay request timestamp is outside the allowed window', 401, 'relay-expired');
if (!preg_match('/^[A-Za-z0-9_-]{16,64}$/', $nonce)) wrst_fail('Relay nonce is invalid', 401, 'relay-auth-invalid');
if (!preg_match('/^v1=([a-f0-9]{64})$/i', $signature, $match)) wrst_fail('Relay signature is invalid', 401, 'relay-auth-invalid');
$expected = hash_hmac('sha256', $timestamp . "\n" . $nonce . "\n" . $raw, (string)$config['shared_secret']);
if (!hash_equals(strtolower($expected), strtolower($match[1]))) wrst_fail('Relay signature is invalid', 401, 'relay-auth-invalid');
wrst_claim_nonce((string)($config['replay_cache_dir'] ?? ''), $timestamp, $nonce);

try { $payload = json_decode($raw, true, 16, JSON_THROW_ON_ERROR); } catch (Throwable) { wrst_fail('Relay JSON is invalid', 400, 'invalid-json'); }
if (!is_array($payload) || ($payload['format'] ?? null) !== WRST_RELAY_FORMAT) wrst_fail('Unsupported relay request', 400, 'unsupported-relay-format');
$to = (string)($payload['to'] ?? '');
$code = (string)($payload['code'] ?? '');
$fingerprint = strtolower((string)($payload['publisherFingerprint'] ?? ''));
$expiresAt = (string)($payload['expiresAt'] ?? '');
if (!filter_var($to, FILTER_VALIDATE_EMAIL) || strlen($to) > 320) wrst_fail('Recipient email is invalid', 400, 'invalid-recipient');
if (!preg_match('/^\d{6}$/', $code)) wrst_fail('Verification code is invalid', 400, 'invalid-code');
if (!preg_match('/^[a-f0-9]{64}$/', $fingerprint)) wrst_fail('Publisher fingerprint is invalid', 400, 'invalid-fingerprint');
$expiry = strtotime($expiresAt);
if ($expiry === false || $expiry < time() - 60 || $expiry > time() + 3600) wrst_fail('Verification expiry is invalid', 400, 'invalid-expiry');

$message = wrst_build_message(['to' => $to, 'code' => $code, 'publisherFingerprint' => $fingerprint, 'expiresAt' => $expiresAt], $config);
try {
    if ($config['transport'] === 'smtp') wrst_send_smtp($message, (array)($config['smtp'] ?? []));
    else wrst_send_php_mail($message, (array)($config['mail'] ?? []));
} catch (Throwable $e) {
    error_log('WRST.IO mail relay send failed: ' . $e->getMessage());
    wrst_fail('Mail transport failed', 502, 'mail-send-failed');
}
wrst_json_response(200, ['ok' => true]);
