---
title: Pigsty
group: Runtime & Format
groupOrder: 2
order: 4
---
# Pigsty

Pigsty is a Wurster runtime capability: a controlled internal tool environment for a Wurst.

Its first principle is simple:

```text
Build where Pigsty exists. Run everywhere.
```

A Wurst may use Pigsty to compile sources, regenerate derived assets or run project tools inside its own Wurst workspace. Pigsty is not host Node access and not a shortcut around Wurster's capability broker.

## Status In 0.32.0

Pigsty is **experimental in v0.32 and is not bundled in normal Desktop releases yet**. The implementation stays in-tree so its contracts and adapters can mature without blocking Windows, macOS or Web. The current code includes a development worker slice and the engine-neutral contracts for the fuller Node-compatible runtime:

- MeatGrinder validates and stores `pigsty` policy in the manifest.
- Wurster runtimes expose `wurst.pigsty.status()`.
- Desktop and headless Wurster expose declared build names through `wurst.pigsty.status().builds`.
- The sandbox worker runs small `Pigsty.define(...)` JavaScript tasks against a virtual Wurst workspace when explicitly enabled for development. It is not the normal Desktop production engine.
- `wurst/pigsty-engine-contract-1` describes the intended internal runtime world: `/wurst` as WurstFS-backed workspace, `/tmp` as ephemeral scratch, no host filesystem, no host shell, no host processes and no host environment.
- `wurst/pigsty-fs-view-1` gives an engine adapter a concrete mount view with normalized files for `/wurst`, optional `/toolchain` and `/tmp`.
- `wurst/pigsty-changeset-1` describes the transactional return path from an internal engine run back into WurstFS.
- `wurst/pigsty-engine-result-1` wraps a verified engine run result, events, temporary-work digest and persistent WurstFS change-set.
- `runPigstyEngine(...)` now provides the engine-adapter handoff: Wurster creates the Pigsty filesystem view, calls a supplied adapter, converts the adapter output into a digest-checked engine result and applies only the persistent `/wurst` change-set.
- `resolveEdgeWasixRuntime(...)` and `createResolvedEdgeWasixPigstyEngine(...)` are the runtime-bundle integration path for Wurster's Edge.js/WASIX engine. They validate a `wurster-edge-runtime` manifest, wire Edge, Wasmer, the Edge/WASIX package and a separate Wasmer cache, then run declared build entries through `edge --safe`.
- `createEdgeWasixPigstyEngine(...)` remains the low-level adapter. It invokes an `edge` binary, rejects host-authority contracts and returns changes through the same engine-result path.
- `pigsty-toolchain/` is the canonical Wurst-carried toolchain root. When present in the Wurst workspace, Pigsty projects it into immutable `/toolchain` so ordinary Node resolution can find Wurst-owned packages without downloading them first.
- Pigsty can publish a successful declared build into a stable Wurst workspace layout under `data/builds/<build>/...`, including a current artifact-store record and hashed generated files.
- Web Wurster reports Pigsty honestly as unavailable for execution. Normal v0.32 Desktop builds report declared Pigsty as `coming-soon` unless a conforming Edge/WASIX bundle is actually present.
- Pigsty is recognized as an explicit runtime capability instead of an unknown capability.

The previous host-Node workspace-projection spike is deliberately not part of Pigsty. A Wurster runtime must not unpack a Wurst into a host temp folder, run ordinary host Node there and call that Pigsty. That model is an implementation smell, not a supported fallback.

## What Pigsty Is For

Pigsty lets a Wurst become powerful inside itself before it receives power over the host system.

Desktop Wurster can ship or reach a maintained Node-compatible runtime. A Wurst can then use tools such as Eleventy, Vite, Vue compiler, TypeScript, Sass or PostCSS without requiring the user to install Node.

The Node-compatible runtime belongs to Wurster. Application-specific packages belong to the Wurst. A Wurst declares the Pigsty version it needs; it does not bundle or demand arbitrary host Node versions.

Pigsty v1 should be implemented as an isolated engine world. Edge.js/WASIX is the current target adapter, but it is not WRST vocabulary. Pigsty defines the environment and security boundary; an engine implements it.

## Engine World

The intended runtime shape is:

```text
WurstFS
   ⇅
Pigsty filesystem projection
   ⇅
Engine sandbox
   ⇅
Node-compatible tools
```

For a Node program inside Pigsty, ordinary APIs should feel ordinary:

```js
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(process.cwd(), 'content.md'), 'utf8');
fs.mkdirSync(path.join(process.cwd(), 'dist'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'dist/index.html'), render(source));
```

But the filesystem it sees is Pigsty's filesystem:

- `/wurst` is the WurstFS-backed workspace.
- `/tmp` is ephemeral scratch for the current run.
- `/toolchain` exposes immutable package directories from Wurst-carried toolchain content.
- no host home directory, app directory, registry, shell or process table is mounted by default.

The engine produces a change-set. Wurster verifies and commits that change-set to WurstFS transactionally. A failed run must not half-write persistent state.

## Manifest

```json
{
  "pigsty": {
      "version": "node-lts-1",
      "tools": ["typescript", "eleventy"],
      "offline": true,
      "toolchain": {
        "root": "pigsty-toolchain"
      },
      "builds": {
      "site": {
        "source": "pigsty-build.js",
        "description": "Build static site output.",
        "outputs": ["dist"]
      }
    }
  }
}
```

This declares intent. It does not grant host access and does not make the Wurst invalid on runtimes without Pigsty.

Engine selection is not a Wurst manifest option. Fields such as `mode: "node"` are rejected. A Wurst asks for Pigsty; Wurster decides how to provide the conforming engine on that platform.

`toolchain.root` is the internal Wurst workspace path that carries offline packages. MeatGrinder also accepts a packaging-only `pigsty.toolchain.source` field in `wurst.json`; that source directory is copied into the Wurst under `toolchain.root`, but `source` is not stored in the final manifest:

```json
{
  "pigsty": {
    "version": "node-lts-1",
    "tools": ["eleventy"],
    "toolchain": {
      "root": "pigsty-toolchain",
      "source": "vendor/eleventy"
    }
  }
}
```

This lets a project keep its build dependencies outside `src/` while the final Wurst still carries them as ordinary internal bytes.

## Runtime API

Desktop Wurster and the headless PigLink harness currently provide a controlled script worker:

```js
const status = await wurst.pigsty.status();
if (status.state === 'available') {
  const result = await wurst.pigsty.run({
    workspace: {
      'src/page.md': '# Hello Pigsty'
    },
    args: { outDir: 'dist' },
    script: `
      Pigsty.define({
        async run(ctx) {
          const source = await ctx.readText('src/page.md');
          await ctx.writeText(ctx.args.outDir + '/index.html', source.replace(/^# (.*)$/m, '<h1>$1</h1>'));
          return { built: true };
        }
      });
    `
  });
}
```

This small worker is useful for tests and narrow scripts. It is not the final Node-compatible toolchain engine.

By default, Desktop and headless PigLink start the Pigsty workspace with the opened Wurst's unencrypted `app` resources. The optional `workspace` object overlays additional or edited files on top of those packaged resources. Pass `includeApp: false` to run against only the explicit request workspace.

The script must call `Pigsty.define({ run(ctx) { ... } })` or `Pigsty.define(async (ctx) => ...)`. `ctx` exposes `readText`, `readBytes`, `writeText`, `writeBytes`, `list`, `remove`, `args` and `policy`.

For Wursts meant to be driven by tools, prefer declared builds over passing raw script strings:

```js
const result = await wurst.pigsty.build('site', {
  args: { draft: false }
});
```

`source` points to a JavaScript file already carried by the Wurst's public app workspace. The build record returned by Pigsty includes the build name, script path, declared outputs, provenance and written artifacts.

If a build declares `outputs`, Pigsty enforces them. A build with `outputs: ["dist"]` may write `dist/index.html` or `dist/assets/app.js`, but writing outside that output tree fails the build. This keeps declared build surfaces meaningful for review, stale detection and future transactional publishing.

## Engine Contracts

`createPigstyEngineContract({ policy, workspace, toolchain, args })` produces a runtime contract for an engine adapter:

```json
{
  "format": "wurst/pigsty-engine-contract-1",
  "runtime": "node-compatible",
  "isolation": "engine-sandbox",
  "engineHint": "edge-wasix",
  "cwd": "/wurst",
  "mounts": [
    { "path": "/wurst", "source": "wurstfs", "writable": true },
    { "path": "/toolchain", "source": "toolchain", "writable": false },
    { "path": "/tmp", "source": "ephemeral", "writable": true, "persistent": false }
  ],
  "capabilities": {
    "hostFilesystem": false,
    "hostProcesses": false,
    "hostShell": false,
    "hostEnvironment": false,
    "network": false,
    "nativeAddons": false
  }
}
```

`createPigstyFileSystemView(...)` expands that contract with the normalized files mounted at each path. This is the serializable shape a future Edge.js/WASIX adapter should consume.

`resolvePigstyPath(path, { cwd, mounts })` applies Pigsty path semantics. Relative paths resolve against `/wurst` by default, mounted paths such as `/toolchain/node_modules/...` are allowed when present, and unmounted paths such as `/etc/passwd` are rejected.

`createPigstyChangeSet(beforeWorkspace, afterWorkspace)` produces `wurst/pigsty-changeset-1` with `add`, `modify` and `delete` operations. `applyPigstyChangeSet(workspace, changeSet)` applies it to a workspace object. WurstFS integration should wrap this in an atomic commit.

`createPigstyEngineResult({ contract, beforeWorkspace, afterWorkspace, tmpWorkspace, result, events })` wraps the persistent change-set with an execution result and a digest of ephemeral `/tmp`. `applyPigstyEngineResult(workspace, engineResult)` refuses to apply the result unless the current workspace digest still matches the source digest.

`runPigstyEngine({ policy, workspace, toolchain, tmp, args, engine })` is the current adapter runner. The `engine` is supplied by the runtime, receives a serializable `wurst/pigsty-fs-view-1` object and returns `{ workspace, tmp, result, events }`. Wurster then creates the engine result, verifies the source digest and applies the change-set.

If `toolchain` is omitted, Wurster extracts it from `workspace[pigsty.toolchain.root + "/..."]` and mounts the stripped files at `/toolchain`. Passing an explicit `toolchain` object overrides that extraction for tests and controlled runtime caches.

Tests use both a mock adapter for the generic boundary and an Edge/WASIX-shaped command runner for the concrete Edge adapter. The important guarantee is that the handoff shape no longer requires host Node, a host shell or Wurst code seeing the host filesystem.

## Edge/WASIX Adapter

`createResolvedEdgeWasixPigstyEngine(...)` is the preferred runtime adapter for the intended production engine lane:

```js
import { createResolvedEdgeWasixPigstyEngine, runPigstyEngineBuild } from '@wurster/pigsty';

const engine = await createResolvedEdgeWasixPigstyEngine();

const result = await runPigstyEngineBuild({
  policy: manifest.pigsty,
  build: 'site',
  workspace,
  engine
});
```

For a declared build, `runPigstyEngineBuild(...)` passes the build source as `args.entry`, invokes the adapter and enforces the declared `outputs` against the returned change-set. A build that writes outside `outputs` fails even if the engine process exits successfully.

The adapter launches `edge --safe <entry>` without a shell. The preferred production input is a single unpacked Wurster Edge runtime bundle:

```bash
WURSTER_EDGE_RUNTIME_DIR=/opt/wurster/runtimes/wurster-edge-runtime-linux-amd64
WURSTER_EDGE_CACHE_DIR=/var/cache/wurster/pigsty/edge
```

`WURSTER_EDGE_RUNTIME_DIR` must point at a directory with this shape:

```text
manifest.json
bin/edge
bin/wasmer
share/edge-wasix/wasmer.toml
share/edge-wasix/edgejs.wasm
```

The manifest name must be `wurster-edge-runtime`, its `target` must match the current platform target, and it must list the required files. Runtime packagers can request full file hash verification through `resolveEdgeWasixRuntime({ verifyHashes: true })`. The Wasmer cache lives outside the immutable runtime directory; otherwise first-run compilation would mutate the shipped bundle.

Desktop Wurster also prepares automatic lookup for packaged runtimes. If no explicit runtime directory is set, it checks app resources for `runtimes/wurster-edge-runtime-<target>`, where targets currently follow names such as `linux-amd64`, `darwin-arm64`, `darwin-amd64` and `windows-amd64`. This keeps the final application install self-contained while preserving the same bundle contract used by headless tests and release CI.

`probeResolvedEdgeWasixPigstyEngine(...)` checks both the bundle contract and a tiny `edge --safe -e ...` run, because a binary can exist while the Safe/WASIX side is unusable due to a missing or mismatched Wasmer runtime. The Safe probe uses the normal 60 second engine timeout rather than a cheap ping timeout because a fresh Wasmer cache may compile the WASIX guest on first launch.

The production artifact contract is deliberately stricter than "an Edge binary exists":

- a native Edge host binary for the platform
- a matching Edge/WASIX package
- a Wasmer host capable of the Edge N-API extension imports required by that WASIX package
- a manifest with file hashes so Wurster can prove what it is about to execute

These artifacts must be built from a compatible Edge.js/Wasmer line. A normal Wasmer binary can run many WASIX programs, but that does not guarantee it can host Edge's engine-free N-API package. Wurster therefore treats Safe probing as normative: `edge --version` proves only that the launcher exists; `edge --safe -e 'console.log(...)'` proves that Pigsty's Node-compatible interior can actually start.

The older loose wiring remains useful for development and diagnosis:

```bash
WURSTER_EDGE_BIN=/opt/wurster/edge/bin/edge
WASMER_BIN=/opt/wurster/edge/bin/wasmer
WASMER_DIR=/opt/wurster/edge/wasmer
EDGE_WASMER_PACKAGE=/opt/wurster/edge/share/edge-wasix
```

`probeEdgeWasixPigstyEngine({ env })` and `createEdgeWasixPigstyEngine({ env })` both accept these values explicitly. If the Safe probe fails with missing files from the WASIX package or unknown imports such as `napi_extension_wasmer_v0`, the runtime must report Pigsty Edge/WASIX as unavailable rather than falling back to host Node.

Desktop Wurster and headless PigLink can request this lane with `wurst.pigsty.build("site", { engine: "edge-wasix" })`. Setting `WURSTER_PIGSTY_ENGINE=edge-wasix` makes it the default Pigsty build engine for those runtimes. If Edge is requested but the binary is unavailable, Wurster fails the build explicitly instead of falling back to the development worker.

When `/toolchain/node_modules` exists, the adapter projects it into the staged `/wurst/node_modules` position so ordinary Node package resolution works from build scripts. The current Edge Safe CLI boundary treats the staged workspace as the visible filesystem root and blocks symlink escapes out of it, so this projection is materialized as temporary files rather than as an outward symlink. The projection is removed before collecting persistent `/wurst` changes, so Wurst-carried toolchain packages do not become generated workspace output.

The current adapter uses a runtime-owned staging directory to feed Edge a normal filesystem tree for `/wurst`, `/toolchain` and `/tmp`, then collects the changed `/wurst` tree back into a Pigsty engine result. It invokes the build entry relative to the staged `/wurst` cwd. This staging area is an implementation detail of the runtime adapter, not a host workspace exposed to Wurst code and not a host-Node fallback. It exists because the current CLI-shaped Edge boundary consumes filesystem paths. A tighter future embedding can replace this staging layer without changing the Pigsty contract.

Edge runs through a tiny runtime-owned `.pigsty-runner.mjs` wrapper inside the staged `/wurst` view. The wrapper starts ordinary Node-style build scripts unchanged. If a carried script uses the earlier worker style, `Pigsty.define(async ctx => ...)`, the wrapper provides a compatible `ctx` with `readText`, `readBytes`, `writeText`, `writeBytes`, `list`, `remove` and `args`. The wrapper is removed before persistent `/wurst` changes are collected, so it never becomes Wurst output.

Pigsty v1 still rejects native Node addons (`.node`) before invoking Edge. Edge may support native modules inside WASIX, but Wurster's portability line remains stricter until WRST has a tested policy for them.

## Desktop Runtime Bundles

Pigsty's Edge.js/WASIX engine is a Wurster runtime dependency, not a Wurst dependency and not a binary payload that belongs in the Wurster Lab Git history. Desktop packaging uses a small pinned acquisition contract:

```text
runtime/edge-runtime.lock.json
        ↓
WRST-IO/wurster-edge-runtime tagged GitHub Release
        ↓  archive SHA-256 + manifest file hashes
runtime/desktop/runtimes/wurster-edge-runtime-<target>/
        ↓  Electron extraResources
resources/runtimes/wurster-edge-runtime-<target>/
        ↓
Desktop Wurster automatic discovery
```

The lock is pinned to the Edge runtime version independently from the Wurster application version. The current integration target is `v0.1.0-dev.2`. The downstream runtime pipeline already defines Linux amd64, Darwin arm64 and Windows amd64 output; the `darwin-amd64` slot is reserved by the same naming contract and intentionally keeps Wurster's Intel-macOS release gated until that runtime bundle exists.

The lock currently defines these release assets:

```text
wurster-edge-runtime-linux-amd64.tar.gz
wurster-edge-runtime-darwin-arm64.tar.gz
wurster-edge-runtime-darwin-amd64.tar.gz
wurster-edge-runtime-windows-amd64.zip
SHA256SUMS
```

Every archive must contain exactly one top-level `wurster-edge-runtime-<target>` directory with its own `manifest.json`. The staging tool verifies the release archive checksum and then every file hash declared by that bundle manifest before Electron Builder can consume it. Staged binaries live below the gitignored `runtime/desktop/runtimes/` directory and are never transfer-package source files.

The acquisition path is prepared but intentionally **opt-in** for the current v0.32 release lane. A normal `npm run dist:win` or macOS distribution build does not download an Edge runtime and therefore remains buildable while the native runtime team finishes its platform bundles. Set `WURSTER_BUNDLE_PIGSTY=1` only for an explicit Pigsty packaging/conformance build; a universal macOS Pigsty build then stages both `darwin-arm64` and `darwin-amd64` and Desktop chooses the directory matching `process.arch` at execution time.

`WRST-IO/wurster-edge-runtime` is public, so normal release-asset acquisition does not require a private token. `WURSTER_EDGE_RUNTIME_TOKEN` remains an optional API-rate-limit/developer override. `WURSTER_EDGE_RUNTIME_TAG` and `WURSTER_EDGE_RUNTIME_REPOSITORY` can override the committed lock for development, and `WURSTER_EDGE_RUNTIME_SOURCE_DIR` can point at already unpacked bundles for offline/local packaging.

The normal tagged Wurster v0.32 workflow currently publishes Windows, macOS and Web without Pigsty native-runtime gates. The Pigsty adapter and bundle-verification tests still run in the repository test suite. Once the complete native bundle set is accepted, release packaging can enable `WURSTER_BUNDLE_PIGSTY=1` and restore platform-native smoke gates without changing the package format or acquisition contract.

## Provenance And Publication

Each successful run returns deterministic build provenance:

```json
{
  "provenance": {
    "format": "wurst/pigsty-provenance-1",
    "runtime": "node-lts-1",
    "sourceDigest": {
      "format": "wurst/pigsty-workspace-digest-1",
      "algorithm": "sha256",
      "files": 2,
      "bytes": 1234,
      "sha256": "..."
    },
    "outputDigest": {
      "format": "wurst/pigsty-workspace-digest-1",
      "algorithm": "sha256",
      "files": 3,
      "bytes": 5678,
      "sha256": "..."
    }
  }
}
```

`assessPigstyBuildRecord(record, workspace)` compares a stored build record with a current workspace and returns `fresh`, `stale` or `invalid`.

`assessPigstyArtifactStore(store, buildName, { sourceWorkspace, artifactWorkspace })` checks both the source digest and the written artifact hashes. It returns `fresh`, `stale`, `missing` or `invalid`.

`createPigstyBuildPublication(buildResult, { store, root })` turns a successful declared build into a portable file set:

```text
data/builds/<build>/artifacts/<declared-output-files>
data/builds/<build>/current.json
```

The stored build record keeps each authored artifact path and adds the persisted `storedPath`, so tools can understand that `dist/index.html` was the declared output while verifying the bytes actually stored at `data/builds/site/artifacts/dist/index.html`.

## Boundary

The Pigsty workspace is inside the Wurst. It may read and write Wurst-owned project files, generated artifacts and runtime build cache that Wurster exposes to that Pigsty session.

It does not automatically receive:

- host filesystem paths;
- host shell or process execution;
- network access;
- another Wurst's WurstFS realms;
- another Wurst's Pigsty;
- private signing keys, Meatphrases or WurstKeys.

The fence matters: the sty belongs to the Wurst, not to the host.

## Permissions

A package signature identifies a publisher. It never grants Pigsty.

For early Pigsty versions, permission should be bound to the immutable digest of the exact Wurst. A new version asks again unless the user explicitly creates a broader publisher policy.

Unsigned Wursts remain first-class. An unsigned local Wurst may use Pigsty when the user allows it; a perfectly signed unknown Wurst still receives no extra authority by being signed.

## npm And Portability

Node availability and npm package installation are separate operations.

A Wurst may carry an offline toolchain and run it inside Pigsty. Downloading new packages and executing them is a higher-risk action and needs its own policy. Lockfiles and integrity hashes should define expected dependencies.

Pigsty v1 keeps a hard portability line:

- JavaScript: yes.
- Portable WebAssembly: yes.
- Native Node addons, `node-gyp`, FFI and platform-specific `.node` binaries: no.

Otherwise Pigsty would undermine the Universal Runtime Law.

See [Build Artifacts](build-artifacts.md).
