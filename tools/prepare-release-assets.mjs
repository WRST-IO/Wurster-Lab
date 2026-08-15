import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(directory) {
  const out = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function sha512Base64(file) {
  const hash = crypto.createHash('sha512');
  hash.update(await fs.readFile(file));
  return hash.digest('base64');
}

async function updateFile(output, name) {
  const file = path.join(output, name);
  const stat = await fs.stat(file);
  return { name, sha512: await sha512Base64(file), size: stat.size };
}

function yamlEntry(file) {
  const rows = [`  - url: ${file.name}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`];
  if (file.isAdminRightsRequired === true) rows.push('    isAdminRightsRequired: true');
  return rows.join('\n');
}

function metadata(version, files, releaseDate) {
  const preferred = files[0];
  return [
    `version: ${version}`,
    'files:',
    ...files.map(yamlEntry),
    `path: ${preferred.name}`,
    `sha512: ${preferred.sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n');
}

export async function prepareReleaseAssets(input, output, { releaseDate = new Date().toISOString() } = {}) {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = String(pkg.version);
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });

  const seen = new Set();
  for (const source of await walk(input)) {
    const name = path.basename(source);
    if (/^latest(?:-mac)?\.ya?ml$/i.test(name)) continue;
    if (seen.has(name)) throw new Error(`Duplicate release asset basename: ${name}`);
    seen.add(name);
    await fs.copyFile(source, path.join(output, name));
  }

  const win = await updateFile(output, `Wurster-Setup-${version}-x64.exe`);
  win.isAdminRightsRequired = true;
  const macX64 = await updateFile(output, `Wurster-${version}-mac-x64.zip`);
  const macArm64 = await updateFile(output, `Wurster-${version}-mac-arm64.zip`);

  await fs.writeFile(path.join(output, 'latest.yml'), metadata(version, [win], releaseDate));
  await fs.writeFile(path.join(output, 'latest-mac.yml'), metadata(version, [macX64, macArm64], releaseDate));
  return { version, files: [...seen], updateMetadata: ['latest.yml', 'latest-mac.yml'] };
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = path.resolve(process.argv[2] || 'release-parts');
  const output = path.resolve(process.argv[3] || 'release-assets');
  prepareReleaseAssets(input, output).then((result) => {
    console.log(`[Wurster Lab] staged ${result.files.length} release assets plus ${result.updateMetadata.join(', ')} for ${result.version}`);
  }).catch((error) => {
    console.error(`[Wurster Lab] ${error?.message || error}`);
    process.exit(1);
  });
}
