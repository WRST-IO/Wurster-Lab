import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');
const dist = path.join(here, 'dist');
await fs.mkdir(dist, { recursive: true });

// The browser distribution stays dependency-free. The stable filenames are
// deliberately CDN-friendly and may be hosted together under any URL prefix.
const outputs = [
  ['wurster-web.mjs', 'wurster.min.js'],
  ['wurster-sw.js', 'wurster-sw.js'],
  ['wurster-embed.mjs', 'wurster-embed.js'],
  ['wurster-embed-host.html', 'wurster-embed-host.html'],
  ['trust-data.mjs', 'trust-data.mjs']
];
for (const [from, to] of outputs) {
  await fs.copyFile(path.join(src, from), path.join(dist, to));
  console.log(`✓ runtime/web/dist/${to}`);
}
