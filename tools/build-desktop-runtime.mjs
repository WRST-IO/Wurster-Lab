import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareDesktopEdgeRuntimes } from './wurster-edge-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env.signing.local');

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}


export function shouldBundlePigsty(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.WURSTER_BUNDLE_PIGSTY ?? ''));
}

export function npmInvocation(args, {
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath
} = {}) {
  if (!npmExecPath) {
    throw new Error('[Wurster Lab] npm_execpath is unavailable; run desktop packaging through an npm script');
  }
  return { command: execPath, args: [npmExecPath, ...args] };
}

export async function runDesktopBuild(argv = process.argv.slice(2)) {
  const fileEnv = parseEnvFile(ENV_FILE);
  const env = { ...process.env, ...fileEnv };
  const target = String(argv[0] || '').toLowerCase();
  const arch = String(argv[1] || '').toLowerCase();
  if (!['windows', 'mac', 'linux'].includes(target)) throw new Error('Usage: node tools/build-desktop-runtime.mjs <windows|mac|linux> [x64|arm64|universal]');

  const args = ['exec', '--', 'electron-builder'];
  if (target === 'windows') {
    args.push('--win', 'nsis', `--${arch || 'x64'}`, '--config.directories.output=../windows/dist');
    if (env.WURSTER_WIN_CSC_LINK) env.WIN_CSC_LINK = env.WURSTER_WIN_CSC_LINK;
    if (env.WURSTER_WIN_CSC_KEY_PASSWORD) env.WIN_CSC_KEY_PASSWORD = env.WURSTER_WIN_CSC_KEY_PASSWORD;
    if (env.WURSTER_WIN_CERTIFICATE_SUBJECT_NAME) args.push(`--config.win.signtoolOptions.certificateSubjectName=${env.WURSTER_WIN_CERTIFICATE_SUBJECT_NAME}`);
    if (env.WURSTER_WIN_CERTIFICATE_SHA1) args.push(`--config.win.signtoolOptions.certificateSha1=${env.WURSTER_WIN_CERTIFICATE_SHA1}`);
    const azure = [env.WURSTER_AZURE_SIGNING_PUBLISHER_NAME, env.WURSTER_AZURE_SIGNING_ENDPOINT, env.WURSTER_AZURE_SIGNING_CERTIFICATE_PROFILE_NAME, env.WURSTER_AZURE_SIGNING_ACCOUNT_NAME];
    if (azure.every(Boolean)) {
      args.push(`--config.win.azureSignOptions.publisherName=${azure[0]}`);
      args.push(`--config.win.azureSignOptions.endpoint=${azure[1]}`);
      args.push(`--config.win.azureSignOptions.certificateProfileName=${azure[2]}`);
      args.push(`--config.win.azureSignOptions.codeSigningAccountName=${azure[3]}`);
    }
  } else if (target === 'mac') {
    args.push('--mac', 'dmg', 'zip', `--${arch || 'universal'}`, '--config.directories.output=../mac/dist');
    if (env.WURSTER_MAC_CSC_LINK) env.CSC_LINK = env.WURSTER_MAC_CSC_LINK;
    if (env.WURSTER_MAC_CSC_KEY_PASSWORD) env.CSC_KEY_PASSWORD = env.WURSTER_MAC_CSC_KEY_PASSWORD;
    if (env.WURSTER_MAC_IDENTITY) args.push(`--config.mac.identity=${env.WURSTER_MAC_IDENTITY}`);
    if (/^(1|true|yes)$/i.test(env.WURSTER_MAC_NOTARIZE || '')) args.push('--config.mac.notarize=true');
  } else {
    args.push('--linux', 'AppImage', `--${arch || 'x64'}`, '--config.directories.output=../linux/dist');
  }

  if (shouldBundlePigsty(env)) {
    console.log(`[Wurster Lab] preparing Pigsty Edge runtime for ${target}${arch ? `/${arch}` : ''}`);
    const edgeRuntime = await prepareDesktopEdgeRuntimes({ target, arch, env });
    for (const item of edgeRuntime.targets) {
      console.log(`[Wurster Lab] Pigsty runtime: ${item.target} ${item.manifest.version} (${item.source})`);
    }
  } else {
    console.log('[Wurster Lab] Pigsty Edge runtime is not bundled in this release (coming soon)');
  }

  console.log(`[Wurster Lab] building ${target}${arch ? `/${arch}` : ''}`);
  console.log(`[Wurster Lab] signing env: ${fs.existsSync(ENV_FILE) ? '.env.signing.local loaded' : 'no local signing env (unsigned/local discovery)'}`);

  // npm.cmd is a shell script on Windows and must not be spawned as a native
  // executable. npm exposes its JavaScript CLI path to npm-run scripts, so use
  // the already-running Node executable to invoke that CLI on every platform.
  const invocation = npmInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: path.join(ROOT, 'runtime', 'desktop'),
    stdio: 'inherit',
    env
  });
  child.on('error', (error) => {
    console.error(`[Wurster Lab] desktop builder failed to start: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  return child;
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runDesktopBuild().catch((error) => {
  console.error(`[Wurster Lab] ${error?.message || error}`);
  process.exit(1);
});
