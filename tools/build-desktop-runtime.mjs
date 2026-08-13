import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const fileEnv = parseEnvFile(ENV_FILE);
const env = { ...process.env, ...fileEnv };
const target = String(process.argv[2] || '').toLowerCase();
const arch = String(process.argv[3] || '').toLowerCase();
if (!['windows', 'mac'].includes(target)) throw new Error('Usage: node tools/build-desktop-runtime.mjs <windows|mac> [x64|arm64|universal]');

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
} else {
  args.push('--mac', 'dmg', 'zip', `--${arch || 'universal'}`, '--config.directories.output=../mac/dist');
  if (env.WURSTER_MAC_CSC_LINK) env.CSC_LINK = env.WURSTER_MAC_CSC_LINK;
  if (env.WURSTER_MAC_CSC_KEY_PASSWORD) env.CSC_KEY_PASSWORD = env.WURSTER_MAC_CSC_KEY_PASSWORD;
  if (env.WURSTER_MAC_IDENTITY) args.push(`--config.mac.identity=${env.WURSTER_MAC_IDENTITY}`);
  if (/^(1|true|yes)$/i.test(env.WURSTER_MAC_NOTARIZE || '')) args.push('--config.mac.notarize=true');
}

console.log(`[Wurster Lab] building ${target}${arch ? `/${arch}` : ''}`);
console.log(`[Wurster Lab] signing env: ${fs.existsSync(ENV_FILE) ? '.env.signing.local loaded' : 'no local signing env (unsigned/local discovery)'}`);
const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
  cwd: path.join(ROOT, 'runtime', 'desktop'),
  stdio: 'inherit',
  env
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
