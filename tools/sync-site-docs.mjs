import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const docsDir = path.join(root, 'docs');
const outDir = path.join(root, 'site', 'src', 'docs');

await fs.mkdir(outDir, { recursive: true });
for (const entry of await fs.readdir(outDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.md')) await fs.rm(path.join(outDir, entry.name));
}

const files = (await fs.readdir(docsDir)).filter((name) => name.endsWith('.md')).sort();
for (const name of files) {
  let markdown = await fs.readFile(path.join(docsDir, name), 'utf8');
  // Root docs remain pleasant to read in GitHub/editors. Site copies get
  // Eleventy's stable pretty URLs instead of links to source .md files.
  markdown = markdown.replace(/\]\((?!https?:|mailto:|#)(?:\.\/)?([A-Za-z0-9._-]+)\.md(#[^)]+)?\)/g,
    (_whole, file, hash = '') => `](/docs/${file === 'index' ? '' : `${file}/`}${hash || ''})`);
  await fs.writeFile(path.join(outDir, name), markdown);
}

await fs.writeFile(path.join(outDir, 'docs.json'), `${JSON.stringify({
  layout: 'layouts/docs.njk',
  tags: ['doc'],
  permalink: '/docs/{{ page.fileSlug }}/'
}, null, 2)}\n`);

console.log(`🐷 Synced ${files.length} canonical docs into site/src/docs`);

const webDist = path.join(root, 'runtime', 'web', 'dist');
const webSiteOut = path.join(root, 'site', 'src', 'assets', 'wurster');
await fs.rm(webSiteOut, { recursive: true, force: true });
await fs.mkdir(webSiteOut, { recursive: true });
for (const entry of await fs.readdir(webDist, { withFileTypes: true })) {
  if (entry.isFile()) await fs.copyFile(path.join(webDist, entry.name), path.join(webSiteOut, entry.name));
}
console.log('🌐 Synced Wurster Web distribution into site/src/assets/wurster');
