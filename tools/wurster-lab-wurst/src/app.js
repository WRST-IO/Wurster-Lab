import { extractOperatorWorkspaceZip, operatorReplacementMap, validateOperatorMaterial, validateOperatorSettings, verifyOperatorMaterialCryptographically, writeZip } from './workspace-zip.js';
const $ = (q) => document.querySelector(q);
const $$ = (q) => [...document.querySelectorAll(q)];
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const OPERATOR_FILES = ['root.json', 'issuer.json', 'trust-bundle.json', 'issuer.wurstissuer'];
const OPERATOR_SETTINGS_PATH = '/operator/operator-settings.json';
let operatorUnlocked = false;
let currentRealms = [];

function humanBytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  const units = ['KiB','MiB','GiB','TiB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

async function stat(path) {
  try { return await window.wurst.pigfs.stat(path); } catch { return null; }
}

async function readBytes(path) {
  const info = await stat(path);
  if (!info || info.type !== 'file') throw new Error(`Workspace file disappeared while reading: ${path}`);
  const size = Number(info.size || 0);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid PigFS size for ${path}`);
  if (size === 0) return new Uint8Array(0);
  const chunkSize = 2 * 1024 * 1024;
  const chunks = [];
  let total = 0;
  for (let offset = 0; offset < size;) {
    const result = await window.wurst.pigfs.read(path, { offset, length: Math.min(chunkSize, size - offset) });
    const data = result?.data instanceof Uint8Array ? result.data : result?.data ? new Uint8Array(result.data) : null;
    if (!data || data.byteLength === 0) throw new Error(`PigFS returned no bytes for ${path} at offset ${offset}`);
    chunks.push(data);
    total += data.byteLength;
    offset += data.byteLength;
  }
  if (total !== size) throw new Error(`Short PigFS read for ${path}: expected ${size} bytes, got ${total}`);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { out.set(chunk, cursor); cursor += chunk.byteLength; }
  return out;
}

async function readText(path) {
  return decoder.decode(await readBytes(path));
}

function latestChangelog(text, version) {
  const source = String(text || '').trim();
  if (!source) return 'No changelog found in the workspace.';
  const lines = source.split(/\r?\n/);
  const versionIndex = version ? lines.findIndex((line) => line.match(new RegExp(`^##+\\s+(?:v)?${version.replaceAll('.', '\\.')}\\b`, 'i'))) : -1;
  const start = versionIndex >= 0 ? versionIndex : Math.max(0, lines.findIndex((line) => /^##\s+/.test(line)));
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim() || source.slice(0, 10000);
}

async function refreshRelease() {
  let release = {};
  try { release = JSON.parse(await readText('/lab/release.json')); } catch {}
  let pkg = {};
  try { pkg = JSON.parse(await readText('/workspace/package.json')); } catch {}
  const version = release.version || pkg.version || 'unknown';
  const revision = release.revision || 1;
  $('#workspaceVersion').textContent = `Wurster Lab ${version}`;
  $('#revisionLine').textContent = `workspace revision ${String(revision).padStart(3, '0')} · ${release.sourceFiles ?? '…'} source files`;
  $('#releasePill').textContent = `v${version} · r${String(revision).padStart(3, '0')}`;
  $('#workspaceFiles').textContent = release.sourceFiles ?? '…';
  $('#healthMeter').style.width = `${82 + (Number(revision) % 17)}%`;
  $('#healthText').textContent = `Meat integrity: ${release.tests || 'release workspace loaded'}.`;
  $('#changeTitle').textContent = `What changed in ${version}`;
  try {
    $('#changelog').textContent = latestChangelog(await readText('/workspace/CHANGELOG.md'), version);
  } catch (error) {
    $('#changelog').textContent = `Could not read CHANGELOG.md\n\n${error.message}`;
  }
}

async function refreshNotes() {
  try {
    const text = await readText('/lab/notes.md');
    $('#notes').value = text;
    $('#notesState').textContent = text.trim() ? 'inked' : 'empty';
    $('#noteSaveState').textContent = 'loaded';
  } catch {
    $('#notes').value = '';
    $('#notesState').textContent = 'empty';
  }
}

function operatorRealm() { return currentRealms.find((realm) => realm.id === 'operator'); }

async function refreshRealms() {
  currentRealms = await window.wurst.pigfs.realms();
  const op = operatorRealm();
  if (!op) {
    operatorUnlocked = false;
    $('#operatorState').textContent = 'missing';
    $('#operatorGate').classList.remove('hidden');
    $('#operatorAdmin').classList.add('hidden');
    $('#operatorGateTitle').textContent = 'Operator realm missing';
    $('#operatorGateCopy').textContent = 'This Wurster Lab does not contain its personal operator compartment.';
    return;
  }

  const unclaimed = op.claimed === false;
  operatorUnlocked = !unclaimed && !op.locked;
  $('#operatorState').textContent = unclaimed ? 'unclaimed' : op.locked ? 'sealed' : 'open';
  $('#operatorGate').classList.toggle('hidden', operatorUnlocked);
  $('#operatorAdmin').classList.toggle('hidden', !operatorUnlocked);

  if (unclaimed) {
    $('#operatorGateTitle').textContent = 'Claim Operator Admin Zone';
    $('#operatorGateCopy').textContent = 'Authenticate the Wurster Identity that should permanently own this personal compartment. The first successful unlock claims it.';
    $('#operatorGateState').textContent = 'Unclaimed personal realm · first authenticated Identity becomes the only owner.';
  } else if (op.locked) {
    $('#operatorGateTitle').textContent = 'Unlock Operator Admin Zone';
    $('#operatorGateCopy').textContent = 'Authenticate the owning Wurster Identity. Wurster unwraps this realm locally before any operator controls are shown.';
    $('#operatorGateState').textContent = 'Sealed personal realm · operator contents remain opaque.';
  }

  if (operatorUnlocked) {
    $('#materialBadge').textContent = 'OPEN';
    $('#operatorFingerprint').textContent = op.capabilities?.admin
      ? 'Owner authenticated for this session.'
      : 'Personal operator realm open for the authenticated owner.';
    await Promise.all([refreshOperatorFiles(), refreshOperatorSettings()]);
  }
}

async function refreshOperatorFiles() {
  if (!operatorUnlocked) return;
  let present = 0;
  for (const name of OPERATOR_FILES) {
    const s = await stat(`/operator/${name}`);
    const el = $(`[data-state="${name}"]`);
    if (s?.type === 'file') { present += 1; el.textContent = `${humanBytes(s.size)} · stored`; el.classList.add('good'); }
    else { el.textContent = 'missing'; el.classList.remove('good'); }
  }
  if (present === 4) {
    try {
      const [rootText, issuerText, trustBundleText, issuerPrivateText] = await Promise.all(OPERATOR_FILES.map((name) => readText(`/operator/${name}`)));
      const material = validateOperatorMaterial({ rootText, issuerText, trustBundleText, issuerPrivateText });
      await verifyOperatorMaterialCryptographically(material);
      const verified = { rootFingerprint: material.root.fingerprint, issuerFingerprint: material.issuer.statement.issuer.fingerprint, issuerName: material.issuer.statement.issuer.name ?? material.issuer.statement.issuer.issuerId ?? 'WRST.IO issuer' };
      $('#materialResult').textContent = `✓ Production kit verified. Root ${verified.rootFingerprint.slice(0, 12)}… · Issuer ${verified.issuerFingerprint.slice(0, 12)}…`;
      $('#materialResult').className = 'material-result good';
      $('#operatorFingerprint').textContent = `WRST.IO Root ${verified.rootFingerprint}
${verified.issuerName} ${verified.issuerFingerprint}`;
      return;
    } catch (error) {
      $('#materialResult').textContent = `⚠ Four files are present, but the operator kit is not valid: ${error.message}`;
      $('#materialResult').className = 'material-result bad';
      return;
    }
  }
  $('#materialResult').textContent = `${present}/4 operator files present.`;
  $('#materialResult').className = 'material-result';
}


async function readOperatorSettings({ required = false } = {}) {
  const info = await stat(OPERATOR_SETTINGS_PATH);
  if (!info) {
    if (required) throw new Error('Store the Mail Relay settings before exporting the production workspace.');
    return null;
  }
  const parsed = JSON.parse(await readText(OPERATOR_SETTINGS_PATH));
  return validateOperatorSettings(parsed, { requireComplete: true });
}

async function refreshOperatorSettings() {
  if (!operatorUnlocked) return;
  try {
    const settings = await readOperatorSettings();
    $('#relayUrl').value = settings?.mailRelayUrl || '';
    $('#relaySecret').value = settings?.mailRelaySecret || '';
    $('#relaySettingsState').textContent = settings ? '✓ sealed in /operator' : 'not stored yet';
    $('#relaySettingsState').className = settings ? 'material-result good' : 'material-result';
  } catch (error) {
    $('#relaySettingsState').textContent = `⚠ ${error.message}`;
    $('#relaySettingsState').className = 'material-result bad';
  }
}

async function currentOperatorSettingsFromForm() {
  return validateOperatorSettings({
    mailRelayUrl: $('#relayUrl').value,
    mailRelaySecret: $('#relaySecret').value
  }, { requireComplete: true });
}

async function operatorMaterial() {
  const [rootText, issuerText, trustBundleText, issuerPrivateText] = await Promise.all(OPERATOR_FILES.map((name) => readText(`/operator/${name}`)));
  const material = validateOperatorMaterial({ rootText, issuerText, trustBundleText, issuerPrivateText });
  await verifyOperatorMaterialCryptographically(material);
  return material;
}

async function collectWorkspaceZipEntries() {
  const out = new Map();
  async function walk(fsPath, relBase = '') {
    for (const entry of await window.wurst.pigfs.list(fsPath)) {
      const name = entry.name || entry.path.split('/').at(-1);
      const rel = relBase ? `${relBase}/${name}` : name;
      if (entry.type === 'directory') await walk(entry.path, rel);
      else if (entry.type === 'file') {
        const value = await readBytes(entry.path);
        out.set(`wurster_lab/${rel}`, value);
      }
    }
  }
  await walk('/workspace');
  return out;
}

async function exportProductionWorkspace() {
  if (!operatorUnlocked) throw new Error('Unlock the personal operator realm first.');
  const material = await operatorMaterial();
  const settings = await readOperatorSettings({ required: true });
  const files = await collectWorkspaceZipEntries();
  for (const [name, value] of operatorReplacementMap(material, settings)) files.set(name, value);
  const release = JSON.parse(await readText('/lab/release.json'));
  const bytes = writeZip([], files);
  const suggestedName = `wurster_lab_v${release.version || 'operator'}_r${String(release.revision || 1).padStart(3, '0')}_WRST-OPERATOR.zip`;
  const saved = await window.wurst.files.save({
    title: 'Export WRST.IO production Wurster Lab',
    suggestedName,
    label: 'Private Wurster Lab ZIP',
    extensions: ['zip']
  }, bytes);
  return { saved, bytes: bytes.length, name: suggestedName };
}

async function initialize() {
  try { await window.wurst.pigfs.initialize(); } catch (error) {
    if (!/already|initialized/i.test(error.message)) throw error;
  }
  await refreshRealms();
  await Promise.all([refreshRelease(), refreshNotes()]);
  $('#footerState').textContent = 'PigFS · ordinary + personal realms';
}

window.wurst.auth.onResult(async (result) => {
  if (result.purpose !== 'filesystem') return;
  if (!result.ok) {
    $('#operatorGateState').textContent = result.error || 'Identity authentication failed.';
    $('#operatorGateState').className = 'operator-gate-state bad';
    return;
  }
  try {
    const unlocked = await window.wurst.pigfs.unlockRealm('operator');
    operatorUnlocked = Boolean(unlocked?.unlocked);
    await refreshRealms();
    $('#materialResult').textContent = unlocked?.claimed ? '🐷 Personal operator realm claimed for this identity.' : '🐷 Operator realm unlocked.';
    $('#materialResult').className = 'material-result good';
  } catch (error) {
    $('#operatorGateState').textContent = error.message;
    $('#operatorGateState').className = 'operator-gate-state bad';
  }
});

$('#lockOperator').addEventListener('click', async () => {
  try {
    await window.wurst.pigfs.lockRealm('operator');
    operatorUnlocked = false;
    await refreshRealms();
  } catch (error) {
    $('#materialResult').textContent = error.message;
    $('#materialResult').className = 'material-result bad';
  }
});

for (const button of $$('[data-import]')) {
  button.addEventListener('click', async () => {
    const name = button.dataset.import;
    try {
      if (!operatorUnlocked) throw new Error('Unlock the personal operator realm first.');
      const extension = name.endsWith('.json') ? 'json' : 'wurstissuer';
      const chosen = await window.wurst.files.open({ title: `Import ${name}`, label: name, extensions: [extension], maxBytes: 2 * 1024 * 1024 });
      if (!chosen.opened) return;
      if (name.endsWith('.json')) JSON.parse(decoder.decode(chosen.data));
      await window.wurst.pigfs.write(`/operator/${name}`, chosen.data, { mime: name.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
      $('#materialResult').textContent = `✓ ${name} sealed into the personal operator realm.`;
      $('#materialResult').className = 'material-result good';
      await refreshOperatorFiles();
    } catch (error) {
      $('#materialResult').textContent = error.message;
      $('#materialResult').className = 'material-result bad';
    }
  });
}

$('#importOperatorWorkspace').addEventListener('click', async () => {
  try {
    if (!operatorUnlocked) throw new Error('Unlock the personal operator realm first.');
    const chosen = await window.wurst.files.open({ title: 'Import previous WRST.IO operator workspace', label: 'Private Wurster Lab ZIP', extensions: ['zip'], maxBytes: 128 * 1024 * 1024 });
    if (!chosen.opened) return;
    const extracted = extractOperatorWorkspaceZip(chosen.data);
    const material = validateOperatorMaterial(extracted);
    await verifyOperatorMaterialCryptographically(material);
    const values = [extracted.rootText, extracted.issuerText, extracted.trustBundleText, extracted.issuerPrivateText];
    for (let i = 0; i < OPERATOR_FILES.length; i += 1) {
      const name = OPERATOR_FILES[i];
      await window.wurst.pigfs.write(`/operator/${name}`, encoder.encode(values[i]), { mime: name.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    }
    if (extracted.settings) {
      await window.wurst.pigfs.write(OPERATOR_SETTINGS_PATH, JSON.stringify(extracted.settings, null, 2) + '\n', { mime: 'application/json' });
    }
    $('#materialResult').textContent = extracted.settings
      ? '✓ Previous operator workspace imported, including sealed Mail Relay settings.'
      : '✓ Previous operator workspace imported. Store Mail Relay settings below once.';
    $('#materialResult').className = 'material-result good';
    await Promise.all([refreshOperatorFiles(), refreshOperatorSettings()]);
  } catch (error) {
    $('#materialResult').textContent = error.message;
    $('#materialResult').className = 'material-result bad';
  }
});

$('#saveOperatorSettings').addEventListener('click', async () => {
  try {
    if (!operatorUnlocked) throw new Error('Unlock the personal operator realm first.');
    const settings = await currentOperatorSettingsFromForm();
    await window.wurst.pigfs.write(OPERATOR_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', { mime: 'application/json' });
    $('#relaySettingsState').textContent = '✓ Mail Relay URL + secret sealed in your personal operator realm.';
    $('#relaySettingsState').className = 'material-result good';
  } catch (error) {
    $('#relaySettingsState').textContent = error.message;
    $('#relaySettingsState').className = 'material-result bad';
  }
});

$('#toggleRelaySecret').addEventListener('click', () => {
  const field = $('#relaySecret');
  const hidden = field.type === 'password';
  field.type = hidden ? 'text' : 'password';
  $('#toggleRelaySecret').textContent = hidden ? 'Hide' : 'Show';
});

$('#saveNotes').addEventListener('click', async () => {
  try {
    $('#noteSaveState').textContent = 'saving…';
    await window.wurst.pigfs.write('/lab/notes.md', $('#notes').value, { mime: 'text/markdown' });
    $('#noteSaveState').textContent = 'saved · current data';
    $('#notesState').textContent = $('#notes').value.trim() ? 'inked' : 'empty';
  } catch (error) { $('#noteSaveState').textContent = error.message; }
});
$('#reloadNotes').addEventListener('click', refreshNotes);
$('#reloadChange').addEventListener('click', refreshRelease);


$('#exportOperatorWorkspace').addEventListener('click', async () => {
  try {
    $('#exportResult').textContent = 'Grinding public workspace + private operator overlay…';
    const result = await exportProductionWorkspace();
    $('#exportResult').textContent = result.saved?.saved === false
      ? 'Export cancelled.'
      : `✓ Private production workspace exported (${humanBytes(result.bytes)}). Do not publish this ZIP.`;
    $('#exportResult').className = 'material-result good';
  } catch (error) {
    $('#exportResult').textContent = error.message;
    $('#exportResult').className = 'material-result bad';
  }
});

$('#compactLab').addEventListener('click', async () => {
  try {
    $('#compactResult').textContent = 'Putting specimen on a very small treadmill…';
    const result = await window.wurst.pigfs.compact();
    $('#compactResult').textContent = result?.compacted
      ? `✓ Trimmed ${humanBytes(result.reclaimedBytes || 0)}. The Wurst is feeling aerodynamic.`
      : `Nothing trimmed: ${result?.reason || 'already lean'}.`;
  } catch (error) {
    $('#compactResult').textContent = `${error.message} Unlock the operator realm first if it is already claimed.`;
  }
});

const FUN = [
  ['🧪🐷','Specimen appears unusually cooperative.','No sausages were harmed during this filesystem mount.'],
  ['🔬🐽','Microscope confirms traces of JavaScript.','The sample remains legally classified as software.'],
  ['🥼🐖','Lab coat successfully fitted to pig.','Peer review has been postponed due to snack requirements.'],
  ['🧬🌭','Genome sequence: WRST WRST OINK.','Mutation rate remains within acceptable pork tolerances.'],
  ['⚗️🐷','Pinkness increased by 12%.','Further exposure to CSS gradients is recommended.'],
  ['📦🐖','Container integrity looks delicious.','Do not actually eat the binary format.']
];
let funIndex = 0;
$('#pokePig').addEventListener('click', () => {
  funIndex = (funIndex + 1) % FUN.length;
  const [emoji,title,text] = FUN[funIndex];
  $('#funEmoji').textContent = emoji; $('#funTitle').textContent = title; $('#funText').textContent = text;
  $('#pigOrb').classList.add('bump'); setTimeout(() => $('#pigOrb').classList.remove('bump'), 230);
});

for (const tab of $$('.tab')) tab.addEventListener('click', async () => {
  $$('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab));
  if (tab.dataset.tab === 'operator') {
    try { await refreshRealms(); }
    catch (error) {
      $('#operatorGateState').textContent = error.message;
      $('#operatorGateState').className = 'operator-gate-state bad';
    }
  }
});

initialize().catch((error) => {
  $('#footerState').textContent = `Lab error: ${error.message}`;
  $('#healthText').textContent = error.message;
  $('#healthMeter').style.width = '17%';
});
