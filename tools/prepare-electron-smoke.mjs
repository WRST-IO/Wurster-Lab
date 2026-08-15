#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const desktopRequire = createRequire(new URL('../runtime/desktop/package.json', import.meta.url));
const electronPackagePath = desktopRequire.resolve('electron/package.json');
const electronDir = path.dirname(electronPackagePath);
const electronPackage = JSON.parse(await fs.readFile(electronPackagePath, 'utf8'));
const installScript = path.join(electronDir, 'install.js');
const timeoutMs = Math.max(1_000, Number(process.env.WURSTER_ELECTRON_PREPARE_TIMEOUT_MS || 240_000));
const heartbeatMs = Math.max(1_000, Number(process.env.WURSTER_ELECTRON_PREPARE_HEARTBEAT_MS || 15_000));

async function installedExecutable() {
  try {
    const relative = (await fs.readFile(path.join(electronDir, 'path.txt'), 'utf8')).trim();
    if (!relative) return null;
    const executable = path.join(electronDir, 'dist', relative);
    await fs.access(executable);
    return executable;
  } catch {
    return null;
  }
}

const alreadyInstalled = await installedExecutable();
if (alreadyInstalled) {
  console.log(`✓ Electron ${electronPackage.version} smoke binary already prepared: ${alreadyInstalled}`);
  process.exit(0);
}

console.log(`[Wurster Lab] preparing Electron ${electronPackage.version} smoke binary`);
console.log(`[Wurster Lab] Electron cache: ${process.env.electron_config_cache || '(platform default)'}`);
console.log(`[Wurster Lab] hard timeout: ${Math.round(timeoutMs / 1000)}s`);

const startedAt = Date.now();
const child = spawn(process.execPath, [installScript], {
  cwd: electronDir,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true
});

let timedOut = false;
const heartbeat = setInterval(() => {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[Wurster Lab] Electron binary preparation still running (${elapsed}s)`);
}, heartbeatMs);

const timeout = setTimeout(() => {
  timedOut = true;
  console.error(`[Wurster Lab] Electron binary preparation exceeded ${Math.round(timeoutMs / 1000)}s; terminating downloader`);
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5_000).unref();
}, timeoutMs);

const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

clearInterval(heartbeat);
clearTimeout(timeout);

if (timedOut) throw new Error('Electron smoke binary preparation timed out');
if (result.code !== 0) throw new Error(`Electron smoke binary preparation failed (code=${result.code}, signal=${result.signal || 'none'})`);

const executable = await installedExecutable();
if (!executable) throw new Error('Electron installer exited successfully but no executable was installed');
console.log(`✓ Electron ${electronPackage.version} smoke binary prepared: ${executable}`);
