import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareReleaseAssets } from '../tools/prepare-release-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-release-assets-'));
const input = path.join(temp, 'parts');
const output = path.join(temp, 'assets');
await fs.mkdir(path.join(input, 'windows'), { recursive: true });
await fs.mkdir(path.join(input, 'mac-arm64'), { recursive: true });
await fs.mkdir(path.join(input, 'mac-x64'), { recursive: true });

const write = (dir, name, value) => fs.writeFile(path.join(input, dir, name), value);
await write('windows', `Wurster-Setup-${version}-x64.exe`, 'win-installer');
await write('mac-x64', `Wurster-${version}-mac-x64.zip`, 'mac-x64');
await write('mac-arm64', `Wurster-${version}-mac-arm64.zip`, 'mac-arm64');
await write('mac-arm64', `Wurster-${version}-mac-arm64.dmg`, 'arm-dmg');

await prepareReleaseAssets(input, output, { releaseDate: '2026-08-15T12:00:00.000Z' });
const win = await fs.readFile(path.join(output, 'latest.yml'), 'utf8');
const mac = await fs.readFile(path.join(output, 'latest-mac.yml'), 'utf8');
assert.match(win, new RegExp(`version: ${version.replaceAll('.', '\\.')}`));
assert.match(win, new RegExp(`url: Wurster-Setup-${version.replaceAll('.', '\\.')}-x64\\.exe`));
assert.doesNotMatch(win, /blockMapSize:/);
assert.match(win, /isAdminRightsRequired: true/);
assert.match(mac, new RegExp(`url: Wurster-${version.replaceAll('.', '\\.')}-mac-x64\\.zip`));
assert.match(mac, new RegExp(`url: Wurster-${version.replaceAll('.', '\\.')}-mac-arm64\\.zip`));
assert.doesNotMatch(mac, /\.dmg\n/);
assert.match(mac, /releaseDate: '2026-08-15T12:00:00\.000Z'/);

await assert.rejects(async () => {
  await fs.mkdir(path.join(input, 'duplicate'), { recursive: true });
  await fs.writeFile(path.join(input, 'duplicate', `Wurster-${version}-mac-arm64.dmg`), 'duplicate');
  await prepareReleaseAssets(input, path.join(temp, 'duplicate-output'));
}, /Duplicate release asset basename/);

await fs.rm(temp, { recursive: true, force: true });
console.log('✓ release staging creates GitHub updater metadata for Windows and both Mac architectures');
