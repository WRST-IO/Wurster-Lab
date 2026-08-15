import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const [main, launcher, preload, settings] = await Promise.all([
  fs.readFile(new URL('../runtime/desktop/src/main.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('../runtime/desktop/src/launcher.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../runtime/desktop/src/launcher-preload.cjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('../runtime/desktop/src/settings.html', import.meta.url), 'utf8')
]);

assert.match(main, /async function openSettingsWindow\(\)[\s\S]*showSettingsInLauncher\(\{ section: 'general', identitiesUnlocked: false \}\)/);
assert.match(main, /async function openProtectedSettingsWindow\(\)[\s\S]*promptWursterAdministrationPresence\(\)[\s\S]*section: 'identities', identitiesUnlocked: true/);
assert.match(main, /wurster:settings:identities:unlock[\s\S]*promptWursterAdministrationPresence/);
assert.match(main, /function assertSettingsIdentityUnlocked[\s\S]*settingsIdentityUnlocked/);
assert.match(main, /wurster:settings:identity:add[\s\S]{0,180}assertSettingsIdentityUnlocked\(event\)/);
assert.match(main, /wurster:settings:publisher:add[\s\S]{0,180}assertSettingsIdentityUnlocked\(event\)/);
assert.match(main, /wurster:settings:totp:begin[\s\S]{0,180}assertSettingsIdentityUnlocked\(event\)/);
assert.match(main, /wurster:settings:update:auto[\s\S]{0,240}assertSettingsSender\(event\)/);
assert.doesNotMatch(main.match(/wurster:settings:update:auto[^\n]*/)?.[0] || '', /assertSettingsIdentityUnlocked/);
assert.match(main, /maximizable: false/);
assert.match(main, /fullscreenable: false/);

assert.match(preload, /settings: \(\) => ipcRenderer\.invoke\('wurster:launcher:settings'\)/);
assert.match(preload, /version: \(\) => ipcRenderer\.invoke\('wurster:launcher:version'\)/);
assert.match(preload, /unlockIdentities: \(\) => ipcRenderer\.invoke\('wurster:settings:identities:unlock'\)/);

assert.match(launcher, /id="settings">⚙️ Settings/);
assert.match(launcher, /id="runtimeVersion">…<\/span>/);
assert.match(launcher, /launcher\.version\(\)/);
assert.doesNotMatch(launcher, /class="light green"/);
assert.doesNotMatch(launcher, />0\.32\.0<\/span>/);

assert.match(settings, /id="navGeneral"/);
assert.match(settings, /id="navIdentities"/);
assert.match(settings, /id="navAbout"/);
assert.match(settings, /id="unlockIdentities"/);
assert.match(settings, /General Wurster settings remain available without unlocking them/);
assert.match(settings, /Wurster <span id="aboutVersion"><\/span>/);

console.log('✓ Wurster Settings keep general preferences public, identities protected, versions live and the launcher fixed-size');
