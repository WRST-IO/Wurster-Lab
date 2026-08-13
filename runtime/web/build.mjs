import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');
const dist = path.join(here, 'dist');

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });

const coreSource = await fs.readFile(path.join(src, 'wurster-web.mjs'), 'utf8');
await fs.writeFile(path.join(dist, 'wurster.js'), coreSource);
console.log('✓ runtime/web/dist/wurster.js');

let transform;
try {
  ({ transform } = await import('esbuild'));
} catch {
  throw new Error('Wurster Web minification requires the workspace esbuild toolchain; run npm install at the repository root first');
}
const minified = await transform(coreSource, {
  loader: 'js',
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none'
});
await fs.writeFile(path.join(dist, 'wurster.min.js'), minified.code);
console.log('✓ runtime/web/dist/wurster.min.js');

const outputs = [
  ['wurster-sw.js', 'wurster-sw.js'],
  ['wurster-embed.mjs', 'wurster-embed.js'],
  ['wurster-embed-host.html', 'wurster-embed-host.html'],
  ['trust-data.mjs', 'trust-data.mjs']
];
for (const [from, to] of outputs) {
  await fs.copyFile(path.join(src, from), path.join(dist, to));
  console.log(`✓ runtime/web/dist/${to}`);
}
