import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { SIGNATURE_PATH, createPackageSignature, createPublisherKeyBundle, decodeWurst, descriptorsFromPackage, encodeWurst, sha256, verifyPackageSignature } from '../packages/format/src/index.js';
import { buildWurst } from '../packages/meatgrinder/src/index.js';
import { applyPigstyChangeSet, applyPigstyEngineResult, applyPigstyPublication, assessPigstyArtifactStore, assessPigstyBuildRecord, createPigstyArtifactStore, createPigstyBuildPublication, createPigstyChangeSet, createPigstyEngineContract, createPigstyEngineResult, createPigstyFileSystemView, digestPigstyWorkspace, resolvePigstyPath, runPigstyBuild, runPigstyEngine, runPigstyScript, upsertPigstyBuildRecord } from '../packages/pigsty/src/index.js';
import { WursterWebSession } from '../runtime/web/src/wurster-web.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
if (!globalThis.location) globalThis.location = { origin: 'https://wurster.test', href: 'https://wurster.test/player' };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wurst-piglet-pigsty-'));
try {
  const childProject = path.join(tmp, 'child');
  await fs.mkdir(path.join(childProject, 'src'), { recursive: true });
  await fs.writeFile(path.join(childProject, 'src', 'index.html'), '<!doctype html><title>Child</title><h1>Child Wurst</h1>');
  await fs.writeFile(path.join(childProject, 'wurst.json'), JSON.stringify({
    id: 'io.wrst.child-tool',
    name: 'Child Tool',
    version: '0.32.0',
    source: 'src',
    entry: 'index.html'
  }, null, 2));
  const childOutput = path.join(tmp, 'child-tool.wurst');
  await buildWurst(childProject, childOutput);
  const childBytes = await fs.readFile(childOutput);

  const parentProject = path.join(tmp, 'parent');
  await fs.mkdir(path.join(parentProject, 'src'), { recursive: true });
  await fs.copyFile(childOutput, path.join(parentProject, 'child-tool.wurst'));
  await fs.writeFile(path.join(parentProject, 'src', 'index.html'), '<!doctype html><title>Parent</title><h1>Parent Wurst</h1>');
  await fs.writeFile(path.join(parentProject, 'src', 'content.md'), '# Parent Source\n\nBuild me inside the sty.');
  await fs.writeFile(path.join(parentProject, 'src', 'build-page.js'), `
Pigsty.define(async (ctx) => {
  const source = await ctx.readText('content.md');
  await ctx.writeText('dist/page.html', source.replace(/^# (.*)$/m, '<h1>$1</h1>'));
  return { files: ctx.list('dist') };
});
`);
  await fs.writeFile(path.join(parentProject, 'wurst.json'), JSON.stringify({
    id: 'io.wrst.parent-shell',
    name: 'Parent Shell',
    version: '0.32.0',
    source: 'src',
    entry: 'index.html',
    pigsty: {
      version: 'node-lts-1',
      tools: ['typescript'],
      offline: true,
      builds: {
        page: {
          source: 'build-page.js',
          outputs: ['dist']
        }
      }
    },
    piglet: {
      children: [
        { id: 'child-tool', source: 'child-tool.wurst', label: 'Child Tool' }
      ]
    }
  }, null, 2));

  const parentOutput = path.join(tmp, 'parent-shell.wurst');
  await buildWurst(parentProject, parentOutput);
  const parentPackage = decodeWurst(await fs.readFile(parentOutput));
  assert.equal(parentPackage.manifest.piglet.format, 'wurst/piglet-1');
  assert.equal(parentPackage.manifest.piglet.children.length, 1);
  const child = parentPackage.manifest.piglet.children[0];
  assert.equal(child.id, 'child-tool');
  assert.equal(child.entry, '__wurst/piglet/child-tool.wurst');
  assert.equal(child.sha256, sha256(childBytes));
  assert.equal(parentPackage.get(child.entry).scope, 'piglet');
  assert.equal(parentPackage.manifest.pigsty.format, 'wurst/pigsty-1');
  assert.equal(parentPackage.manifest.pigsty.version, 'node-lts-1');
  assert.deepEqual(parentPackage.manifest.pigsty.tools, ['typescript']);
  assert.equal(parentPackage.manifest.pigsty.builds.page.source, 'build-page.js');

  const sellerPhrase = 'smoked-bacon peppered-brisket cured-ham grilled-rib charred-steak mustard-pork hickory-wurst iron-chop maple-salami crispy-roast ember-belly garlic-jerky';
  const seller = createPublisherKeyBundle({ email: 'piglet@example.com', meatphrase: sellerPhrase });
  const signature = createPackageSignature(parentPackage, seller.bundle, sellerPhrase);
  const signedFiles = [
    ...descriptorsFromPackage(parentPackage).filter((file) => file.path !== SIGNATURE_PATH),
    { path: SIGNATURE_PATH, data: Buffer.from(JSON.stringify(signature)), scope: 'signature', mime: 'application/json; charset=utf-8' }
  ];
  const signedPackage = decodeWurst(encodeWurst({ manifest: parentPackage.manifest, files: signedFiles }));
  assert.equal(verifyPackageSignature(signedPackage).status, 'signed');
  const tamperedFiles = descriptorsFromPackage(signedPackage).map((file) => file.path === child.entry
    ? { ...file, data: Buffer.from('not a child wurst anymore') }
    : file);
  const tamperedPackage = decodeWurst(encodeWurst({ manifest: signedPackage.manifest, files: tamperedFiles }));
  assert.equal(verifyPackageSignature(tamperedPackage).status, 'invalid');

  const parentSession = await WursterWebSession.open(new Blob([await fs.readFile(parentOutput)]), { sessionId: 'piglet-parent-test' });
  assert.deepEqual(parentSession.piglets().map((item) => item.id), ['child-tool']);
  assert.match(parentSession.pigletUrl('child-tool'), /\/piglet\/child-tool\.wurst$/);
  const served = await parentSession._serve({ scope: 'piglet', path: 'child-tool.wurst', method: 'GET', range: null });
  assert.equal(served.status, 200);
  assert.equal(sha256(Buffer.from(new Uint8Array(served.body))), child.sha256);
  const childSession = await parentSession.openPiglet('child-tool');
  assert.equal(childSession.reader.manifest.id, 'io.wrst.child-tool');
  assert.match(new TextDecoder().decode(new Uint8Array((await childSession._serve({ scope: 'app', path: 'index.html', method: 'GET', range: null })).body)), /Child Wurst/);
  const pigsty = parentSession.pigstyStatus();
  assert.equal(pigsty.declared, true);
  assert.equal(pigsty.state, 'unavailable');
  assert.equal(pigsty.policy.version, 'node-lts-1');
  assert.deepEqual(pigsty.builds, ['page']);

  const requestWorkspace = {
    'src/page.md': '# Pigsty Build\n\nOink.',
    'src/title.txt': 'Functional Pigsty'
  };
  const pigstyBuild = await runPigstyScript({
    policy: parentPackage.manifest.pigsty,
    workspace: requestWorkspace,
    args: { outDir: 'dist' },
    script: `
      Pigsty.define({
        async run(ctx) {
          const markdown = await ctx.readText('src/page.md');
          const title = await ctx.readText('src/title.txt');
          const html = '<!doctype html><title>' + title + '</title>' +
            markdown.replace(/^# (.*)$/m, '<h1>$1</h1>').replace(/\\n\\n/g, '<p>');
          await ctx.writeText(ctx.args.outDir + '/index.html', html);
          return { built: true, files: ctx.list(ctx.args.outDir) };
        }
      });
    `
  });
  assert.equal(pigstyBuild.ok, true);
  assert.equal(pigstyBuild.provenance.format, 'wurst/pigsty-provenance-1');
  assert.deepEqual(pigstyBuild.provenance.sourceDigest, digestPigstyWorkspace(requestWorkspace));
  assert.notEqual(pigstyBuild.provenance.outputDigest.sha256, pigstyBuild.provenance.sourceDigest.sha256);
  assert.deepEqual(pigstyBuild.writes, ['dist/index.html']);
  assert.deepEqual(pigstyBuild.artifacts.map((item) => item.path), ['dist/index.html']);
  assert.equal(pigstyBuild.artifacts[0].bytes, Buffer.byteLength(pigstyBuild.workspace['dist/index.html']));
  assert.match(pigstyBuild.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(pigstyBuild.workspace['dist/index.html'], /<h1>Pigsty Build<\/h1>/);
  assert.deepEqual(pigstyBuild.result, { built: true, files: ['dist/index.html'] });

  const packageWorkspace = Object.fromEntries(
    descriptorsFromPackage(parentPackage)
      .filter((file) => (file.scope ?? 'app') === 'app')
      .map((file) => [file.path, file.data])
  );
  const pigstyPackageBuild = await runPigstyScript({
    policy: parentPackage.manifest.pigsty,
    workspace: packageWorkspace,
    script: `
      Pigsty.define(async (ctx) => {
        const source = await ctx.readText('content.md');
        await ctx.writeText('dist/from-package.html', source.replace(/^# (.*)$/m, '<h1>$1</h1>'));
        return { sourceFiles: ctx.list().filter((name) => name.endsWith('.md')) };
      });
    `
  });
  assert.match(pigstyPackageBuild.workspace['dist/from-package.html'], /<h1>Parent Source<\/h1>/);
  assert.deepEqual(pigstyPackageBuild.result, { sourceFiles: ['content.md'] });
  assert.equal(pigstyPackageBuild.provenance.sourceDigest.files, 3);
  assert.deepEqual(pigstyPackageBuild.artifacts.map((item) => item.path), ['dist/from-package.html']);

  const declaredBuild = await runPigstyBuild({
    policy: parentPackage.manifest.pigsty,
    build: 'page',
    workspace: packageWorkspace
  });
  assert.equal(declaredBuild.build.format, 'wurst/pigsty-build-record-1');
  assert.equal(declaredBuild.build.name, 'page');
  assert.equal(declaredBuild.build.source, 'build-page.js');
  assert.deepEqual(declaredBuild.build.declaredOutputs, ['dist']);
  assert.deepEqual(declaredBuild.artifacts.map((item) => item.path), ['dist/page.html']);
  assert.match(declaredBuild.workspace['dist/page.html'], /<h1>Parent Source<\/h1>/);
  assert.equal(assessPigstyBuildRecord(declaredBuild.build, packageWorkspace).state, 'fresh');
  const store = upsertPigstyBuildRecord(createPigstyArtifactStore(), declaredBuild);
  assert.equal(store.format, 'wurst/pigsty-artifact-store-1');
  assert.equal(assessPigstyArtifactStore(store, 'page', {
    sourceWorkspace: packageWorkspace,
    artifactWorkspace: declaredBuild.workspace
  }).state, 'fresh');
  assert.equal(assessPigstyArtifactStore(store, 'missing-build', {
    sourceWorkspace: packageWorkspace,
    artifactWorkspace: declaredBuild.workspace
  }).state, 'missing');
  const missingArtifact = assessPigstyArtifactStore(store, 'page', {
    sourceWorkspace: packageWorkspace,
    artifactWorkspace: packageWorkspace
  });
  assert.equal(missingArtifact.state, 'missing');
  assert.equal(missingArtifact.reason, 'missing-artifact');
  const staleWorkspace = { ...packageWorkspace, 'content.md': '# Parent Source\n\nChanged after build.' };
  const stale = assessPigstyBuildRecord(declaredBuild.build, staleWorkspace);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.reason, 'source-digest-mismatch');
  assert.equal(assessPigstyArtifactStore(store, 'page', {
    sourceWorkspace: staleWorkspace,
    artifactWorkspace: declaredBuild.workspace
  }).state, 'stale');
  const changedArtifact = assessPigstyArtifactStore(store, 'page', {
    sourceWorkspace: packageWorkspace,
    artifactWorkspace: { ...declaredBuild.workspace, 'dist/page.html': '<h1>tampered</h1>' }
  });
  assert.equal(changedArtifact.state, 'invalid');
  assert.equal(changedArtifact.reason, 'artifact-digest-mismatch');

  const publication = createPigstyBuildPublication(declaredBuild, { store });
  assert.equal(publication.format, 'wurst/pigsty-publication-1');
  assert.equal(publication.build, 'page');
  assert.equal(publication.storePath, 'data/builds/page/current.json');
  assert.equal(publication.artifactRoot, 'data/builds/page/artifacts');
  assert.match(publication.files['data/builds/page/artifacts/dist/page.html'], /<h1>Parent Source<\/h1>/);
  const publishedWorkspace = applyPigstyPublication(packageWorkspace, publication);
  const publishedStore = JSON.parse(publishedWorkspace[publication.storePath]);
  const publishedStatus = assessPigstyArtifactStore(publishedStore, 'page', {
    sourceWorkspace: packageWorkspace,
    artifactWorkspace: publishedWorkspace
  });
  assert.equal(publishedStatus.state, 'fresh');
  assert.equal(publishedStatus.artifacts[0].path, 'dist/page.html');
  assert.equal(publishedStatus.artifacts[0].storedPath, 'data/builds/page/artifacts/dist/page.html');
  const tamperedPublishedStatus = assessPigstyArtifactStore(publishedStore, 'page', {
    sourceWorkspace: packageWorkspace,
    artifactWorkspace: {
      ...publishedWorkspace,
      'data/builds/page/artifacts/dist/page.html': '<h1>published tamper</h1>'
    }
  });
  assert.equal(tamperedPublishedStatus.state, 'invalid');
  assert.equal(tamperedPublishedStatus.reason, 'artifact-digest-mismatch');

  const engineContract = createPigstyEngineContract({
    policy: parentPackage.manifest.pigsty,
    workspace: packageWorkspace,
    toolchain: {
      'node_modules/@11ty/eleventy/package.json': '{"name":"@11ty/eleventy"}'
    },
    args: { build: 'page' }
  });
  assert.equal(engineContract.format, 'wurst/pigsty-engine-contract-1');
  assert.equal(engineContract.runtime, 'node-compatible');
  assert.equal(engineContract.isolation, 'engine-sandbox');
  assert.equal(engineContract.engineHint, 'edge-wasix');
  assert.equal(engineContract.cwd, '/wurst');
  assert.equal(engineContract.mounts[0].path, '/wurst');
  assert.equal(engineContract.mounts[0].source, 'wurstfs');
  assert.equal(engineContract.mounts[0].writable, true);
  assert.equal(engineContract.mounts[1].path, '/toolchain');
  assert.equal(engineContract.mounts[1].source, 'toolchain');
  assert.equal(engineContract.mounts[1].writable, false);
  assert.equal(engineContract.mounts[2].path, '/tmp');
  assert.equal(engineContract.mounts[2].source, 'ephemeral');
  assert.equal(engineContract.mounts[2].persistent, false);
  assert.equal(engineContract.capabilities.hostFilesystem, false);
  assert.equal(engineContract.capabilities.hostProcesses, false);
  assert.equal(engineContract.capabilities.hostShell, false);
  assert.equal(engineContract.capabilities.network, false);
  assert.deepEqual(engineContract.mounts[0].digest, digestPigstyWorkspace(packageWorkspace));
  assert.equal(resolvePigstyPath('content.md').absolutePath, '/wurst/content.md');
  assert.deepEqual(resolvePigstyPath('../content.md', { cwd: '/wurst/src' }), {
    absolutePath: '/wurst/content.md',
    mountPath: '/wurst',
    source: 'wurstfs',
    path: 'content.md'
  });
  assert.deepEqual(resolvePigstyPath('/toolchain/node_modules/@11ty/eleventy/package.json'), {
    absolutePath: '/toolchain/node_modules/@11ty/eleventy/package.json',
    mountPath: '/toolchain',
    source: 'toolchain',
    path: 'node_modules/@11ty/eleventy/package.json'
  });
  assert.throws(() => resolvePigstyPath('/etc/passwd'), /outside mounted/);

  const fsView = createPigstyFileSystemView({
    policy: parentPackage.manifest.pigsty,
    workspace: packageWorkspace,
    toolchain: { 'node_modules/tool/index.js': 'module.exports = 1;' },
    tmp: { 'scratch.log': 'temporary' },
    args: { build: 'page' }
  });
  assert.equal(fsView.format, 'wurst/pigsty-fs-view-1');
  assert.deepEqual(fsView.mounts.map((mount) => `${mount.path}:${mount.source}:${mount.writable}`), [
    '/wurst:wurstfs:true',
    '/toolchain:toolchain:false',
    '/tmp:ephemeral:true'
  ]);
  assert.equal(fsView.mounts[0].files.some((entry) => entry.path === 'content.md'), true);
  assert.equal(fsView.mounts[1].files[0].path, 'node_modules/tool/index.js');
  assert.equal(fsView.mounts[2].files[0].path, 'scratch.log');

  const changedWorkspace = {
    ...packageWorkspace,
    'content.md': '# Parent Source\n\nEdited inside Pigsty.',
    'dist/page.html': '<h1>Built inside the sty</h1>'
  };
  delete changedWorkspace['index.html'];
  const changeSet = createPigstyChangeSet(packageWorkspace, changedWorkspace);
  assert.equal(changeSet.format, 'wurst/pigsty-changeset-1');
  assert.deepEqual(changeSet.changes.map((item) => `${item.op}:${item.path}`), [
    'modify:content.md',
    'add:dist/page.html',
    'delete:index.html'
  ]);
  const appliedWorkspace = applyPigstyChangeSet(packageWorkspace, changeSet);
  assert.deepEqual(digestPigstyWorkspace(appliedWorkspace), digestPigstyWorkspace(changedWorkspace));
  assert.match(appliedWorkspace['dist/page.html'], /Built inside the sty/);
  assert.equal(appliedWorkspace['index.html'], undefined);
  const engineResult = createPigstyEngineResult({
    contract: engineContract,
    beforeWorkspace: packageWorkspace,
    afterWorkspace: changedWorkspace,
    tmpWorkspace: { 'cache.txt': 'not persisted' },
    result: { ok: true },
    events: [{ type: 'log', message: 'built' }]
  });
  assert.equal(engineResult.format, 'wurst/pigsty-engine-result-1');
  assert.equal(engineResult.changeSet.changes.length, 3);
  assert.equal(engineResult.result.ok, true);
  assert.equal(engineResult.events[0].message, 'built');
  assert.notDeepEqual(engineResult.tmpDigest, digestPigstyWorkspace({}));
  const appliedEngineWorkspace = applyPigstyEngineResult(packageWorkspace, engineResult);
  assert.deepEqual(digestPigstyWorkspace(appliedEngineWorkspace), digestPigstyWorkspace(changedWorkspace));
  assert.throws(
    () => applyPigstyEngineResult({ ...packageWorkspace, 'extra.txt': 'stale' }, engineResult),
    /source digest/
  );

  const decodedViewText = (entry) => entry.encoding === 'base64'
    ? Buffer.from(entry.data, 'base64').toString('utf8')
    : String(entry.data ?? '');
  const adapterRun = await runPigstyEngine({
    policy: parentPackage.manifest.pigsty,
    workspace: packageWorkspace,
    toolchain: {
      'node_modules/@11ty/eleventy/package.json': '{"name":"@11ty/eleventy"}'
    },
    tmp: {
      'scratch.log': 'temporary'
    },
    args: { suffix: 'adapter' },
    engine: {
      name: 'mock-edge-wasix',
      async run(view, metadata) {
        assert.equal(view.format, 'wurst/pigsty-fs-view-1');
        assert.equal(metadata.contract.format, 'wurst/pigsty-engine-contract-1');
        assert.equal(view.cwd, '/wurst');
        assert.deepEqual(view.mounts.map((mount) => `${mount.path}:${mount.source}:${mount.writable}`), [
          '/wurst:wurstfs:true',
          '/toolchain:toolchain:false',
          '/tmp:ephemeral:true'
        ]);
        const mountPaths = view.mounts.map((mount) => mount.path);
        assert.deepEqual(resolvePigstyPath('content.md', { cwd: view.cwd, mounts: mountPaths }), {
          absolutePath: '/wurst/content.md',
          mountPath: '/wurst',
          source: 'wurstfs',
          path: 'content.md'
        });
        assert.equal(resolvePigstyPath('/tmp/scratch.log', { cwd: view.cwd, mounts: mountPaths }).source, 'ephemeral');
        assert.equal(resolvePigstyPath('/toolchain/node_modules/@11ty/eleventy/package.json', { cwd: view.cwd, mounts: mountPaths }).source, 'toolchain');
        assert.throws(() => resolvePigstyPath('/home/user/.ssh/id_ed25519', { cwd: view.cwd, mounts: mountPaths }), /outside mounted/);
        const wurstMount = view.mounts.find((mount) => mount.path === '/wurst');
        const contentEntry = wurstMount.files.find((entry) => entry.path === 'content.md');
        assert.match(decodedViewText(contentEntry), /Parent Source/);
        return {
          workspace: {
            ...packageWorkspace,
            'dist/adapter.html': '<h1>Built by adapter</h1>'
          },
          tmp: {
            'cache/adapter.log': 'not persistent'
          },
          result: { engine: 'mock-edge-wasix', built: true },
          events: [{ type: 'log', message: 'adapter built dist/adapter.html' }]
        };
      }
    }
  });
  assert.equal(adapterRun.ok, true);
  assert.equal(adapterRun.adapter, 'mock-edge-wasix');
  assert.equal(adapterRun.format, 'wurst/pigsty-engine-result-1');
  assert.deepEqual(adapterRun.changeSet.changes.map((item) => `${item.op}:${item.path}`), ['add:dist/adapter.html']);
  assert.match(adapterRun.workspace['dist/adapter.html'], /Built by adapter/);
  assert.equal(adapterRun.tmpWorkspace['cache/adapter.log'], 'not persistent');
  assert.equal(adapterRun.result.built, true);
  assert.equal(adapterRun.events[0].message, 'adapter built dist/adapter.html');
  assert.equal(adapterRun.targetDigest.sha256, digestPigstyWorkspace(adapterRun.workspace).sha256);
  assert.equal(adapterRun.sourceDigest.sha256, digestPigstyWorkspace(packageWorkspace).sha256);

  await assert.rejects(
    runPigstyEngine({
      policy: parentPackage.manifest.pigsty,
      workspace: packageWorkspace
    }),
    /requires an adapter/
  );

  await assert.rejects(
    runPigstyEngine({
      policy: parentPackage.manifest.pigsty,
      workspace: packageWorkspace,
      timeoutMs: 50,
      engine: {
        name: 'slow-engine',
        run: () => new Promise(() => {})
      }
    }),
    /exceeded 50 ms/
  );

  assert.throws(
    () => createPigstyEngineContract({
      policy: {
        ...parentPackage.manifest.pigsty,
        offline: false
      },
      workspace: { '../host.txt': 'nope' }
    }),
    /escapes the Wurst/
  );

  await assert.rejects(
    runPigstyBuild({
      policy: {
        ...parentPackage.manifest.pigsty,
        builds: {
          bad: {
            source: 'bad-build.js',
            outputs: ['dist']
          }
        }
      },
      build: 'bad',
      workspace: {
        ...packageWorkspace,
        'bad-build.js': `Pigsty.define(async (ctx) => { await ctx.writeText('outside/result.txt', 'nope'); });`
      }
    }),
    /outside declared outputs/
  );

  await assert.rejects(
    runPigstyScript({
      policy: parentPackage.manifest.pigsty,
      workspace: { 'src/input.txt': 'safe' },
      script: `Pigsty.define(async (ctx) => ctx.readText('../host-secret.txt'));`
    }),
    /escapes the Wurst/
  );

  await assert.rejects(
    runPigstyScript({
      policy: parentPackage.manifest.pigsty,
      workspace: { 'src/input.txt': 'safe' },
      script: `Pigsty.define(async () => process.cwd());`
    }),
    /process is not defined/
  );
  await childSession.fs.dispose();
  await parentSession.fs.dispose();

  console.log('✓ Piglet embeds signed child Wurst bytes and Wurster Web opens them as an internal child session');
  console.log('✓ Pigsty declaration is normalized, worker builds run, and engine adapters commit through digest-checked change-sets');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
