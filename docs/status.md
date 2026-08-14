---
title: Current status
group: Project
groupOrder: 6
order: 1
---

# Current status

Wurster Lab is pre-1.0 software. Implementation code can exist before a feature is part of the normal release contract, so this page is the canonical short answer for what a current v0.32 runtime is expected to provide.

## Release surfaces

| Surface | v0.32 release status | Notes |
| --- | --- | --- |
| Windows Desktop | Release lane | Built from the shared Electron runtime. Pigsty native runtime is not bundled by default. |
| macOS arm64 | Release lane | Signed/notarized release workflow. Pigsty native runtime is not bundled by default. |
| macOS x64 | Release lane | Separate Intel build/signing lane. Pigsty native runtime is not bundled by default. |
| Wurster Web | Release lane | Browser runtime and `<wurst-embed>` distribution. |
| Linux Desktop | Prepared development lane | AppImage build path exists; public release enablement is separate. |
| iOS / Android | Reserved | No conforming native runtime release yet. |

## PigLink

**Functional slice, active in v0.32.** MeatGrinder packages the declared PigLink source and schemas. Desktop, Web/headless-facing paths and the headless harness can invoke Actions, validate JSON contracts and capture Events. UI code can call the same Action contract through `wurst.piglink`.

Still before the first stable PigLink contract: brokered links between separate running Wurst instances, runtime handles, link lifecycle/revocation, streams/resource handles and capability-composition approval.

## Piglet

**Functional composition runtime, active in v0.32 development.** Built-in child bytes remain independently signed and byte-identical. Desktop additionally discovers normal `.wurst`/`.wrst` files stored in readable WurstFS realms, can install exact dropped Wurst bytes into ordinary WurstFS, and runs children as managed `WebContentsView` surfaces with move/resize/focus/close handles. Child WurstFS writes persist transactionally back into the parent-held child file, and sealed/protected children use child-scoped Wurster Auth surfaces. Wurster Web keeps the built-in-child internal-session path.

Still before the first stable Piglet contract: suspend/resume and tree-level resource budgets, direct brokered PigLink handles to child instances, Wurster-owned trust/revocation presentation for shell UIs, and equivalent runtime-installed managed surfaces on Web.

## Pigsty

**Experimental, coming soon in normal Desktop releases.** The manifest contract, worker development harness, engine-neutral filesystem/change-set contracts, Edge/WASIX adapter, runtime-bundle verifier and native-runtime acquisition tooling remain in the repository and under tests.

The v0.32 Windows/macOS/Web release workflow deliberately does not require or download native Pigsty bundles. Desktop reports a declared Pigsty as `coming-soon` unless a conforming Edge/WASIX runtime is actually available or the development worker is explicitly enabled. This prevents Pigsty's native-runtime work from blocking unrelated Wurster releases.

The worker path is development-only. Enable it explicitly with `WURSTER_PIGSTY_DEV=1` or `WURSTER_PIGSTY_ENGINE=worker`. Native runtime packaging is also opt-in with `WURSTER_BUNDLE_PIGSTY=1`; this is not part of the normal v0.32 release gate yet.

## Structural rule

Large runtime modules are being split before the Piglet/PigLink lifecycle work grows further. `npm test` includes a code-structure regression with temporary line/IPC budgets for known large modules. The budgets are guard rails, not declarations that the remaining large modules are finished refactors.
