<?php
// Copy this file to config.php on the mail host and keep it private.
return [
    // Must match the Cloudflare Worker secret WRST_MAIL_RELAY_SECRET.
    // Generate one with: php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
    'shared_secret' => 'CHANGE_ME_TO_A_RANDOM_64_HEX_SECRET',

    'from_email' => 'oink@wrst.io',
    'from_name' => 'WRST.IO Wurst Authority',

    // "mail" uses PHP mail(). "smtp" talks directly to an SMTP submission server.
    // IMAP and POP are receive protocols and are intentionally not transport options.
    'transport' => 'mail',

    // Used only for short-lived replay protection. The directory must be writable by PHP.
    'replay_cache_dir' => __DIR__ . '/.wrst-mail-relay-cache',

    'mail' => [
        // Optional envelope sender for hosts that permit the -f argument. Leave null if unsure.
        'envelope_from' => null,
    ],

    'smtp' => [
        'host' => 'smtp.example.com',
        'port' => 587,
        // "starttls", "smtps" (implicit TLS, commonly port 465), or "none".
        'security' => 'starttls',
        // "login", "plain", or "none".
        'auth' => 'login',
        'username' => 'oink@wrst.io',
        'password' => 'CHANGE_ME',
        'helo' => 'wrst.io',
        'timeout_seconds' => 15,
        'verify_peer' => true,
    ],
];
