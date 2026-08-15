import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');
const dist = path.join(here, 'dist');

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });

let build;
try {
  ({ build } = await import('esbuild'));
} catch {
  throw new Error('Wurster Web build requires the workspace esbuild toolchain; run npm install at the repository root first');
}

async function buildCore(outfile, minify) {
  await build({
    entryPoints: [path.join(src, 'wurster-web.mjs')],
    outfile: path.join(dist, outfile),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify,
    legalComments: 'none',
    logLevel: 'silent'
  });
  console.log(`✓ runtime/web/dist/${outfile}`);
}

await buildCore('wurster.js', false);
await buildCore('wurster.min.js', true);

const outputs = [
  ['wurster-sw.js', 'wurster-sw.js'],
  ['wurster-frame-bootstrap.js', 'wurster-frame-bootstrap.js'],
  ['wurster-embed.mjs', 'wurster-embed.mjs'],
  ['wurster-embed.mjs', 'wurster-embed.js'],
  ['wurster-embed-host.html', 'wurster-embed-host.html'],
  ['trust-data.mjs', 'trust-data.mjs']
];
for (const [from, to] of outputs) {
  await fs.copyFile(path.join(src, from), path.join(dist, to));
  console.log(`✓ runtime/web/dist/${to}`);
}
