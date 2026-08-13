#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWurst, createPublisher } from '../packages/meatgrinder/src/index.js';
import {
  mimeFor,
  openLocalWurstFsStore,
  openWurstFile,
  writeCompactedWurstFile,
  wurstFsRealmGovernance
} from '../packages/format/src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP_DIR = path.join(ROOT, 'tools', 'wurster-lab-wurst');
const EXPORT_DIR = '/mnt/data';

async function getVersion() {
  return String(JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version);
}

function skipWorkspacePath(rel) {
  const parts = rel.split('/');
  if (parts.some((part) => ['node_modules', '.git', '.pytest_cache', '__pycache__'].includes(part))) return true;
  if (parts.slice(0, 3).join('/') === 'authority/wrst.io/private') return true;
  const name = parts.at(-1) || '';
  if (name === '.DS_Store' || name.startsWith('.dev.vars') || name.endsWith('.bak')) return true;
  const distIndex = parts.indexOf('dist');
  if (distIndex >= 0 && parts.slice(0, 3).join('/') !== 'runtime/web/dist') return true;
  if (/\.(?:wurst|wrst|zip)$/i.test(name)) return true;
  return false;
}

async function collectWorkspaceFiles() {
  const files = new Map();
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(ROOT, absolute).split(path.sep).join('/');
      if (skipWorkspacePath(rel)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.set(rel, await fs.readFile(absolute));
    }
  }
  await walk(ROOT);
  return files;
}

async function writeBuffer(store, target, data, mime = null) {
  const tx = store.beginWrite(target, { mime: mime || mimeFor(target) });
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const chunkSize = 4 * 1024 * 1024;
  if (!bytes.length) await store.writeChunk(tx, Buffer.alloc(0));
  else for (let offset = 0; offset < bytes.length; offset += chunkSize) await store.writeChunk(tx, bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  return store.commitWrite(tx);
}

async function sameFile(store, target, bytes) {
  try {
    const stat = await store.stat(target);
    if (!stat || stat.type !== 'file' || Number(stat.size) !== bytes.length) return false;
    const existing = await store.read(target);
    return Buffer.from(existing.data).equals(bytes);
  } catch { return false; }
}

async function syncWorkspace(store, files) {
  const existing = await store.currentCatalog('workspace');
  const wanted = new Set(files.keys());
  let removed = 0;
  const extraFiles = [...existing.values()].filter((entry) => entry.type === 'file' && !wanted.has(entry.path)).sort((a, b) => b.path.length - a.path.length);
  for (const entry of extraFiles) {
    await store.remove(`/data/workspace/${entry.path}`);
    removed += 1;
  }

  let changed = 0;
  let unchanged = 0;
  for (const [rel, bytes] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const target = `/data/workspace/${rel}`;
    if (await sameFile(store, target, bytes)) { unchanged += 1; continue; }
    await writeBuffer(store, target, bytes, mimeFor(rel));
    changed += 1;
  }
  return { changed, unchanged, removed };
}

function nextName(version, existingName = null) {
  const match = existingName && path.basename(existingName).match(/^WursterLab_v([^_]+)_r(\d{3})\.wurst$/i);
  const revision = match && match[1] === version ? Number(match[2]) + 1 : 1;
  return { revision, name: `WursterLab_v${version}_r${String(revision).padStart(3, '0')}.wurst` };
}

async function writeReleaseMeta(store, version, revision, sourceFiles, sync = null) {
  const payload = {
    format: 'wurster/lab-release-1',
    version,
    revision,
    builtAt: new Date().toISOString(),
    sourceFiles,
    tests: 'workspace packaged; run the repository test suite after extraction for platform verification',
    sync
  };
  await writeBuffer(store, '/data/lab/release.json', Buffer.from(`${JSON.stringify(payload, null, 2)}\n`), 'application/json');
  const notes = await store.stat('/data/lab/notes.md');
  if (!notes) await writeBuffer(store, '/data/lab/notes.md', Buffer.from('## Wurster Lab notes\n\n- Oink responsibly.\n'), 'text/markdown');
}

async function freshBuild(output = null) {
  const version = await getVersion();
  const suggested = nextName(version);
  const finalPath = path.resolve(output || path.join(EXPORT_DIR, suggested.name));
  const explicitMatch = output && path.basename(finalPath).match(/^WursterLab_v([^_]+)_r(\d{3})\.wurst$/i);
  const revision = explicitMatch && explicitMatch[1] === version ? Number(explicitMatch[2]) : suggested.revision;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-lab-wurst-'));
  try {
    const unsignedDataPath = path.join(tempDir, 'base.wurst');
    const keyPath = path.join(tempDir, 'lab-ephemeral.wurstkey');
    const created = await createPublisher({ label: `Wurster Lab ${version} ephemeral application signer`, output: keyPath });
    const built = await buildWurst(APP_DIR, unsignedDataPath, { signKey: keyPath, publisherMeatphrase: created.meatphrase });
    if (built.signature.status !== 'signed') throw new Error('WursterLab.wurst must be signed because it uses user-selected host-file import');

    let reader = await openWurstFile(unsignedDataPath);
    let store = await openLocalWurstFsStore(unsignedDataPath, reader);
    await store.initialize({
      realms: [
        { id: 'workspace', label: 'Wurster Workspace' },
        { id: 'lab', label: 'Lab Notes' },
        { id: 'operator', label: 'WRST.IO Operator', governance: 'personal' }
      ]
    });
    const files = await collectWorkspaceFiles();
    const sync = await syncWorkspace(store, files);
    await writeReleaseMeta(store, version, revision, files.size, sync);
    await store.closeFile();
    await reader.close();

    // Fresh Lab has an unclaimed/empty personal realm, so it can be compacted
    // without knowing any user secret. This removes the temporary append tail
    // created while hundreds of source files were inserted.
    reader = await openWurstFile(unsignedDataPath);
    await fs.rm(finalPath, { force: true });
    await writeCompactedWurstFile(finalPath, reader);
    await reader.close();
    console.log(`✓ Wurster Lab Wurst: ${finalPath}`);
    console.log(`  workspace files: ${files.size}`);
    console.log('  operator realm: personal / sealed / unclaimed');
    console.log(`  ephemeral app signer: ${created.fingerprint}`);
    return finalPath;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function updateExisting(input, output = null) {
  const version = await getVersion();
  const sourcePath = path.resolve(input);
  const suggested = nextName(version, sourcePath);
  const finalPath = path.resolve(output || path.join(EXPORT_DIR, suggested.name));
  const explicitMatch = output && path.basename(finalPath).match(/^WursterLab_v([^_]+)_r(\d{3})\.wurst$/i);
  const revision = explicitMatch && explicitMatch[1] === version ? Number(explicitMatch[2]) : suggested.revision;
  if (sourcePath === finalPath) throw new Error('Wurster Lab updates must use a new filename');
  await fs.copyFile(sourcePath, finalPath);
  let reader;
  let store;
  try {
    reader = await openWurstFile(finalPath);
    if (reader.manifest?.id !== 'io.wrst.wurster-lab') throw new Error('Input is not WursterLab.wurst');
    if (reader.wurstFsRoot?.format !== 'wurst/fs-2') throw new Error('WursterLab.wurst has no WurstFS v2 workspace');
    store = await openLocalWurstFsStore(finalPath, reader);
    const workspace = store.realm('workspace');
    const operator = store.realm('operator');
    if (!workspace || wurstFsRealmGovernance(workspace) !== 'ordinary') throw new Error('Wurster Lab workspace realm is not ordinary mutable storage');
    if (!operator || wurstFsRealmGovernance(operator) !== 'personal') throw new Error('Wurster Lab operator realm is not personal storage');
    const files = await collectWorkspaceFiles();
    const sync = await syncWorkspace(store, files);
    await writeReleaseMeta(store, version, revision, files.size, sync);
    await store.closeFile();
    store = null;
    await reader.close();
    reader = null;
    console.log(`✓ Updated Wurster Lab Wurst: ${finalPath}`);
    console.log(`  workspace: ${sync.changed} changed, ${sync.removed} removed, ${sync.unchanged} unchanged`);
    console.log(`  operator realm: preserved ${operator.claimed ? 'claimed/sealed' : 'unclaimed'}`);
    console.log('  note: claimed operator realms remain opaque; no operator key was requested');
    return finalPath;
  } catch (error) {
    if (store?.closeFile) await store.closeFile().catch(() => {});
    if (reader) await reader.close().catch(() => {});
    await fs.rm(finalPath, { force: true });
    throw error;
  }
}

const [command = 'build', input, explicitOutput] = process.argv.slice(2);
if (command === 'build') await freshBuild(input || null);
else if (command === 'update') {
  if (!input) throw new Error('Usage: node tools/wurster-lab-wurst.mjs update <WursterLab_...wurst> [output]');
  await updateExisting(input, explicitOutput || null);
} else throw new Error('Usage: node tools/wurster-lab-wurst.mjs [build [output] | update <input> [output]]');
