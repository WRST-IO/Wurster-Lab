import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WURSTER_EDGE_RUNTIME_NAME,
  createEdgeWasixPigstyEngine,
  createResolvedEdgeWasixPigstyEngine,
  digestPigstyWorkspace,
  probeEdgeWasixPigstyEngine,
  probeResolvedEdgeWasixPigstyEngine,
  resolveEdgeWasixRuntime,
  runPigstyEngineBuild
} from '../packages/pigsty/src/index.js';

const policy = {
  version: 'node-lts-1',
  tools: ['eleventy'],
  offline: true,
  builds: {
    site: {
      source: 'build-site.js',
      outputs: ['dist']
    }
  }
};

const workspace = {
  'content.md': '# Edge Pigsty\n\nBuilt with node:fs.',
  'build-site.js': `
    const fs = require('node:fs');
    const eleventy = require('@11ty/eleventy/package.json');
    const source = fs.readFileSync('content.md', 'utf8');
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('dist/index.html', source.replace(/^# (.*)$/m, '<h1>$1</h1>') + '\\n<p>' + eleventy.name + '</p>');
  `
};

const missingProbe = await probeEdgeWasixPigstyEngine({
  edgePath: '/definitely/not/edge',
  async runCommand() {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  }
});
assert.equal(missingProbe.available, false);
assert.equal(missingProbe.reason, 'edge-binary-not-found');

const healthyProbe = await probeEdgeWasixPigstyEngine({
  edgePath: '/opt/wurster/bin/edge',
  env: {
    WASMER_BIN: '/opt/wurster/bin/wasmer',
    EDGE_WASMER_PACKAGE: '/opt/wurster/share/edge-wasix'
  },
  async runCommand({ args, env }) {
    assert.equal(env.WASMER_BIN, '/opt/wurster/bin/wasmer');
    assert.equal(env.EDGE_WASMER_PACKAGE, '/opt/wurster/share/edge-wasix');
    if (args[0] === '--version') return { status: 0, stdout: 'v24.13.2-pre\n', stderr: '' };
    assert.deepEqual(args, ['--safe', '-e', 'console.log("pigsty-edge-safe-probe")']);
    return { status: 0, stdout: 'pigsty-edge-safe-probe\n', stderr: '' };
  }
});
assert.equal(healthyProbe.available, true);
assert.equal(healthyProbe.safe, true);
assert.equal(healthyProbe.version, 'v24.13.2-pre');

const unsafeProbe = await probeEdgeWasixPigstyEngine({
  edgePath: '/opt/wurster/bin/edge',
  async runCommand({ args }) {
    if (args[0] === '--version') return { status: 0, stdout: 'v24.13.2-pre\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'safe mode requires Wasmer.' };
  }
});
assert.equal(unsafeProbe.available, false);
assert.equal(unsafeProbe.safe, false);
assert.match(unsafeProbe.reason, /safe mode requires Wasmer/);

const runtimeDir = await createFakeEdgeRuntimeBundle('test-os-test-arch');
const resolvedRuntime = await resolveEdgeWasixRuntime({
  runtimeDir,
  cacheDir: null,
  target: 'test-os-test-arch',
  verifyHashes: true
});
assert.equal(resolvedRuntime.configured, true);
assert.equal(resolvedRuntime.bundled, true);
assert.equal(resolvedRuntime.target, 'test-os-test-arch');
assert.equal(resolvedRuntime.manifest.name, WURSTER_EDGE_RUNTIME_NAME);
assert.equal(resolvedRuntime.edgePath, path.join(runtimeDir, 'bin', process.platform === 'win32' ? 'edge.exe' : 'edge'));
assert.equal(resolvedRuntime.env.WASMER_BIN, path.join(runtimeDir, 'bin', process.platform === 'win32' ? 'wasmer.exe' : 'wasmer'));
assert.equal(resolvedRuntime.env.EDGE_WASMER_PACKAGE, path.join(runtimeDir, 'share', 'edge-wasix'));
assert.match(resolvedRuntime.cacheDir, /wurster-pigsty-cache/);
assert.equal(resolvedRuntime.cacheDir.startsWith(runtimeDir), false);

const discoveredRuntime = await resolveEdgeWasixRuntime({
  runtimeDir: null,
  runtimeDirs: [path.join(runtimeDir, '..', 'missing-runtime'), runtimeDir],
  cacheDir: null,
  target: 'test-os-test-arch',
  verifyHashes: true
});
assert.equal(discoveredRuntime.runtimeDir, runtimeDir);
assert.equal(discoveredRuntime.bundled, true);

await assert.rejects(
  resolveEdgeWasixRuntime({
    runtimeDir,
    target: 'wrong-target'
  }),
  /target mismatch/
);

const resolvedProbe = await probeResolvedEdgeWasixPigstyEngine({
  runtimeDir,
  target: 'test-os-test-arch',
  cacheDir: path.join(os.tmpdir(), 'wurster-pigsty-test-cache'),
  async runCommand({ command, args, env }) {
    assert.equal(command, resolvedRuntime.edgePath);
    assert.equal(env.WASMER_BIN, resolvedRuntime.env.WASMER_BIN);
    assert.equal(env.EDGE_WASMER_PACKAGE, resolvedRuntime.env.EDGE_WASMER_PACKAGE);
    assert.match(env.WASMER_DIR, /wurster-pigsty-test-cache/);
    if (args[0] === '--version') return { status: 0, stdout: 'v24.13.2-pre\n', stderr: '' };
    return { status: 0, stdout: 'pigsty-edge-safe-probe\n', stderr: '' };
  }
});
assert.equal(resolvedProbe.available, true);
assert.equal(resolvedProbe.bundled, true);
assert.equal(resolvedProbe.configured, true);
assert.equal(resolvedProbe.manifest.name, WURSTER_EDGE_RUNTIME_NAME);
assert.equal(resolvedProbe.manifest.files, 4);

const resolvedEngine = await createResolvedEdgeWasixPigstyEngine({
  runtimeDir,
  target: 'test-os-test-arch',
  engine: {
    async runCommand({ command, env }) {
      assert.equal(command, resolvedRuntime.edgePath);
      assert.equal(env.WASMER_BIN, resolvedRuntime.env.WASMER_BIN);
      return { status: 0, stdout: '', stderr: '' };
    }
  }
});
assert.equal(resolvedEngine.name, 'edge-wasix');

const engine = createEdgeWasixPigstyEngine({
  edgePath: '/opt/wurster/bin/edge',
  async runCommand({ command, args, cwd, env, mounts }) {
    assert.equal(command, '/opt/wurster/bin/edge');
    assert.equal(args[0], '--safe');
    assert.equal(args[1], '.pigsty-runner.mjs');
    assert.equal(path.isAbsolute(args[1]), false);
    assert.equal(cwd.endsWith(`${path.sep}wurst`), true);
    assert.equal(env.PIGSTY, '1');
    assert.equal(env.PIGSTY_ENTRY, 'build-site.js');
    assert.match(env.PIGSTY_ARGS_JSON, /"entry":"build-site.js"/);
    assert.deepEqual(mounts.map((mount) => `${mount.path}:${mount.source}:${mount.writable}`), [
      '/wurst:wurstfs:true',
      '/toolchain:toolchain:false',
      '/tmp:ephemeral:true'
    ]);
    assert.equal(mounts.find((mount) => mount.path === '/toolchain').hostPath.endsWith(`${path.sep}toolchain`), true);
    const runner = await fs.readFile(path.join(cwd, args[1]), 'utf8');
    assert.match(runner, /globalThis\.Pigsty/);
    const script = await fs.readFile(path.join(cwd, env.PIGSTY_ENTRY), 'utf8');
    assert.match(script, /require\('node:fs'\)/);
    const nodeModules = await fs.lstat(path.join(cwd, 'node_modules'));
    assert.equal(nodeModules.isDirectory(), true);
    assert.equal(nodeModules.isSymbolicLink(), false);
    assert.match(await fs.readFile(path.join(cwd, 'node_modules', '@11ty', 'eleventy', 'package.json'), 'utf8'), /@11ty\/eleventy/);
    const source = await fs.readFile(path.join(cwd, 'content.md'), 'utf8');
    await fs.mkdir(path.join(cwd, 'dist'), { recursive: true });
    const eleventy = JSON.parse(await fs.readFile(path.join(cwd, 'node_modules', '@11ty', 'eleventy', 'package.json'), 'utf8'));
    await fs.writeFile(path.join(cwd, 'dist', 'index.html'), source.replace(/^# (.*)$/m, '<h1>$1</h1>') + `\n<p>${eleventy.name}</p>`);
    await fs.mkdir(path.join(path.dirname(cwd), 'tmp', 'cache'), { recursive: true });
    await fs.writeFile(path.join(path.dirname(cwd), 'tmp', 'cache', 'edge.log'), 'tmp only');
    return { status: 0, stdout: 'edge build ok\n', stderr: '' };
  }
});

const toolchain = {
  'node_modules/@11ty/eleventy/package.json': '{"name":"@11ty/eleventy"}'
};
const built = await runPigstyEngineBuild({
  policy,
  build: 'site',
  workspace,
  toolchain,
  tmp: {
    'before.txt': 'temporary input'
  },
  engine
});
assert.equal(built.ok, true);
assert.equal(built.adapter, 'edge-wasix');
assert.equal(built.build.name, 'site');
assert.equal(built.build.provenance.engine, 'edge-wasix');
assert.deepEqual(built.build.provenance.toolchain.digest, digestPigstyWorkspace(toolchain));
assert.deepEqual(built.writes, ['dist/index.html']);
assert.deepEqual(built.artifacts.map((artifact) => artifact.path), ['dist/index.html']);
assert.match(built.workspace['dist/index.html'], /<h1>Edge Pigsty<\/h1>/);
assert.equal(built.workspace['.pigsty-runner.mjs'], undefined);
assert.equal(built.workspace['node_modules/@11ty/eleventy/package.json'], undefined);
assert.equal(built.tmpWorkspace['cache/edge.log'], 'tmp only');
assert.equal(built.events[0].message, 'edge build ok');

const carriedToolchainWorkspace = {
  ...workspace,
  'pigsty-toolchain/node_modules/@11ty/eleventy/package.json': '{"name":"@11ty/eleventy"}'
};
const carriedToolchainBuild = await runPigstyEngineBuild({
  policy,
  build: 'site',
  workspace: carriedToolchainWorkspace,
  engine
});
assert.deepEqual(carriedToolchainBuild.build.provenance.toolchain.digest, digestPigstyWorkspace(toolchain));
assert.match(carriedToolchainBuild.workspace['dist/index.html'], /<h1>Edge Pigsty<\/h1>/);
assert.equal(carriedToolchainBuild.workspace['node_modules/@11ty/eleventy/package.json'], undefined);
assert.equal(carriedToolchainBuild.workspace['pigsty-toolchain/node_modules/@11ty/eleventy/package.json'], '{"name":"@11ty/eleventy"}');

const badOutputEngine = createEdgeWasixPigstyEngine({
  edgePath: '/opt/wurster/bin/edge',
  async runCommand({ cwd }) {
    await fs.writeFile(path.join(cwd, 'outside.html'), '<h1>nope</h1>');
    return { status: 0, stdout: '', stderr: '' };
  }
});
await assert.rejects(
  runPigstyEngineBuild({
    policy,
    build: 'site',
    workspace,
    engine: badOutputEngine
  }),
  /outside declared outputs/
);

const failingEngine = createEdgeWasixPigstyEngine({
  edgePath: '/opt/wurster/bin/edge',
  async runCommand() {
    return { status: 1, stdout: '', stderr: 'syntax exploded' };
  }
});
await assert.rejects(
  runPigstyEngineBuild({
    policy,
    build: 'site',
    workspace,
    engine: failingEngine
  }),
  /syntax exploded/
);

await assert.rejects(
  runPigstyEngineBuild({
    policy,
    build: 'site',
    workspace,
    toolchain: {
      'node_modules/native/build.node': new Uint8Array([1, 2, 3])
    },
    engine
  }),
  /native Node addons/
);

const realProbe = await probeResolvedEdgeWasixPigstyEngine();
if (realProbe.available) {
  const realBuild = await runPigstyEngineBuild({
    policy,
    build: 'site',
    workspace,
    toolchain,
    engine: await createResolvedEdgeWasixPigstyEngine()
  });
  assert.match(realBuild.workspace['dist/index.html'], /<h1>Edge Pigsty<\/h1>/);
  assert.equal(realBuild.workspace['node_modules/@11ty/eleventy/package.json'], undefined);
  const legacyBuild = await runPigstyEngineBuild({
    policy,
    build: 'site',
    workspace: {
      ...workspace,
      'build-site.js': `
        Pigsty.define(async (ctx) => {
          const source = await ctx.readText('content.md');
          await ctx.writeText('dist/index.html', source.replace(/^# (.*)$/m, '<h1>$1</h1>') + '\\n<p>' + ctx.args.entry + '</p>');
        });
      `
    },
    toolchain,
    engine: await createResolvedEdgeWasixPigstyEngine()
  });
  assert.match(legacyBuild.workspace['dist/index.html'], /<p>build-site\.js<\/p>/);
  assert.equal(legacyBuild.workspace['.pigsty-runner.mjs'], undefined);
} else {
  console.log(`↷ Skipping real Edge/WASIX smoke test: ${realProbe.reason}`);
}

console.log('✓ Pigsty Edge/WASIX adapter probes Edge, invokes edge --safe and commits declared build outputs through WurstFS change-sets');

async function createFakeEdgeRuntimeBundle(target) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wurster-edge-runtime-test-'));
  const edgeName = process.platform === 'win32' ? 'edge.exe' : 'edge';
  const wasmerName = process.platform === 'win32' ? 'wasmer.exe' : 'wasmer';
  const files = {
    [`bin/${edgeName}`]: 'fake edge\n',
    [`bin/${wasmerName}`]: 'fake wasmer\n',
    'share/edge-wasix/wasmer.toml': '[package]\nname = "edge-wasix"\n',
    'share/edge-wasix/edgejs.wasm': new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
  };
  const manifestFiles = [];
  for (const [relative, value] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const data = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
    await fs.writeFile(absolute, data);
    manifestFiles.push({
      path: relative,
      sha256: createHash('sha256').update(data).digest('hex')
    });
  }
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    name: WURSTER_EDGE_RUNTIME_NAME,
    version: '0.1.0-dev.test',
    target,
    files: manifestFiles
  }, null, 2));
  return root;
}
