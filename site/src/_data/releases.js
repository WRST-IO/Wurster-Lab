const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
const repository = String(process.env.WURSTER_RELEASE_REPOSITORY || process.env.GITHUB_REPOSITORY || '').trim();
const tag = `v${pkg.version}`;
const releaseRoot = repository ? `https://github.com/${repository}/releases` : '';
const assetRoot = releaseRoot ? `${releaseRoot}/download/${tag}` : '';

module.exports = {
  available: Boolean(repository),
  repository,
  version: pkg.version,
  tag,
  releaseUrl: releaseRoot ? `${releaseRoot}/tag/${tag}` : '',
  allReleasesUrl: releaseRoot || '',
  windowsX64: assetRoot ? `${assetRoot}/Wurster-Setup-${pkg.version}-x64.exe` : '',
  macArm64: assetRoot ? `${assetRoot}/Wurster-${pkg.version}-mac-arm64.dmg` : '',
  macX64: assetRoot ? `${assetRoot}/Wurster-${pkg.version}-mac-x64.dmg` : '',
  webJs: assetRoot ? `${assetRoot}/wurster.js` : '',
  webMin: assetRoot ? `${assetRoot}/wurster.min.js` : '',
  webZip: assetRoot ? `${assetRoot}/Wurster-Web-${pkg.version}.zip` : ''
};
