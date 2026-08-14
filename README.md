# Wurster Lab 0.32.2

Wurster Lab is the build, runtime, format, test and documentation workspace for Wurst: a portable mini-app container with controlled runtime capabilities, PigFS, signing, streaming and optional portable protection.

```text
HTML / CSS / JavaScript
          ↓
     🥩 MeatGrinder
          ↓
   .wurst / .wrst
          ↓
 ┌────────┼────────┐
 ▼        ▼        ▼
Desktop   Web    future native
Wurster  Wurster  Wursters
```


## ⚖️ Wurst law

> A valid Wurst is platform-independent. Conforming runtimes implement the same Wurst semantics even when their host-platform implementation differs.

Wurst packages never encode Apple Keychain, Windows Hello, Secure Enclave, Android Keystore or other platform-specific machinery. Those belong to individual Wurster runtimes.

## 🧰 Workspace

- `packages/format` — WRST v7, current PigFS realms, Wurster Identity crypto, publisher signing, random-access sources and carrier primitives.
- `packages/interface` — portable PigLink Actions/Events contract package (`@wurster/piglink`).
- `packages/headless` — developer/AI browserless harness.
- `packages/meatgrinder` — Wurst builder and signing tools.
- `runtime/desktop` — shared Electron desktop implementation.
- `runtime/windows` — Windows build output and platform notes.
- `runtime/mac` — macOS build output and platform notes.
- `runtime/linux` — prepared Linux desktop build output and platform notes.
- `runtime/web` — browser Wurster runtime and distributable `<wurst-embed>` stack.
- `runtime/ios` / `runtime/android` — reserved native-runtime homes.
- `docs` — canonical 11ty-ready documentation source.
- `site` — wrst.io documentation/site surface generated from the canonical docs.


## 🧭 Project status and licensing

Wurster is an independent software project published at `wrst.io`; WRST.IO is the project identity and website, not a company or incorporated organization. Wurster Lab is pre-1.0 software and is licensed under the **Apache License, Version 2.0**. Trademark and brand rights remain separate from the software license. See `LICENSE.md`, `NOTICE` and `docs/licensing.md`.

## 🧪 Install and test

```bash
npm install
npm test
```

## v0.32 release lane

The v0.32 line stabilizes the current Wurst runtime around four named runtime pillars:

- **PigFS stores:** portable files, state, realms, transactions, snapshots and object identity inside the Wurst.
- **PigLink connects:** declared Actions/Events already run through UI, Desktop and headless paths; direct cross-Wurst handles are next.
- **Piglet composes:** `<wurst-embed>` is the universal Wurst embedding element in Web and inside running Wursts; a nested embed becomes a Piglet without native view geometry APIs. A parent may explicitly delegate its own PigFS to one child with `parent-pigfs="read"` or `parent-pigfs="read-write"`; no ambient parent access exists.
- **Pigsty computes:** still experimental and **not bundled in normal v0.32 Desktop releases yet**. Its Edge/WASIX work stays independent of Windows/macOS/Web release availability.

See `docs/status.md` for the current maturity matrix instead of inferring feature readiness from the presence of implementation code.

## 🏗️ Runtime builds

```bash
npm run dist:win
npm run dist:mac:arm64
npm run dist:mac:x64
npm run dist:mac:universal
npm run dist:linux
npm run runtime:web:build
```

Desktop artifacts are written below `runtime/windows/dist/`, `runtime/mac/dist/` and `runtime/linux/dist/` instead of living beside the shared Electron source. Normal v0.32 packaging does not download or require Pigsty native runtimes. The prepared Edge-runtime acquisition path remains available for development and can be opted into with `WURSTER_BUNDLE_PIGSTY=1` once the platform bundle set is release-ready; Edge/Wasmer binaries remain release inputs from `WRST-IO/wurster-edge-runtime`, never files committed to Wurster Lab.

## 🔐 Release signing

Copy `.env.signing.example` to `.env.signing.local` and fill only the credentials needed by the platform you are building. The local file, `.p12` and `.pfx` material are gitignored. macOS Developer ID/notarization and Windows Authenticode are release concerns for the Wurster runtime itself and are completely separate from Wurst publisher signatures.

See `docs/release-signing.md`.

## 🗃️ PigFS: simple by default, federated when asked

PigFS keeps the realm/identity foundation while removing the assumption that ordinary mutable data needs a special filesystem mode or signed history. PigFS is now a capability ladder:

```text
ordinary  normal mutable data, no identity/signature/history; no manifest mode needed
personal  owner-only sealed data, non-shareable, no history
shared    optional federated read/write/admin policy and signed integrity
```

`audit: signed` is an additional opt-in for applications that intentionally need operation history. It is not the default price of using PigFS.

History-free ordinary/personal Wursts can be compacted back to their current live data, including encrypted personal data when unlocked. Large writes are streamed as concurrent transactions: unrelated small saves may commit while a long import is still running, while same-object races are detected as conflicts. Append-first is therefore a crash-safety strategy, not a promise that a Wurst must grow forever.

`WursterLab.wurst` is the project's own self-hosting handoff Wurst: the source tree lives in ordinary mutable storage, notes travel alongside it, and WRST.IO operator material can live in a separate personal sealed realm that an updater does not need to unlock. See `docs/wurster-lab-wurst.md`.

Shared governance retains Wurster Identity based Ed25519 authorization and optional X25519 sealed sharing. A public `.wurstid` can still be exchanged before the recipient ever opens the Wurst. See `docs/pigfs.md` and `docs/wurster-identities.md`.

## 🌐 Wurster Web

`runtime/web/dist/` now contains the browser runtime, service worker and the CDN-friendly `<wurst-embed>` host. Wurster Web 0.32.2 opens local or HTTP Range-backed WRST v7, runs public, partial and fully WurstKey-sealed application content, keeps normal relative resource URLs intact, and gives plain PigFS a chunk-backed browser overlay with ranged reads, streaming writes and standalone snapshot export.

A site can host the runtime distribution together and embed a Wurst with `<wurst-embed src="./example.wurst">`. The embed host keeps its service worker on the Wurster distribution origin and streams Wurst byte ranges from the parent page over `MessageChannel`, so embedding does not require a root service worker on every consuming site. The official 11ty site receives the same generated runtime automatically and exposes `/viewer/` as a drag-and-drop online Wurst viewer.

Personal/shared PigFS realm crypto, the authenticated Desktop↔Web identity return leg, live DNS/local-trust presentation parity and Undercover PNG adaptation remain pre-1.0 browser parity work. WRST.IO Authority certificate chains are already verified offline in both Desktop and Web.

## 🛡️ WRST.IO Authority

`wrst.io` is the official project domain. Wurster ships a pinned public WRST.IO Root Authority and a root-signed trust bundle; normal Authority certificate verification is offline. The Root private key is derived only from an operator-held 24-token Root Meatphrase and is never deployed. A separate rotatable issuer powers the stateless `authority.wrst.io` Cloudflare Worker.

The repository ships a marked development Root for tests. Before production, run `npm run authority:bootstrap` on the trusted operator machine, print/store the Root Meatphrase and fingerprint offline, then require `npm run authority:production-check` before V1 release. WRST.IO certificates are claim-based: DNS can attest a domain and the optional mail service can attest an email address with a six-digit code from `oink@wrst.io`; labels remain self-declared unless a future proof method explicitly verifies them. See `docs/authority.md` and `authority/wrst.io/README.md`.
