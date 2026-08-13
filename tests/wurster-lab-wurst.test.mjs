import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractOperatorWorkspaceZip, validateOperatorSettings, writeZip } from '../tools/wurster-lab-wurst/src/workspace-zip.js';

const root = path.resolve(import.meta.dirname, '..');
const appRoot = path.join(root, 'tools', 'wurster-lab-wurst');
const manifest = JSON.parse(await fs.readFile(path.join(appRoot, 'wurst.json'), 'utf8'));
const app = await fs.readFile(path.join(appRoot, 'src', 'app.js'), 'utf8');
const html = await fs.readFile(path.join(appRoot, 'src', 'index.html'), 'utf8');
const css = await fs.readFile(path.join(appRoot, 'src', 'styles.css'), 'utf8');
const tool = await fs.readFile(path.join(root, 'tools', 'wurster-lab-wurst.mjs'), 'utf8');

assert.equal(manifest.id, 'io.wrst.wurster-lab');
assert.equal(manifest.data.format, 'wurst/data-realms-1');
assert.equal(manifest.capabilities['files.open'], true);
assert.equal(manifest.capabilities['files.save'], true);
assert.deepEqual(manifest.data.realms.map((realm) => realm.id), ['workspace', 'lab', 'operator']);
assert.equal(Object.hasOwn(manifest.data.realms[0], 'mode'), false);
assert.equal(Object.hasOwn(manifest.data.realms[0], 'governance'), false);
assert.equal(manifest.data.realms[2].governance, 'personal');
assert.equal(Object.hasOwn(manifest.data.realms[2], 'mode'), false);

for (const name of ['root.json', 'issuer.json', 'trust-bundle.json', 'issuer.wurstissuer']) assert.match(app, new RegExp(name.replaceAll('.', '\\.')));
assert.match(app, /verifyOperatorMaterial/);
assert.match(html, /Changelog/);
assert.match(html, /Notes that travel with Wurster Lab/);
assert.match(html, /PIG SCIENCE/);
assert.match(html, /Verwursten/);
assert.match(html, /Unlock Operator Admin Zone/);
assert.match(html, /OPERATOR ADMIN ZONE/);
assert.match(html, /Mail Relay memory/);
assert.match(html, /Import previous operator ZIP/);
assert.match(html, /id="relayUrl"/);
assert.match(html, /id="relaySecret"/);
assert.match(app, /exportProductionWorkspace/);
assert.match(app, /OPERATOR_SETTINGS_PATH/);
assert.match(app, /extractOperatorWorkspaceZip/);
assert.match(app, /saveOperatorSettings/);
assert.match(app, /async function readBytes/);
assert.match(app, /lockRealm\('operator'\)/);
assert.match(css, /--pink:#eb536f/);
assert.match(css, /user-select:none/);
assert.match(css, /textarea,input.*user-select:text/);
assert.match(tool, /WursterLab_v\$\{version\}_r\$\{String\(revision\)\.padStart\(3, '0'\)\}\.wurst/);
assert.match(tool, /Wurster Lab updates must use a new filename/);
assert.match(tool, /explicitMatch/);
assert.match(tool, /Number\(explicitMatch\[2\]\)/);
assert.match(tool, /authority\/wrst\.io\/private/);

const workspaceZipSource = await fs.readFile(path.join(appRoot, 'src', 'workspace-zip.js'), 'utf8');
assert.match(workspaceZipSource, /site\/src\/\.well-known\/wurst-authority-root\.json/);
assert.match(workspaceZipSource, /site\/src\/\.well-known\/wurst-trust-bundle\.json/);
assert.doesNotMatch(workspaceZipSource, /wurst-authority-issuer\.json/);
assert.match(workspaceZipSource, /wrst\/operator-settings-1/);
assert.match(workspaceZipSource, /authority\/wrst\.io\/private\/operator-settings\.json/);


const sealedSettings = validateOperatorSettings({
  mailRelayUrl: 'https://mail.wrst.io/wrst-mail-relay.php',
  mailRelaySecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
}, { requireComplete: true });
const zipPrefix = 'wurster_lab/';
const testZip = writeZip([], new Map([
  [`${zipPrefix}package.json`, new TextEncoder().encode('{}\n')],
  [`${zipPrefix}authority/wrst.io/public/root.json`, new TextEncoder().encode('{"root":true}\n')],
  [`${zipPrefix}authority/wrst.io/public/issuer.json`, new TextEncoder().encode('{"issuer":true}\n')],
  [`${zipPrefix}authority/wrst.io/public/trust-bundle.json`, new TextEncoder().encode('{"bundle":true}\n')],
  [`${zipPrefix}authority/wrst.io/private/issuer.wurstissuer`, new TextEncoder().encode('{"private":true}\n')],
  [`${zipPrefix}authority/wrst.io/private/operator-settings.json`, new TextEncoder().encode(JSON.stringify(sealedSettings))]
]));
const rehydrated = extractOperatorWorkspaceZip(testZip);
assert.equal(rehydrated.settings.mailRelayUrl, 'https://mail.wrst.io/wrst-mail-relay.php');
assert.equal(rehydrated.settings.mailRelaySecret, sealedSettings.mailRelaySecret);

console.log('✓ WursterLab.wurst keeps ordinary workspace data separate from the personal operator realm and always uses incremental handoff filenames');
