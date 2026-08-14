#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildWurst,
  createPublisher,
  createPublisherRequest,
  generateMeatphrase,
  generateWurstKey,
  inspectCertificate,
  inspectPublisher,
  inspectWurst,
  requestRemoteAuthorityChallenge,
  completeRemoteAuthorityChallenge,
  requestRemoteAuthorityEmailChallenge,
  completeRemoteAuthorityEmailChallenge,
  verifyWurst
} from './index.js';

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positionals, flags };
}

async function readPhraseFile(value) {
  if (!value) return null;
  return (await fs.readFile(path.resolve(String(value)), 'utf8')).trim();
}


async function promptHidden(label = 'Meatphrase: ') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = Boolean(input.isRaw);
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      try { input.setRawMode(wasRaw); } catch {}
      input.pause();
    };
    const finish = () => { cleanup(); process.stdout.write('\n'); resolve(value.trim()); };
    const fail = (error) => { cleanup(); process.stdout.write('\n'); reject(error); };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0003') return fail(new Error('Canceled'));
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        if (ch >= ' ') value += ch;
      }
    };
    process.stdout.write(label);
    input.setEncoding('utf8');
    try { input.setRawMode(true); } catch {}
    input.resume();
    input.on('data', onData);
  });
}

async function resolveKeyMeatphrase(flags, { prompt = false } = {}) {
  if (typeof flags['key-meatphrase'] === 'string') return flags['key-meatphrase'].trim();
  const fromFile = await readPhraseFile(flags['key-meatphrase-file']);
  if (fromFile) return fromFile;
  if (process.env.WURST_KEY_MEATPHRASE) return process.env.WURST_KEY_MEATPHRASE.trim();
  if (prompt) return promptHidden('🔏 Publisher Meatphrase: ');
  return null;
}

async function resolveEmailCode(flags, { prompt = false } = {}) {
  if (typeof flags.code === 'string') return flags.code.trim();
  if (prompt) return promptHidden('📮 6-digit WRST.IO email code: ');
  return null;
}

async function readTrustedRoot(value) {
  if (!value) return [];
  const parsed = JSON.parse(await fs.readFile(path.resolve(String(value)), 'utf8'));
  return Array.isArray(parsed) ? parsed : [parsed];
}

function help() {
  console.log(`
🥩 Meat Grinder 0.32.0

Usage:
  meatgrinder build [projectDir] [output] [options]
  meatgrinder inspect <file.wurst|file.wrst>
  meatgrinder verify <file.wurst|file.wrst>
  meatgrinder meatphrase [tokenCount]
  meatgrinder wurstkey

  meatgrinder publisher create [--email <mail>] [--domain <example.com>] [--label <name>] [--out publisher.wurstkey] [--meatphrase <phrase>] [--meatphrase-file <file>]
  meatgrinder publisher request <seller.wurstkey> [--key-meatphrase <phrase> | --key-meatphrase-file <file>] [--out seller.wurstreq]
  meatgrinder publisher inspect <seller.wurstkey>

  meatgrinder authority challenge <seller.wurstreq> [--url https://authority.wrst.io] [--out seller.wurstchallenge]
  meatgrinder authority complete <seller.wurstreq> --challenge <seller.wurstchallenge> [--certificate seller.wurstcert] [--url https://authority.wrst.io] [--out seller.wurstcert]
  meatgrinder authority email-challenge <seller.wurstreq> [--url https://authority.wrst.io] [--out seller.wurstmailchallenge]
  meatgrinder authority email-complete <seller.wurstreq> --challenge <seller.wurstmailchallenge> [--code 123456] [--certificate seller.wurstcert] [--url https://authority.wrst.io] [--out seller.wurstcert]

  meatgrinder certificate inspect <seller.wurstcert> [--root root.json]

Build options:
  --sign <publisher.wurstkey>          Sign the sealed application payload with Ed25519.
  --certificate <publisher.wurstcert> Attach an Authority-issued seller certificate.
  --carrier <image.png>               Press the Wurst into a valid PNG carrier.
  --wurstkey-file <file>              Read an application WurstKey from a file.
  --key-meatphrase <phrase>           Supply a private-key Meatphrase directly (can enter shell history).\n  --key-meatphrase-file <file>        Read a publisher/authority private-key Meatphrase.\n  If signing interactively and neither is supplied, MeatGrinder asks with hidden terminal input.

Project input:
  wurst.json is optional. Without it, Meat Grinder uses the folder name, prefers index.html,
  creates a normal public framed app, and ignores common build junk such as node_modules/dist.

Environment alternatives:
  WURST_APP_KEY          Application WurstKey used for developer-sealed content.
  WURST_KEY_MEATPHRASE   Publisher private-key Meatphrase.

If a build contains sealed application resources and no WurstKey is supplied, Meat Grinder
generates a fresh 256-bit WurstKey and prints it once. Mutable WurstFS data is runtime-owned;
personal realms are claimed and unlocked by a Wurster Identity at runtime.

A pig goes in. A Wurst comes out.
`);
}

function certificateLabel(signature) {
  if (!signature?.certificate) return 'none';
  const status = signature.certificate.status ?? 'unknown';
  const issuer = signature.certificate.issuer?.name;
  return issuer ? `${status} (${issuer})` : status;
}

function filesystemLabel(manifest) {
  if (manifest?.data?.format !== 'wurst/data-realms-1') return 'none';
  const realms = Array.isArray(manifest.data.realms) ? manifest.data.realms : [];
  const governance = [...new Set(realms.map((realm) => String(realm?.governance ?? 'ordinary').toLowerCase()))].join('+') || 'empty';
  return `realms / ${governance} / ${realms.length} genesis template${realms.length === 1 ? '' : 's'}`;
}

function filesystemGenerationLabel(root) {
  if (!root) return null;
  return `   WurstFS generation: ${root.generation} / ${root.realmCount ?? Object.keys(root.realms ?? {}).length} realm(s) / ${root.historyMode === 'integrity' ? 'signed lineage' : 'current snapshot'}`;
}

const { positionals, flags } = parseArgs(process.argv.slice(2));
const [command, subcommand, third] = positionals;

try {
  if (command === 'build') {
    const project = subcommand ?? '.';
    const output = third;
    console.log('🐖 Scanning pig...');
    const result = await buildWurst(project, output, {
      signKey: flags.sign,
      certificatePath: flags.certificate,
      wurstKey: await readPhraseFile(flags['wurstkey-file']),
      publisherMeatphrase: flags.sign ? await resolveKeyMeatphrase(flags, { prompt: true }) : null,
      carrier: flags.carrier
    });
    console.log(`⚙️  Ground ${result.fileCount} package resources`);
    console.log(`🌭 Wurst ready: ${result.output}`);
    console.log(`   ${(result.bytes / 1024).toFixed(1)} KiB`);
    if (result.carrier) console.log(`🥷 undercover carrier: PNG (${(result.wurstBytes / 1024).toFixed(1)} KiB embedded Wurst)`);
    console.log(`   risk: ${result.risk.level.toUpperCase()} (${result.risk.signaturePolicy} signature)`);
    console.log(`   signature: ${result.signature.status}`);
    console.log(`   publisher certificate: ${result.sellerVerification?.status ?? certificateLabel(result.signature)}`);
    console.log(`   application: ${result.manifest.application?.protection ?? 'public'}`);
    console.log(`   WurstFS: ${filesystemLabel(result.manifest)}`);
    if (result.wurstFs) console.log(filesystemGenerationLabel(result.wurstFs));
    console.log(`   stored identities: ${result.manifest.protection?.storedIdentity === false ? 'forbidden' : 'allowed'}`);
    if (result.manifest.piglink) console.log(`   PigLink: ${Object.keys(result.manifest.piglink.actions ?? {}).length} action(s) / ${Object.keys(result.manifest.piglink.events ?? {}).length} event(s)${result.manifest.piglink.headless ? ' / headless' : ''}`);
    if (result.manifest.piglet) console.log(`   Piglet: ${result.manifest.piglet.children?.length ?? 0} child Wurst(s)`);
    if (result.manifest.pigsty) console.log(`   Pigsty: ${result.manifest.pigsty.version}${result.manifest.pigsty.offline ? ' / offline toolchain' : ''}`);
    if (result.generatedWurstKey) {
      console.log('\n🔐 GENERATED WURSTKEY — THIS IS SHOWN ONCE:');
      console.log(`   ${result.generatedWurstKey.wurstKey}`);
      console.log(`   ${result.generatedWurstKey.entropyBits} bits / ${result.generatedWurstKey.encoding}`);
    }
  } else if (command === 'inspect') {
    if (!subcommand) throw new Error('inspect requires a .wurst or .wrst path');
    const result = await inspectWurst(subcommand);
    console.log(`🌭 ${result.manifest.name} ${result.manifest.version}`);
    console.log(`   ${result.manifest.id}`);
    console.log(`   type: ${result.manifest.type}`);
    console.log(`   entry: ${result.manifest.entry}`);
    console.log(`   risk: ${result.risk.level.toUpperCase()}`);
    console.log(`   signature: ${result.signature.status}${result.signature.publisher ? ` (${result.signature.publisher.domain ?? result.signature.publisher.email ?? result.signature.publisher.label ?? result.signature.publisher.fingerprint.slice(0, 16)})` : ''}`);
    console.log(`   publisher certificate: ${certificateLabel(result.signature)}`);
    console.log(`   application: ${result.manifest.application?.protection ?? 'public'}`);
    console.log(`   WurstFS: ${filesystemLabel(result.manifest)}`);
    if (result.wurstFs) console.log(filesystemGenerationLabel(result.wurstFs));
    console.log(`   stored identities: ${result.manifest.protection?.storedIdentity === false ? 'forbidden' : 'allowed'}`);
    if (result.manifest.piglink) console.log(`   PigLink: ${Object.keys(result.manifest.piglink.actions ?? {}).length} action(s) / ${Object.keys(result.manifest.piglink.events ?? {}).length} event(s)${result.manifest.piglink.headless ? ' / headless' : ''}`);
    if (result.manifest.piglet) console.log(`   Piglet: ${result.manifest.piglet.children?.length ?? 0} child Wurst(s)`);
    if (result.manifest.pigsty) console.log(`   Pigsty: ${result.manifest.pigsty.version}${result.manifest.pigsty.offline ? ' / offline toolchain' : ''}`);
    console.log(`   files: ${result.files.length}`);
    console.log(`   size: ${(result.bytes / 1024).toFixed(1)} KiB`);
    if (result.carrier) console.log(`   carrier: PNG / ${result.carrier.chunks} wuSt slice${result.carrier.chunks === 1 ? '' : 's'} / ${(result.wurstBytes / 1024).toFixed(1)} KiB embedded Wurst`);
    for (const file of result.files) console.log(`   ✓ [${file.scope}] ${file.path} (${file.plainLength} plain bytes, ${file.chunks} slice${file.chunks === 1 ? '' : 's'}${file.encrypted ? ', sealed' : ''})`);
  } else if (command === 'verify') {
    if (!subcommand) throw new Error('verify requires a .wurst or .wrst path');
    const roots = await readTrustedRoot(flags.root);
    const result = await verifyWurst(subcommand, roots);
    console.log(`🌭 ${result.manifest.name}`);
    console.log('   package integrity: VALID');
    console.log(`   risk: ${result.risk.level.toUpperCase()}`);
    console.log(`   protected resources: ${result.encrypted ? 'YES' : 'NO'}`);
    console.log(`   signature: ${result.signature.status.toUpperCase()}`);
    console.log(`   publisher certificate: ${result.sellerVerification?.status ?? certificateLabel(result.signature)}`);
    if (result.signature.publisher) {
      console.log(`   publisher: ${result.signature.publisher.domain ?? result.signature.publisher.email ?? result.signature.publisher.label ?? result.signature.publisher.fingerprint.slice(0, 16)}`);
      console.log(`   fingerprint: ${result.signature.publisher.fingerprint}`);
    }
    if (result.signature.status === 'invalid') process.exitCode = 2;
  } else if (command === 'meatphrase') {
    const count = Number(subcommand ?? 12);
    const result = generateMeatphrase(count);
    console.log(`🥩 ${result.meatphrase}`);
    console.log(`   ${result.words.length} tokens / ~${result.entropyBits} bits`);
  } else if (command === 'wurstkey') {
    const result = generateWurstKey();
    console.log(`🔑 ${result.wurstKey}`);
    console.log(`   ${result.entropyBits} bits / ${result.encoding}`);
  } else if (command === 'publisher' && subcommand === 'create') {
    const email = flags.email || null;
    const domain = flags.domain || null;
    const label = flags.label || null;
    const meatphrase = typeof flags.meatphrase === 'string' ? flags.meatphrase.trim() : await readPhraseFile(flags['meatphrase-file'] ?? flags['key-meatphrase-file']);
    const result = await createPublisher({ email, domain, label, output: flags.out, meatphrase });
    console.log('🐷 WURST PUBLISHER KEY MATERIAL CREATED LOCALLY');
    if (result.bundle.label) console.log(`   label: ${result.bundle.label}`);
    if (result.bundle.email) console.log(`   email claim: ${result.bundle.email}`);
    if (result.bundle.domain) console.log(`   domain claim: ${result.bundle.domain}`);
    console.log(`   fingerprint: ${result.fingerprint}`);
    console.log(`   key file: ${result.output}`);
    if (result.dns) {
      console.log('\n🌐 OPTIONAL DOMAIN VERIFICATION');
      console.log(`   ${result.dns.name} TXT "${result.dns.value}"`);
    }
    if (!meatphrase) {
      console.log('\n🔑 PUBLISHER MEATPHRASE — THIS IS SHOWN ONCE:');
      console.log(`   ${result.meatphrase}`);
      console.log(`   ~${result.entropyBits} bits`);
    }
    console.log('\nThe private Ed25519 key is encrypted inside the .wurstkey file.');
  } else if (command === 'publisher' && subcommand === 'request') {
    if (!third) throw new Error('publisher request requires a .wurstkey path');
    const publisherMeatphrase = await resolveKeyMeatphrase(flags, { prompt: true });
    const result = await createPublisherRequest({ publisherKey: third, publisherMeatphrase, output: flags.out });
    console.log('📨 WURST PUBLISHER VERIFICATION REQUEST CREATED');
    if (result.subject.domain) console.log(`   domain: ${result.subject.domain}`);
    if (result.subject.email) console.log(`   email: ${result.subject.email}`);
    console.log(`   fingerprint: ${result.subject.fingerprint}`);
    console.log(`   request: ${result.output}`);
    console.log('   proof-of-possession: VALID (request signed by publisher key)');
  } else if (command === 'publisher' && subcommand === 'inspect') {
    if (!third) throw new Error('publisher inspect requires a .wurstkey path');
    const result = await inspectPublisher(third);
    console.log('🐷 Wurst publisher key');
    if (result.label) console.log(`   label: ${result.label}`);
    if (result.email) console.log(`   email claim: ${result.email}`);
    if (result.domain) console.log(`   domain claim: ${result.domain}`);
    console.log(`   algorithm: ${result.algorithm}`);
    console.log(`   fingerprint: ${result.fingerprint}`);
    if (result.dns) console.log(`   DNS: ${result.dns.name} TXT \"${result.dns.value}\"`);
  } else if (command === 'authority' && subcommand === 'challenge') {
    if (!third) throw new Error('authority challenge requires a .wurstreq path');
    const result = await requestRemoteAuthorityChallenge({ requestPath: third, authorityUrl: flags.url ?? 'https://authority.wrst.io', output: flags.out });
    console.log('🏛️ WRST.IO AUTHORITY DNS CHALLENGE');
    console.log(`   domain: ${result.subject.domain}`);
    console.log(`   challenge file: ${result.output}`);
    console.log(`   DNS: ${result.challenge.statement.dns.name} TXT "${result.challenge.statement.dns.value}"`);
    console.log(`   expires: ${result.challenge.statement.expiresAt}`);
  } else if (command === 'authority' && subcommand === 'complete') {
    if (!third) throw new Error('authority complete requires a .wurstreq path');
    if (!flags.challenge) throw new Error('authority complete requires --challenge <file.wurstchallenge>');
    const result = await completeRemoteAuthorityChallenge({ requestPath: third, challengePath: flags.challenge, certificatePath: flags.certificate, authorityUrl: flags.url ?? 'https://authority.wrst.io', output: flags.out });
    console.log('✅ WRST.IO DOMAIN CLAIM CERTIFIED');
    console.log(`   publisher: ${result.subject.domain ?? result.subject.email}`);
    console.log(`   fingerprint: ${result.subject.fingerprint}`);
    for (const claim of result.verification?.claims ?? []) console.log(`   ✓ ${claim.type}: ${claim.value} (${claim.verification?.method ?? 'verified'})`);
    console.log(`   certificate: ${result.output}`);
  } else if (command === 'authority' && subcommand === 'email-challenge') {
    if (!third) throw new Error('authority email-challenge requires a .wurstreq path');
    const result = await requestRemoteAuthorityEmailChallenge({ requestPath: third, authorityUrl: flags.url ?? 'https://authority.wrst.io', output: flags.out });
    console.log('📮 WRST.IO EMAIL VERIFICATION SENT');
    console.log(`   email: ${result.subject.email}`);
    console.log(`   challenge file: ${result.output}`);
    console.log(`   from: ${result.challenge.statement.delivery?.from ?? 'oink@wrst.io'}`);
    console.log(`   expires: ${result.challenge.statement.expiresAt}`);
    console.log('   Enter the six-digit code with authority email-complete.');
  } else if (command === 'authority' && subcommand === 'email-complete') {
    if (!third) throw new Error('authority email-complete requires a .wurstreq path');
    if (!flags.challenge) throw new Error('authority email-complete requires --challenge <file.wurstmailchallenge>');
    const code = await resolveEmailCode(flags, { prompt: true });
    const result = await completeRemoteAuthorityEmailChallenge({ requestPath: third, challengePath: flags.challenge, code, certificatePath: flags.certificate, authorityUrl: flags.url ?? 'https://authority.wrst.io', output: flags.out });
    console.log('✅ WRST.IO EMAIL CLAIM CERTIFIED');
    console.log(`   publisher: ${result.subject.email}`);
    console.log(`   fingerprint: ${result.subject.fingerprint}`);
    for (const claim of result.verification?.claims ?? []) console.log(`   ✓ ${claim.type}: ${claim.value} (${claim.verification?.method ?? 'verified'})`);
    console.log(`   certificate: ${result.output}`);
  } else if (command === 'certificate' && subcommand === 'inspect') {
    if (!third) throw new Error('certificate inspect requires a .wurstcert path');
    const roots = await readTrustedRoot(flags.root);
    const result = await inspectCertificate(third, roots);
    const v = result.verification;
    console.log('✅ Wurst publisher certificate');
    console.log(`   status: ${v.status}`);
    if (v.subject) {
      const publisher = v.subject.domain ?? v.subject.email ?? null;
      if (publisher) console.log(`   publisher: ${publisher}`);
      console.log(`   publisher key: ${v.subject.fingerprint}`);
    }
    for (const claim of v.claims ?? []) console.log(`   ✓ ${claim.type}: ${claim.value} (${claim.verification?.method ?? 'verified'})`);
    if (v.issuer) console.log(`   authority: ${v.root?.authority === 'wrst.io' ? 'WRST.IO' : (v.root?.authority ?? v.issuer.name)}`);
    if (v.error) console.log(`   error: ${v.error}`);
    if (!v.valid) process.exitCode = 2;
  } else {
    help();
  }
} catch (error) {
  console.error(`🥀 MEAT_GRINDER_ERROR: ${error.message}`);
  process.exitCode = 1;
}
