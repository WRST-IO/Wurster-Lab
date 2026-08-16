# Wurster Lab 0.33.2

Wurster Lab is the build, runtime, format, test and documentation workspace for **Wurst**: a portable software format for useful tools, workflows and applications. A Wurst gives software a world of its own without giving it the user's computer.

```text
project folder → MeatGrinder → .wurst / .wrst → Wurster
                                      │
                         Desktop · Web · future runtimes
```

## Wurst law

> A valid Wurst is platform-independent. Conforming runtimes implement the same Wurst semantics even when their host implementation differs.

Platform machinery such as Apple Keychain, Windows Hello or a native keystore belongs to Wurster, never to the portable Wurst contract.

## Runtime pillars

- **PigFS stores.** Portable files, state, realms, transactions, snapshots and stable object identity.
- **PigLink connects.** Declared Actions and Events form the machine-facing API of a Wurst.
- **Piglet composes.** Wursts can contain and cooperate with other independently identified Wursts. `<wurst-embed>` is the human View path; `wurst.piglet.connect()` / `invoke()` are the machine path.
- **Pigsty computes.** Isolated build/transform work over Wurst-owned files. The native Edge/WASIX runtime is still experimental and does not block normal releases.

The hard security boundary is Wurst ↔ Host. Inside a Wurst world, cooperation is expected. Parent PigFS and Piglet management may be explicitly delegated, but Host filesystem, shell/process/environment and Wurster secrets never become ambient authority.

## One Wurst, two ends

A Wurst may have human Views and machine clients at the same time. Multiple Views of the same PigFS-held Wurst share one durable Wurst world while keeping ephemeral DOM/UI state local to each View. Machine clients address the same durable session rather than creating a second Wurst copy.

The remaining parity gap in 0.33.2 is cross-process attachment: a separately launched CLI/MCP process cannot yet discover and join a Desktop/Web-owned session that is already running in another Wurster process.

## Workspace

- `packages/format` - WRST v7 container, signing, sources and crypto primitives.
- `packages/pigfs` - portable filesystem semantics.
- `packages/interface` - `@wurster/piglink` Actions/Events contract.
- `packages/piglet` - relationships, sessions, delegation and authority composition.
- `packages/pigsty` - isolated-compute contracts and adapters.
- `packages/headless` - browserless developer/automation harness.
- `packages/meatgrinder` - Wurst builder and signing tools.
- `runtime/desktop` / `runtime/web` - conforming runtime implementations.
- `docs` - canonical documentation source. `site` is the generated wrst.io surface.

## Install and test

```bash
npm install
npm test
```

Runtime builds:

```bash
npm run dist:win
npm run dist:mac:arm64
npm run dist:mac:x64
npm run dist:linux
npm run runtime:web:build
```

Normal Wurster packaging does not require Pigsty native runtime bundles. Edge/Wasmer release inputs come from `WRST-IO/wurster-edge-runtime`, not from binaries committed to Wurster Lab.

## Release status

0.33.2 is a pre-1.0 integration release intended for real application work such as WurstOS testing:

| Pillar | Status |
| --- | --- |
| PigFS | functional / pre-stable |
| PigLink | functional / pre-stable |
| Piglet | functional / pre-stable |
| Pigsty | experimental / coming soon |

See `docs/status.md` for the exact boundary and `docs/security-model.md` for the Host fence.

## Project and licensing

Wurster is an independent software project published at `wrst.io`. Wurster Lab is pre-1.0 software under the **Apache License, Version 2.0**. Trademark and brand rights remain separate. See `LICENSE.md`, `NOTICE` and `docs/licensing.md`.
