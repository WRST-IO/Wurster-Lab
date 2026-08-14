import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildWurst } from '../packages/meatgrinder/src/index.js';
import { SIGNATURE_PATH, createPackageSignature, createPublisherKeyBundle, decodeWurst, descriptorsFromPackage, encodeWurst, verifyPackageSignature } from '../packages/format/src/index.js';
import { describePigLink, invokePigLinkAction, runPigLinkTests } from '../packages/headless/src/index.js';

const execFileAsync = promisify(execFile);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurst-piglink-'));
try {
  const project = path.join(tmp, 'two-ended-pig');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(project, 'vendor', 'eleventy', 'node_modules', '@11ty', 'eleventy'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'index.html'), '<!doctype html><title>Two Ends</title><h1>Visible end</h1>');
  await fs.writeFile(path.join(project, 'src', 'content.md'), '# Headless Pigsty\n\nBuilt through PigLink.');
  await fs.writeFile(path.join(project, 'vendor', 'eleventy', 'node_modules', '@11ty', 'eleventy', 'package.json'), '{"name":"@11ty/eleventy","version":"test"}');
  await fs.writeFile(path.join(project, 'src', 'pigsty-build.js'), `
Pigsty.define(async (ctx) => {
  const source = await ctx.readText('content.md');
  await ctx.writeText('dist/headless.html', source.replace(/^# (.*)$/m, '<h1>$1</h1>') + '<p>' + ctx.args.suffix + '</p>');
  return { ok: true, files: ctx.list('dist') };
});
`);
  await fs.writeFile(path.join(project, 'piglink.js'), `
PigLink.define({
  actions: {
    'math.add': ({ a, b }) => ({ sum: a + b }),
    'pig.echo': ({ message }) => {
      wurst.piglink.emit('pig.echoed', { message });
      return { echo: message, oink: true };
    },
    'pigsty.build': async ({ suffix }) => {
      const status = await wurst.pigsty.status();
      const built = await wurst.pigsty.build('site', { args: { suffix } });
      return {
        state: status.state,
        build: built.build.name,
        source: built.build.source,
        artifact: built.artifacts[0].path,
        sourceFiles: built.provenance.sourceDigest.files,
        outputFiles: built.provenance.outputDigest.files,
        writeCount: built.writes.length,
        digest: built.artifacts[0].sha256.slice(0, 12)
      };
    },
    'pigsty.status': async () => {
      const status = await wurst.pigsty.status();
      return {
        state: status.state,
        defaultEngine: status.defaultEngine,
        worker: status.engines.worker.available,
        edgeWasix: status.engines.edgeWasix.available,
        edgeConfigured: status.engines.edgeWasix.configured
      };
    },
    'pigsty.edgeBuild': async ({ suffix }) => {
      const built = await wurst.pigsty.build('site', { engine: 'edge-wasix', args: { suffix } });
      return { build: built.build.name };
    }
  }
});
`);
  await fs.writeFile(path.join(project, 'wurst.json'), JSON.stringify({
    id: 'io.wrst.two-ended-test',
    name: 'Two Ended Test Wurst',
    version: '0.20.1',
    source: 'src',
    entry: 'index.html',
    pigsty: {
      version: 'node-lts-1',
      tools: ['headless-test'],
      offline: true,
      toolchain: {
        root: 'pigsty-toolchain',
        source: 'vendor/eleventy'
      },
      builds: {
        site: {
          source: 'pigsty-build.js',
          description: 'Build the headless HTML artifact.',
          outputs: ['dist']
        }
      }
    },
    piglink: {
      source: 'piglink.js',
      headless: true,
      actions: {
        'math.add': {
          description: 'Add two numbers.',
          readOnly: true,
          input: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
          output: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] }
        },
        'pig.echo': {
          description: 'Echo an oink.',
          readOnly: true,
          input: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
          output: { type: 'object', properties: { echo: { type: 'string' }, oink: { type: 'boolean' } }, required: ['echo', 'oink'] }
        },
        'pigsty.build': {
          description: 'Build an artifact through headless PigLink and Pigsty.',
          input: { type: 'object', properties: { suffix: { type: 'string' } }, required: ['suffix'] },
          output: {
            type: 'object',
            properties: {
              state: { type: 'string' },
              build: { type: 'string' },
              source: { type: 'string' },
              artifact: { type: 'string' },
              sourceFiles: { type: 'integer' },
              outputFiles: { type: 'integer' },
              writeCount: { type: 'integer' },
              digest: { type: 'string' }
            },
            required: ['state', 'build', 'source', 'artifact', 'sourceFiles', 'outputFiles', 'writeCount', 'digest']
          }
        },
        'pigsty.status': {
          description: 'Read Pigsty runtime engine status.',
          readOnly: true,
          input: { type: 'object', properties: {} },
          output: {
            type: 'object',
            properties: {
              state: { type: 'string' },
              defaultEngine: { type: 'string' },
              worker: { type: 'boolean' },
              edgeWasix: { type: 'boolean' },
              edgeConfigured: { type: 'boolean' }
            },
            required: ['state', 'defaultEngine', 'worker', 'edgeWasix', 'edgeConfigured']
          }
        },
        'pigsty.edgeBuild': {
          description: 'Request an Edge/WASIX Pigsty build explicitly.',
          input: { type: 'object', properties: { suffix: { type: 'string' } }, required: ['suffix'] },
          output: { type: 'object', properties: { build: { type: 'string' } }, required: ['build'] }
        }
      },
      events: {
        'pig.echoed': { payload: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }
      },
      tests: [
        { name: 'forty-two', action: 'math.add', input: { a: 20, b: 22 }, expect: { sum: 42 } },
        { name: 'oink roundtrip', action: 'pig.echo', input: { message: 'oink' }, expect: { echo: 'oink', oink: true } },
        { name: 'headless pigsty build', action: 'pigsty.build', input: { suffix: 'from PigLink' } }
      ]
    }
  }, null, 2));

  const output = path.join(tmp, 'two-ended.wurst');
  await buildWurst(project, output);
  const pkg = decodeWurst(await fs.readFile(output));
  assert.equal(pkg.manifest.piglink.format, 'wurst/piglink-1');
  assert.equal(pkg.manifest.piglink.headless, true);
  assert.equal(pkg.get(pkg.manifest.piglink.entry).scope, 'piglink');
  assert.equal(pkg.manifest.piglink.source, undefined);
  assert.equal(pkg.manifest.pigsty.toolchain.root, 'pigsty-toolchain');
  assert.equal(pkg.manifest.pigsty.toolchain.source, undefined);
  assert.match(pkg.get('pigsty-toolchain/node_modules/@11ty/eleventy/package.json').data.toString('utf8'), /@11ty\/eleventy/);

  const sellerPhrase = 'smoked-bacon peppered-brisket cured-ham grilled-rib charred-steak mustard-pork hickory-wurst iron-chop maple-salami crispy-roast ember-belly garlic-jerky';
  const seller = createPublisherKeyBundle({ email: 'twoends@example.com', meatphrase: sellerPhrase });
  const signature = createPackageSignature(pkg, seller.bundle, sellerPhrase);
  const signedFiles = [
    ...descriptorsFromPackage(pkg).filter((file) => file.path !== SIGNATURE_PATH),
    { path: SIGNATURE_PATH, data: Buffer.from(JSON.stringify(signature)), scope: 'signature', mime: 'application/json; charset=utf-8' }
  ];
  const signedPkg = decodeWurst(encodeWurst({ manifest: pkg.manifest, files: signedFiles }));
  assert.equal(verifyPackageSignature(signedPkg).status, 'signed');
  const tamperedFiles = descriptorsFromPackage(signedPkg).map((file) => file.path === pkg.manifest.piglink.entry
    ? { ...file, data: Buffer.from('PigLink.define({actions:{}});') }
    : file);
  const tamperedPkg = decodeWurst(encodeWurst({ manifest: signedPkg.manifest, files: tamperedFiles }));
  assert.equal(verifyPackageSignature(tamperedPkg).status, 'invalid');

  const described = await describePigLink(output);
  assert.deepEqual(Object.keys(described.piglink.actions).sort(), ['math.add', 'pig.echo', 'pigsty.build', 'pigsty.edgeBuild', 'pigsty.status']);

  const added = await invokePigLinkAction(output, 'math.add', { a: 19, b: 23 });
  assert.deepEqual(added.result, { sum: 42 });

  const echoed = await invokePigLinkAction(output, 'pig.echo', { message: 'grunz' });
  assert.deepEqual(echoed.result, { echo: 'grunz', oink: true });
  assert.deepEqual(echoed.events.find((event) => event.name === 'pig.echoed')?.payload, { message: 'grunz' });

  const built = await invokePigLinkAction(output, 'pigsty.build', { suffix: 'from PigLink' });
  assert.equal(built.result.state, 'available');
  assert.equal(built.result.build, 'site');
  assert.equal(built.result.source, 'pigsty-build.js');
  assert.equal(built.result.artifact, 'dist/headless.html');
  assert.equal(built.result.sourceFiles, 4);
  assert.equal(built.result.outputFiles, 5);
  assert.equal(built.result.writeCount, 1);
  assert.match(built.result.digest, /^[0-9a-f]{12}$/);

  const pigstyStatus = await invokePigLinkAction(output, 'pigsty.status', {}, {
    env: { WURSTER_EDGE_BIN: '/definitely/not/edge' }
  });
  assert.equal(pigstyStatus.result.state, 'available');
  assert.equal(pigstyStatus.result.defaultEngine, 'worker');
  assert.equal(pigstyStatus.result.worker, true);
  assert.equal(pigstyStatus.result.edgeWasix, false);
  assert.equal(pigstyStatus.result.edgeConfigured, true);

  await assert.rejects(
    () => invokePigLinkAction(output, 'pigsty.edgeBuild', { suffix: 'edge requested' }, {
      env: { WURSTER_EDGE_BIN: '/definitely/not/edge' }
    }),
    /Pigsty Edge\/WASIX binary not found|spawn .*ENOENT/
  );

  const cli = await execFileAsync(process.execPath, [
    path.resolve('packages/headless/src/cli.js'),
    'invoke',
    output,
    'pigsty.build',
    '--input',
    JSON.stringify({ suffix: 'from CLI' }),
    '--json'
  ], { cwd: path.resolve('.') });
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.ok, true);
  assert.equal(cliResult.result.state, 'available');
  assert.equal(cliResult.result.build, 'site');
  assert.match(cliResult.result.digest, /^[0-9a-f]{12}$/);

  await assert.rejects(() => invokePigLinkAction(output, 'math.add', { a: 'ham', b: 2 }), /must be number/);
  await assert.rejects(() => invokePigLinkAction(output, 'secret.internal', {}), /Unknown Wurst action/);

  const tests = await runPigLinkTests(output);
  assert.equal(tests.passed, 3);
  assert.equal(tests.failed, 0);

  console.log('✓ PigLink exposes declared Actions + Events without DOM');
  console.log('✓ Headless developer harness invokes the same Wurst Actions and validates JSON contracts');
  console.log('✓ Embedded/UI and machine surfaces share one declared PigLink');
  console.log('✓ Publisher signatures cover immutable PigLink code');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
