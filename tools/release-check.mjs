#!/usr/bin/env node
import fs from 'node:fs/promises';

const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = String(process.argv[2] || process.env.GITHUB_REF_NAME || '').trim();
const expected = `v${pkg.version}`;
if (!tag) throw new Error(`Release tag required. Expected ${expected}`);
if (tag !== expected) throw new Error(`Release tag ${tag} does not match package version ${pkg.version}. Expected ${expected}`);
console.log(`✓ release tag ${tag} matches Wurster ${pkg.version}`);
