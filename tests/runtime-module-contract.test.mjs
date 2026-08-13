import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PUBLIC_MODULES = new Map([
  ['@wurster/format', path.join(ROOT, 'packages/format/src/index.js')],
  ['@wurster/interface', path.join(ROOT, 'packages/interface/src/index.js')],
  ['@wurster/session', path.join(ROOT, 'packages/session/src/index.js')]
]);

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(absolute));
    else if (entry.isFile() && /\.(?:m?js)$/.test(entry.name)) out.push(absolute);
  }
  return out;
}

const namespaces = new Map();
for (const [specifier, file] of PUBLIC_MODULES) {
  namespaces.set(specifier, await import(pathToFileURL(file).href));
}

const roots = [
  path.join(ROOT, 'runtime/desktop/src'),
  path.join(ROOT, 'packages')
];

let checked = 0;
for (const root of roots) {
  for (const file of await walk(root)) {
    const text = await fs.readFile(file, 'utf8');
    for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const namespace = namespaces.get(match[2]);
      if (!namespace) continue;
      for (const raw of match[1].split(',')) {
        const token = raw.trim();
        if (!token) continue;
        const imported = token.split(/\s+as\s+/)[0].trim();
        assert.ok(imported in namespace, `${path.relative(ROOT, file)} imports missing ${match[2]} export: ${imported}`);
        checked += 1;
      }
    }
  }
}

assert.ok(checked > 0, 'runtime module contract test did not inspect any named imports');
console.log(`✓ runtime module contract: ${checked} named workspace imports resolve`);
