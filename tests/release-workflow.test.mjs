import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const desktop = JSON.parse(await fs.readFile(path.join(root, 'runtime', 'desktop', 'package.json'), 'utf8'));
const release = await fs.readFile(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const pages = await fs.readFile(path.join(root, '.github', 'workflows', 'pages.yml'), 'utf8');
const runtimePage = await fs.readFile(path.join(root, 'site', 'src', 'runtime.md'), 'utf8');
const releaseData = await fs.readFile(path.join(root, 'site', 'src', '_data', 'releases.js'), 'utf8');

await assert.rejects(fs.stat(path.join(root, 'examples')), /ENOENT/);
for (const [name, command] of Object.entries(pkg.scripts)) assert.doesNotMatch(command, /\bexamples\//, `script ${name} still depends on /examples`);
assert.equal(desktop.build.win.artifactName, 'Wurster-Setup-${version}-${arch}.${ext}');
assert.equal(desktop.build.mac.artifactName, 'Wurster-${version}-mac-${arch}.${ext}');

assert.match(release, /tags:\s*\n\s*- 'v\*'/);
assert.match(release, /runs-on: macos-latest/);
assert.match(release, /runs-on: macos-15-intel/);
assert.match(release, /runs-on: windows-latest/);
assert.match(release, /npm run dist:mac:arm64/);
assert.match(release, /npm run dist:mac:x64/);
assert.match(release, /npm run dist:win/);
assert.match(release, /actions\/upload-artifact@v7/);
assert.match(release, /actions\/download-artifact@v8/);
assert.match(release, /SHA256SUMS\.txt/);
assert.match(release, /gh release create/);

assert.match(pages, /actions\/upload-pages-artifact@v5/);
assert.match(pages, /include-hidden-files: true/);
assert.match(pages, /actions\/deploy-pages@v5/);
assert.match(pages, /WURSTER_RELEASE_REPOSITORY/);

assert.doesNotMatch(runtimePage, /npm run dist:/);
assert.match(runtimePage, /Download Setup\.exe/);
assert.match(runtimePage, /Apple Silicon/);
assert.match(runtimePage, /Intel Mac/);
assert.match(runtimePage, /CDN package · coming soon/);
assert.match(releaseData, /Wurster-Setup-\$\{pkg\.version\}-x64\.exe/);
assert.match(releaseData, /Wurster-\$\{pkg\.version\}-mac-arm64\.dmg/);
assert.match(releaseData, /Wurster-\$\{pkg\.version\}-mac-x64\.dmg/);

console.log('✓ GitHub tag releases build native runtime installers and wrst.io links directly to versioned release assets');
