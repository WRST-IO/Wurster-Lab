---
title: Build Artifacts
group: Building Wursts
groupOrder: 3
order: 5
---
# Build Artifacts

A Wurst can carry authored source and derived runtime artifacts at the same time.

Examples:

- Markdown or Eleventy source that produces HTML.
- Vue or TypeScript source that produces JavaScript.
- Sass or PostCSS source that produces CSS.
- Asset sources that produce optimized images or bundles.

Those layers must not silently drift apart.

## Artifact Provenance

A built artifact should record:

- source state digest;
- build toolchain identity and version;
- build settings;
- created time;
- target runtime expectation.

When source changes on a platform without Pigsty, the existing built artifact may still run, but Wurster can report it as stale.

Pigsty run results emit the runtime-level provenance format:

- `wurst/pigsty-workspace-digest-1` summarizes a virtual workspace by file count, byte count and a SHA-256 digest over sorted file path/content hashes.
- `wurst/pigsty-provenance-1` records source digest, output digest, Pigsty runtime/toolchain policy and created time.
- Each written artifact is listed with path, encoding, byte size and SHA-256.

That metadata is the contract persistent artifact records use.

## Stale Detection

A Pigsty build record can be checked against a current workspace with `assessPigstyBuildRecord(...)`.

The result is:

- `fresh`: the current source digest still matches the build record.
- `stale`: the source digest changed, so generated artifacts may still run but no longer prove they came from the current source.
- `invalid`: the stored record is missing or malformed.

This deliberately does not delete or replace artifacts. It gives Wurster and Wurst tools a precise signal for UI, automation and future transactional rebuilds.

## Artifact Store

`wurst/pigsty-artifact-store-1` is the first small store contract for Pigsty build records:

```json
{
  "format": "wurst/pigsty-artifact-store-1",
  "builds": {
    "site": {
      "format": "wurst/pigsty-build-record-1",
      "name": "site",
      "source": "pigsty-build.js",
      "declaredOutputs": ["dist"],
      "provenance": {},
      "artifacts": []
    }
  }
}
```

The helper functions are:

- `createPigstyArtifactStore(records)` creates a normalized empty or seeded store.
- `upsertPigstyBuildRecord(store, buildResultOrRecord)` inserts the latest record for a build name.
- `assessPigstyArtifactStore(store, buildName, { sourceWorkspace, artifactWorkspace })` returns a build status.

Store status values:

- `fresh`: source digest and artifact hashes still match.
- `stale`: source changed, while artifacts may still exist.
- `missing`: no build record or at least one artifact is absent.
- `invalid`: the record is malformed or an artifact hash no longer matches.

This store is intentionally data-shaped. It can live in PigFS later without changing the build-record semantics.

## Publishing Build Output

`wurst/pigsty-publication-1` is the first functional publication layer for successful declared builds.

Given a Pigsty build result, `createPigstyBuildPublication(buildResult, { store, root })` produces a deterministic set of workspace files:

```text
data/builds/<build>/artifacts/<artifact-path>
data/builds/<build>/current.json
```

The artifact bytes are copied from the build workspace into the publication artifact root. The `current.json` file is a `wurst/pigsty-artifact-store-1` record whose artifacts keep both paths:

- `path`: the declared build output path, such as `dist/index.html`.
- `storedPath`: the persisted workspace path, such as `data/builds/site/artifacts/dist/index.html`.

`applyPigstyPublication(workspace, publication)` applies the publication to a workspace object. `assessPigstyArtifactStore(...)` then verifies published artifacts by `storedPath` while still reporting the authored output `path`.

This gives Wurster the core transaction unit it needs: build output can be assembled and verified before a future PigFS commit makes it current.

## Transactional Builds

Pigsty builds should publish derived output transactionally. A failed build must not replace a known-good artifact set.

The ordinary rule mirrors PigFS compaction and migration:

```text
write new result, verify it, then make it current
```

The current helper layer implements the "write new result" and "verify it" parts in memory. Desktop Wurster still needs the final PigFS commit wrapper before app UIs can make published artifacts durable inside an opened `.wurst` file.

## Engine Change-Sets

Pigsty engines return persistent filesystem mutations as `wurst/pigsty-changeset-1`:

- `add`: a new PigFS-backed file appeared.
- `modify`: an existing PigFS-backed file changed.
- `delete`: an existing PigFS-backed file was removed.

`wurst/pigsty-engine-result-1` wraps that change-set with the engine result, events and a digest of ephemeral `/tmp`. Applying an engine result requires the source workspace digest to still match, so Wurster can reject stale or reordered commits instead of merging engine output into the wrong Wurst state.

`runPigstyEngine(...)` is the current adapter boundary for this flow. It gives the runtime engine a normalized Pigsty filesystem view and turns the returned workspace into an engine result. The Edge.js/WASIX lane now has a manifest-checked Wurster Edge runtime bundle path, while the transactional return path remains engine-neutral and covered by regression tests.

`runPigstyEngineBuild(...)` applies the same flow to a declared Pigsty build. It passes the declared build source to the engine as `args.entry`, enforces declared outputs against the returned change-set and emits a normal `wurst/pigsty-build-record-1`.

`createResolvedEdgeWasixPigstyEngine(...)` is the production-shaped adapter entry for this flow. It resolves a `wurster-edge-runtime` bundle, runs `edge --safe` without a shell, then returns Edge's changed `/wurst` filesystem through the same engine result contract. `createEdgeWasixPigstyEngine(...)` remains the lower-level adapter for tests and local diagnostics.

Engine-build provenance records the source digest, output digest and the digest of the immutable toolchain workspace. This lets Wurster distinguish "source changed" from "same source, different carried build tools".

## Packaging And Signing

Builder Wursts may request packaging. Only Wurster may request the user's signature.

A builder such as WurstFlow or WurstDesigner produces source, assets and build metadata. It hands that result to Wurster's canonical MeatGrinder service. Wurster creates an unsigned Wurst first. The user can then choose, in trusted Wurster UI, whether to sign it with their publisher identity.

The builder never sees the private publisher key.
