import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWurst } from '../packages/meatgrinder/src/index.js';
import { SIGNATURE_PATH, createPackageSignature, createPublisherKeyBundle, decodeWurst, descriptorsFromPackage, encodeWurst, verifyPackageSignature } from '../packages/format/src/index.js';
import { describeWurstInterface, invokeWurstAction, runWurstInterfaceTests } from '../packages/headless/src/index.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurst-interface-'));
try {
  const project = path.join(tmp, 'two-ended-pig');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'index.html'), '<!doctype html><title>Two Ends</title><h1>Visible end</h1>');
  await fs.writeFile(path.join(project, 'wurst-interface.js'), `
WurstInterface.define({
  actions: {
    'math.add': ({ a, b }) => ({ sum: a + b }),
    'pig.echo': ({ message }) => {
      wurst.interface.emit('pig.echoed', { message });
      return { echo: message, oink: true };
    }
  }
});
`);
  await fs.writeFile(path.join(project, 'wurst.json'), JSON.stringify({
    id: 'io.wrst.two-ended-test',
    name: 'Two Ended Test Wurst',
    version: '0.20.0',
    source: 'src',
    entry: 'index.html',
    interface: {
      source: 'wurst-interface.js',
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
        }
      },
      events: {
        'pig.echoed': { payload: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }
      },
      tests: [
        { name: 'forty-two', action: 'math.add', input: { a: 20, b: 22 }, expect: { sum: 42 } },
        { name: 'oink roundtrip', action: 'pig.echo', input: { message: 'oink' }, expect: { echo: 'oink', oink: true } }
      ]
    }
  }, null, 2));

  const output = path.join(tmp, 'two-ended.wurst');
  await buildWurst(project, output);
  const pkg = decodeWurst(await fs.readFile(output));
  assert.equal(pkg.manifest.interface.format, 'wurst/interface-1');
  assert.equal(pkg.manifest.interface.headless, true);
  assert.equal(pkg.get(pkg.manifest.interface.entry).scope, 'interface');
  assert.equal(pkg.manifest.interface.source, undefined);

  const sellerPhrase = 'smoked-bacon peppered-brisket cured-ham grilled-rib charred-steak mustard-pork hickory-wurst iron-chop maple-salami crispy-roast ember-belly garlic-jerky';
  const seller = createPublisherKeyBundle({ email: 'twoends@example.com', meatphrase: sellerPhrase });
  const signature = createPackageSignature(pkg, seller.bundle, sellerPhrase);
  const signedFiles = [
    ...descriptorsFromPackage(pkg).filter((file) => file.path !== SIGNATURE_PATH),
    { path: SIGNATURE_PATH, data: Buffer.from(JSON.stringify(signature)), scope: 'signature', mime: 'application/json; charset=utf-8' }
  ];
  const signedPkg = decodeWurst(encodeWurst({ manifest: pkg.manifest, files: signedFiles }));
  assert.equal(verifyPackageSignature(signedPkg).status, 'signed');
  const tamperedFiles = descriptorsFromPackage(signedPkg).map((file) => file.path === pkg.manifest.interface.entry
    ? { ...file, data: Buffer.from('WurstInterface.define({actions:{}});') }
    : file);
  const tamperedPkg = decodeWurst(encodeWurst({ manifest: signedPkg.manifest, files: tamperedFiles }));
  assert.equal(verifyPackageSignature(tamperedPkg).status, 'invalid');

  const described = await describeWurstInterface(output);
  assert.deepEqual(Object.keys(described.interface.actions).sort(), ['math.add', 'pig.echo']);

  const added = await invokeWurstAction(output, 'math.add', { a: 19, b: 23 });
  assert.deepEqual(added.result, { sum: 42 });

  const echoed = await invokeWurstAction(output, 'pig.echo', { message: 'grunz' });
  assert.deepEqual(echoed.result, { echo: 'grunz', oink: true });
  assert.deepEqual(echoed.events.find((event) => event.name === 'pig.echoed')?.payload, { message: 'grunz' });

  await assert.rejects(() => invokeWurstAction(output, 'math.add', { a: 'ham', b: 2 }), /must be number/);
  await assert.rejects(() => invokeWurstAction(output, 'secret.internal', {}), /Unknown Wurst action/);

  const tests = await runWurstInterfaceTests(output);
  assert.equal(tests.passed, 2);
  assert.equal(tests.failed, 0);

  console.log('✓ Wurst Interface exposes declared Actions + Events without DOM');
  console.log('✓ Headless developer harness invokes the same Wurst Actions and validates JSON contracts');
  console.log('✓ Embedded/UI and machine surfaces share one declared Wurst Interface');
  console.log('✓ Publisher signatures cover immutable Wurst Interface code');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
