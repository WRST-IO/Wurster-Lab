import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

async function text(relative) {
  return fs.readFile(path.join(root, relative), 'utf8');
}

function lines(value) {
  return value.split(/\r?\n/).length;
}

const main = await text('runtime/desktop/src/main.mjs');
const web = await text('runtime/web/src/wurster-web.mjs');
const format = await text('packages/format/src/index.js');
const pigsty = await text('packages/pigsty/src/index.js');
const pigletRuntime = await text('runtime/desktop/src/piglet-runtime.mjs');
const pigletPackageRuntime = await text('runtime/desktop/src/piglet-package.mjs');
const pigletStorageRuntime = await text('runtime/desktop/src/piglet-storage-runtime.mjs');
const pigletEmbedRuntime = await text('runtime/desktop/src/piglet-embed-runtime.mjs');
const pigletMachineRuntime = await text('runtime/desktop/src/piglet-machine-runtime.mjs');
const pigletBackingRuntime = await text('runtime/desktop/src/piglet-backing-runtime.mjs');
const pigletPigFsRuntime = await text('runtime/desktop/src/piglet-pigfs-runtime.mjs');
const trustedSurfaceRuntime = await text('runtime/desktop/src/trusted-surface-runtime.mjs');
const piglinkRuntime = await text('runtime/desktop/src/piglink-runtime.mjs');
const pigstyRuntime = await text('runtime/desktop/src/pigsty-runtime.mjs');
const webSandboxRuntime = await text('runtime/desktop/src/web-sandbox-runtime.mjs');
const webSourceRuntime = await text('runtime/web/src/wurst-source.mjs');
const webTrustRuntime = await text('runtime/web/src/trust-runtime.mjs');
const webRuntimeUtil = await text('runtime/web/src/web-runtime-util.mjs');
const webPigletMachineRuntime = await text('runtime/web/src/piglet-machine-runtime.mjs');
const headlessFileRuntime = await text('packages/headless/src/file-runtime.js');
const pigletContract = await text('packages/piglet/src/index.js');
const pigletSessionContract = await text('packages/piglet/src/session.js');

// These are budgets, not style targets. They stop known large modules from
// silently growing while follow-up refactors continue to split responsibilities.
assert.ok(lines(main) <= 3500, `desktop main.mjs exceeded temporary 3500-line budget (${lines(main)})`);
assert.ok(lines(web) <= 950, `web runtime exceeded temporary 950-line budget (${lines(web)})`);
assert.ok(lines(format) <= 2100, `format index exceeded temporary 2100-line budget (${lines(format)})`);
assert.ok(lines(pigsty) <= 1000, `Pigsty core exceeded temporary 1000-line budget (${lines(pigsty)})`);

for (const [name, source] of [
  ['piglet-runtime', pigletRuntime],
  ['piglet-package-runtime', pigletPackageRuntime],
  ['piglet-storage-runtime', pigletStorageRuntime],
  ['piglet-embed-runtime', pigletEmbedRuntime],
  ['piglet-machine-runtime', pigletMachineRuntime],
  ['piglet-backing-runtime', pigletBackingRuntime],
  ['piglet-pigfs-runtime', pigletPigFsRuntime],
  ['trusted-surface-runtime', trustedSurfaceRuntime],
  ['piglink-runtime', piglinkRuntime],
  ['pigsty-runtime', pigstyRuntime],
  ['web-sandbox-runtime', webSandboxRuntime],
  ['web-source-runtime', webSourceRuntime],
  ['web-trust-runtime', webTrustRuntime],
  ['web-runtime-util', webRuntimeUtil],
  ['web-piglet-machine-runtime', webPigletMachineRuntime],
  ['headless-file-runtime', headlessFileRuntime],
  ['piglet-contract', pigletContract],
  ['piglet-session-contract', pigletSessionContract]
]) {
  assert.ok(lines(source) <= 250, `${name} should stay a focused runtime module (${lines(source)} lines)`);
}

assert.doesNotMatch(main, /ipcMain\.(?:handle|on)\(['"]wurst:pig(?:let|link|sty):/,
  'Pig IPC ownership belongs in the dedicated desktop runtime modules');
assert.doesNotMatch(main, /from ['"]@wurster\/pigsty['"]/, 'desktop main must not own the Pigsty engine implementation');
assert.doesNotMatch(main, /from ['"]@wurster\/piglink['"]/, 'desktop main must not own PigLink validation');
assert.doesNotMatch(main, /createPigletSurfaceManager|piglet-surface-runtime|pigletSurface/, 'Piglet application UI must not use native WebContentsView surfaces');
assert.match(main, /allowServiceWorkers:\s*true/, 'wurst: must permit the Wurster-owned embed host service worker');
assert.match(main, /process\.resourcesPath, 'web-runtime'/, 'packaged Desktop must load the shared Wurster Web embed runtime from extraResources');
assert.match(main, /\.\.\/\.\.\/web\/dist/, 'Desktop development must use the same built browser runtime contract as packaged Wurster');
assert.match(await text('runtime/desktop/src/wurst-preload.cjs'), /wurst:\/\/runtime\/wurster-embed\.mjs/, 'Desktop Wursts must receive the universal <wurst-embed> runtime');
const preload = await text('runtime/desktop/src/wurst-preload.cjs');
assert.doesNotMatch(preload, /wurst:piglet:url|wurst:\/\/piglet/, 'pre-embed Piglet byte URL APIs must not return');
assert.doesNotMatch(main, /wurst:\/\/piglet|wurst:piglet:url/, 'Desktop must not revive raw Piglet URL serving');
assert.doesNotMatch(web, /pigletUrl\(|openPiglet\(/, 'Web must keep <wurst-embed> as the single Piglet presentation API');
assert.match(pigletSessionContract, /format:\s*'wurst\/runtime-session-1'/, 'Piglet must expose a runtime-neutral one-Wurst session contract');
assert.match(pigletRuntime, /wurst:piglet:running/, 'Desktop must expose running Wurst sessions independently from view presentation');
assert.match(preload, /running:\s*\(\)\s*=>\s*invoke\('wurst:piglet:running'\)/, 'Desktop Wurst API must expose running child Wurst sessions');
assert.match(preload, /connectPigletMachine/, 'Desktop Wurst API must expose the DOM-free Piglet machine end');
assert.match(pigletRuntime, /wurst:piglet:machine-connect/, 'Desktop Piglet runtime must own machine attachment IPC');
assert.match(pigletEmbedRuntime, /invokePigLinkActionSource/, 'Desktop machine clients must execute PigLink from the shared Wurst source rather than a Host file copy');
assert.match(web, /piglet\.machineConnect/, 'Wurster Web must expose the same DOM-free Piglet machine end');
assert.match(await text('runtime/web/src/wurster-sw.js'), /machine/, 'Wurster Web service worker must route the Wurster-owned machine execution scope');
assert.match(headlessFileRuntime, /piglet\.machineConnect/, 'Headless Wursts must be able to attach Child Wursts as machine subtools without DOM presentation');
const supportedCapabilities = main.match(/const SUPPORTED_CAPABILITIES = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
assert.doesNotMatch(supportedCapabilities, /['"]piglet['"]|['"]pigsty['"]/, 'Piglet/Pigsty are runtime pillars, not Host-style capability permissions');

const directIpcRegistrations = [...main.matchAll(/^ipcMain\.(?:handle|on)\(/gm)].length;
assert.ok(directIpcRegistrations <= 81, `desktop main owns too many direct IPC registrations (${directIpcRegistrations})`);

console.log(`✓ code structure budgets hold; desktop main is ${lines(main)} lines with ${directIpcRegistrations} direct IPC registrations`);
