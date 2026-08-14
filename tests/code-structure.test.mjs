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
const pigletSurfaceRuntime = await text('runtime/desktop/src/piglet-surface-runtime.mjs');
const pigletBackingRuntime = await text('runtime/desktop/src/piglet-backing-runtime.mjs');
const pigletWurstFsRuntime = await text('runtime/desktop/src/piglet-wurstfs-runtime.mjs');
const trustedSurfaceRuntime = await text('runtime/desktop/src/trusted-surface-runtime.mjs');
const piglinkRuntime = await text('runtime/desktop/src/piglink-runtime.mjs');
const pigstyRuntime = await text('runtime/desktop/src/pigsty-runtime.mjs');
const webSandboxRuntime = await text('runtime/desktop/src/web-sandbox-runtime.mjs');

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
  ['piglet-surface-runtime', pigletSurfaceRuntime],
  ['piglet-backing-runtime', pigletBackingRuntime],
  ['piglet-wurstfs-runtime', pigletWurstFsRuntime],
  ['trusted-surface-runtime', trustedSurfaceRuntime],
  ['piglink-runtime', piglinkRuntime],
  ['pigsty-runtime', pigstyRuntime],
  ['web-sandbox-runtime', webSandboxRuntime]
]) {
  assert.ok(lines(source) <= 250, `${name} should stay a focused runtime module (${lines(source)} lines)`);
}

assert.doesNotMatch(main, /ipcMain\.(?:handle|on)\(['"]wurst:pig(?:let|link|sty):/,
  'Pig IPC ownership belongs in the dedicated desktop runtime modules');
assert.doesNotMatch(main, /from ['"]@wurster\/pigsty['"]/, 'desktop main must not own the Pigsty engine implementation');
assert.doesNotMatch(main, /from ['"]@wurster\/piglink['"]/, 'desktop main must not own PigLink validation');

const directIpcRegistrations = [...main.matchAll(/^ipcMain\.(?:handle|on)\(/gm)].length;
assert.ok(directIpcRegistrations <= 81, `desktop main owns too many direct IPC registrations (${directIpcRegistrations})`);

console.log(`✓ code structure budgets hold; desktop main is ${lines(main)} lines with ${directIpcRegistrations} direct IPC registrations`);
