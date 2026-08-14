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
const desktopBuilder = await fs.readFile(path.join(root, 'tools', 'build-desktop-runtime.mjs'), 'utf8');
const edgeRuntimeTool = await fs.readFile(path.join(root, 'tools', 'wurster-edge-runtime.mjs'), 'utf8');
const edgeRuntimeLock = JSON.parse(await fs.readFile(path.join(root, 'runtime', 'edge-runtime.lock.json'), 'utf8'));
const webBuilder = await fs.readFile(path.join(root, 'runtime', 'web', 'build.mjs'), 'utf8');

await assert.rejects(fs.stat(path.join(root, 'examples')), /ENOENT/);
for (const [name, command] of Object.entries(pkg.scripts)) assert.doesNotMatch(command, /\bexamples\//, `script ${name} still depends on /examples`);
assert.equal(desktop.build.win.artifactName, 'Wurster-Setup-${version}-${arch}.${ext}');
assert.equal(desktop.build.mac.artifactName, 'Wurster-${version}-mac-${arch}.${ext}');
assert.equal(desktop.build.linux.artifactName, 'Wurster-${version}-linux-${arch}.${ext}');
assert.deepEqual(desktop.build.extraResources, [{ from: 'runtimes', to: 'runtimes', filter: ['wurster-edge-runtime-*/**/*'] }]);
assert.equal(pkg.scripts['dist:linux'], 'npm run dist:linux --workspace @wurster/desktop');
assert.equal(pkg.scripts['runtime:edge:prepare'], 'node tools/wurster-edge-runtime.mjs prepare');

assert.match(desktopBuilder, /process\.env\.npm_execpath/);
assert.match(desktopBuilder, /process\.execPath/);
assert.doesNotMatch(desktopBuilder, /spawn\([^\n]*npm\.cmd/);
assert.match(desktopBuilder, /prepareDesktopEdgeRuntimes/);
assert.match(desktopBuilder, /WURSTER_BUNDLE_PIGSTY/);
assert.match(desktopBuilder, /Pigsty Edge runtime is not bundled in this release \(coming soon\)/);
assert.match(desktopBuilder, /'windows', 'mac', 'linux'/);
assert.match(desktopBuilder, /--linux', 'AppImage'/);

assert.equal(edgeRuntimeLock.repository, 'WRST-IO/wurster-edge-runtime');
assert.equal(edgeRuntimeLock.tag, 'v0.1.0-dev.2');
assert.deepEqual(edgeRuntimeLock.targets['linux-amd64'], { asset: 'wurster-edge-runtime-linux-amd64.tar.gz', archiveFormat: 'tar.gz' });
assert.deepEqual(edgeRuntimeLock.targets['darwin-arm64'], { asset: 'wurster-edge-runtime-darwin-arm64.tar.gz', archiveFormat: 'tar.gz' });
assert.deepEqual(edgeRuntimeLock.targets['darwin-amd64'], { asset: 'wurster-edge-runtime-darwin-amd64.tar.gz', archiveFormat: 'tar.gz' });
assert.deepEqual(edgeRuntimeLock.targets['windows-amd64'], { asset: 'wurster-edge-runtime-windows-amd64.zip', archiveFormat: 'zip' });
assert.match(edgeRuntimeTool, /WURSTER_EDGE_RUNTIME_TOKEN/);
assert.match(edgeRuntimeTool, /releases\/tags/);
assert.match(edgeRuntimeTool, /archive checksum mismatch/);
assert.match(edgeRuntimeTool, /verifyEdgeRuntimeDirectory/);

assert.match(webBuilder, /wurster\.js/);
assert.match(webBuilder, /wurster\.min\.js/);
assert.match(webBuilder, /minify:\s*true/);

assert.match(release, /tags:\s*\n\s*- 'v\*'/);
assert.match(release, /runs-on: macos-latest/);
assert.match(release, /runs-on: macos-15-intel/);
assert.match(release, /runs-on: windows-latest/);
assert.match(release, /\n\s*web:\s*\n/);
assert.match(release, /npm run runtime:web:build/);
assert.match(release, /Wurster-Web-\$\{version\}\.zip/);
assert.match(release, /runtime-web/);
assert.doesNotMatch(release, /pigsty-linux-amd64:/);
assert.doesNotMatch(release, /runtime:edge:prepare/);
assert.doesNotMatch(release, /WURSTER_EDGE_RUNTIME_TOKEN/);
assert.doesNotMatch(release, /pigsty-edge-wasix\.test\.mjs/);
assert.match(release, /needs: \[web, mac-arm64, mac-x64, windows-x64\]/);
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
assert.match(runtimePage, /Download Web runtime/);
assert.match(runtimePage, /wurster\.min\.js/);
assert.match(runtimePage, /Wurst Viewer/);
assert.match(releaseData, /Wurster-Setup-\$\{pkg\.version\}-x64\.exe/);
assert.match(releaseData, /Wurster-\$\{pkg\.version\}-mac-arm64\.dmg/);
assert.match(releaseData, /Wurster-\$\{pkg\.version\}-mac-x64\.dmg/);
assert.match(releaseData, /wurster\.js/);
assert.match(releaseData, /wurster\.min\.js/);
assert.match(releaseData, /Wurster-Web-\$\{pkg\.version\}\.zip/);

console.log('✓ GitHub tag releases publish Windows, macOS and Web without waiting for the optional Pigsty bundle');
