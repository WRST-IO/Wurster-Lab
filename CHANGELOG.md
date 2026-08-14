# Changelog

## 0.32.0 r008 - Clean Stall Release Lane

- Decoupled normal Windows, macOS and Web releases from Pigsty native-runtime availability. Tagged v0.32 releases no longer download Edge/Wasmer bundles or wait for platform Pigsty smoke jobs.
- Desktop Edge-runtime packaging is now explicit opt-in through `WURSTER_BUNDLE_PIGSTY=1`. The pinned public `WRST-IO/wurster-edge-runtime` acquisition/verification path stays in-tree for conformance builds without making Pigsty a release blocker.
- Desktop Pigsty now reports declared Pigsty as `coming-soon` when no conforming Edge/WASIX runtime is available. The small worker engine is development-only and requires `WURSTER_PIGSTY_DEV=1` or an explicit worker-engine selection.
- Split Desktop Piglet, PigLink and Pigsty IPC/runtime ownership out of `runtime/desktop/src/main.mjs`. PigLink now owns pending invocation state and cleanup; Piglet owns child lookup/integrity; Pigsty owns engine discovery/status/build routing.
- Split Desktop web-sandbox request/CSP/range/partition helpers out of `main.mjs`, reducing the central Electron module and giving its remaining responsibilities a temporary code-size/IPC regression budget.
- Added `tests/code-structure.test.mjs` so known large modules cannot silently grow past their current cleanup budgets and Pig IPC ownership cannot drift back into the Desktop bootstrap module.
- Added canonical `docs/status.md` and corrected Piglet/PigLink/Pigsty docs to distinguish working slices from planned runtime lifecycle/broker/native-engine work.
- Reconciled project licensing documentation with the current Apache-2.0 repository license and corrected the canonical WRST-IO repository link.

## 0.32.0 - Pigsty Learns To Build

- Added `@wurster/pigsty`, a controlled Node-backed worker that runs Pigsty scripts against a virtual Wurst workspace. The worker exposes text/byte read-write primitives and returns derived workspace files, results, writes and console events without exposing host `fs`, shell, `process` or network APIs.
- Desktop Wurster now reports declared Pigsty as available and exposes `wurst.pigsty.run({ script, workspace, args, timeoutMs })` through the preload bridge. Web Wurster keeps the same status surface but rejects execution explicitly because browsers do not carry the Node-backed Pigsty worker.
- The headless PigLink harness now exposes the same controlled `wurst.pigsty.status()` and `wurst.pigsty.run(...)` surface, so machine callers can drive Pigsty-capable Wursts through PigLink without a visible UI.
- Pigsty policies can now declare named builds under `pigsty.builds`. Desktop and headless runtimes expose `wurst.pigsty.build(name, request)` so Wursts can run packaged build scripts from their own app workspace instead of passing ad hoc script strings.
- Removed the host-Node workspace-projection spike from the Pigsty direction. Pigsty no longer treats `mode: "node"` as a valid manifest/runtime path; engine selection is a Wurster implementation detail, not Wurst vocabulary.
- Added `wurst/pigsty-engine-contract-1` to describe the intended internal runtime world: `/wurst` as WurstFS-backed workspace, `/tmp` as ephemeral scratch, no host filesystem, no host shell, no host processes and no host environment.
- Added `wurst/pigsty-fs-view-1` plus Pigsty path resolution helpers so future engine adapters receive a concrete mount view for `/wurst`, optional `/toolchain` and `/tmp` without seeing host paths.
- Added `wurst/pigsty-changeset-1` and `wurst/pigsty-engine-result-1` helpers so future engine adapters can return `add`, `modify` and `delete` operations that Wurster can verify and commit to WurstFS transactionally.
- Added `runPigstyEngine(...)`, the first executable engine-adapter boundary. It hands a normalized Pigsty filesystem view to a runtime-supplied adapter, converts adapter output into a digest-checked engine result and applies only the persistent WurstFS change-set. Regression coverage uses a mock Edge/WASIX-shaped adapter while the production adapter remains follow-up work.
- Added `createEdgeWasixPigstyEngine(...)`, `probeEdgeWasixPigstyEngine(...)` and `runPigstyEngineBuild(...)`. Pigsty can now invoke a concrete Edge.js/WASIX adapter through `edge --safe`, enforce declared build outputs against returned change-sets, reject native `.node` addons for v1 portability and report missing Edge binaries cleanly.
- Added a pinned Wurster Edge runtime acquisition layer for desktop packaging. `runtime/edge-runtime.lock.json` names the tagged `WRST-IO/wurster-edge-runtime` release assets, while `tools/wurster-edge-runtime.mjs` downloads them, verifies `SHA256SUMS` plus every bundle-manifest file hash and stages only the requested platform below the gitignored desktop runtime directory.
- Electron desktop packages now carry staged Pigsty runtimes through `extraResources`, so installed Wurster discovers `resources/runtimes/wurster-edge-runtime-<target>` without end-user environment variables. Windows x64, macOS arm64/x64 and a prepared Linux x64 build lane share the same staging contract; universal macOS carries both native runtime bundles.
- The tagged Wurster release workflow now expects a read token when the parallel Edge runtime repository is private, runs a real Linux-amd64 Edge/WASIX gate, and repeats the real Pigsty Edge smoke test against the staged macOS and Windows bundles before publishing. Runtime binaries remain release inputs instead of permanent Wurster Lab repository cargo.
- Pigsty now recognizes `pigsty-toolchain/` as the canonical Wurst-carried toolchain root. MeatGrinder can package `pigsty.toolchain.source` into that root, Edge builds auto-project it into immutable `/toolchain`, and `/toolchain/node_modules` is linked into the staged `/wurst/node_modules` position for ordinary Node resolution without runtime npm downloads.
- Desktop and headless Pigsty status now probes Edge/WASIX availability instead of reporting it optimistically. Edge is selectable and testable, but unavailable binaries are surfaced as unavailable rather than silently falling back.
- Desktop and headless PigLink builds can now request `engine: "edge-wasix"`, or use `WURSTER_PIGSTY_ENGINE=edge-wasix` as the default. Requested Edge builds fail loudly when the Edge binary is unavailable; they do not silently fall back to the development worker.
- The Edge/WASIX adapter links `/toolchain/node_modules` into the staged `/wurst/node_modules` position for ordinary Node package resolution, then skips that link when collecting persistent WurstFS changes so toolchain packages do not become authored output.
- Declared Pigsty build outputs are enforced. A named build that declares `outputs: ["dist"]` fails if it writes artifacts outside that output tree.
- MeatGrinder now uses the shared Pigsty policy normalizer from `@wurster/pigsty`, keeping manifest validation and runtime execution on one contract.
- Pigsty run results now include deterministic build provenance: source workspace digest, output workspace digest, toolchain summary, creation time and per-written-artifact SHA-256 metadata.
- Added `assessPigstyBuildRecord(...)` for source-digest stale detection. Stored Pigsty build records can now be checked against a current workspace and reported as `fresh`, `stale` or `invalid`.
- Added `wurst/pigsty-artifact-store-1` helpers for build status tracking. `createPigstyArtifactStore(...)`, `upsertPigstyBuildRecord(...)` and `assessPigstyArtifactStore(...)` classify builds as `fresh`, `stale`, `missing` or `invalid` using both source digests and artifact hashes.
- Added `wurst/pigsty-publication-1` helpers for publishing declared build output into a stable Wurst workspace layout. `createPigstyBuildPublication(...)` writes generated files under `data/builds/<build>/artifacts/...`, writes `data/builds/<build>/current.json`, and preserves both declared artifact paths and persisted storage paths for verification.
- Pigsty runtime status now lists declared build names so UIs and PigLink tools can discover available builds without manually parsing the full manifest.
- Extended Piglet/Pigsty/PigLink regression coverage to prove Pigsty can build derived files inside the virtual workspace, run declared packaged builds, enforce declared output trees, reject path traversal or host-process access attempts, define an internal engine contract without host authority, resolve Pigsty mount paths, expose immutable toolchain and ephemeral tmp mounts, execute the adapter handoff with digest-checked engine results, invoke the Edge/WASIX adapter through an Edge-compatible command runner, route explicit Edge builds through headless PigLink without worker fallback, apply transactional Pigsty engine results, publish generated artifacts for later persistence, detect tampered published output and be invoked by a Wurst action through headless PigLink and the CLI.

## 0.31.0 - Piglet Bites Back

- Added the first functional Piglet slice. MeatGrinder can embed fixed child `.wurst` / `.wrst` files declared under `piglet.children`, stores them as immutable `piglet` resources and records each child id, entry path, SHA-256 digest, byte size and child application identity summary in the parent manifest.
- Parent package signatures now cover immutable Piglet child bytes. Replacing a built-in child invalidates the parent signature while the child remains an independently normal Wurst.
- Wurster Web can list Piglet children, serve runtime-owned child Wurst URLs, verify child byte hashes and open a child as an internal `WursterWebSession`.
- Desktop Wurster exposes `wurst.piglet.children()` and `wurst.piglet.url(id)` plus `wurst://piglet/<id>.wurst` byte serving for built-in children. Full managed desktop child renderer embedding remains follow-up work.
- Added the first Pigsty runtime contract slice. MeatGrinder validates `pigsty` policy, runtimes expose `wurst.pigsty.status()`, and unavailable Pigsty is reported explicitly instead of silently pretending Node exists.
- Added Piglet/Pigsty regression coverage for child-byte signing, Web child sessions and Pigsty status.

## 0.20.1 r007 - Pigsty / Piglet / PigLink direction

- Established the v0.30 architecture lane around three runtime primitives: Pigsty for internal computation, Piglet for Wurst-in-Wurst composition and PigLink for communication.
- Renamed the current declared Actions/Events contract from Wurst Interface to PigLink. The current manifest field is now `piglink`, the immutable resource scope is `piglink`, the runtime API is `wurst.piglink` and the implementation global is `PigLink.define`.
- Kept the pre-1.0 no-bridge rule: `interface` manifests are rejected instead of being interpreted as a parallel legacy contract.
- Added canonical documentation for Pigsty, Piglet, PigLink and derived build artifacts, including Pigsty permission boundaries, Piglet trust separation and PigLink capability-composition rules.
- Updated current docs and CLI copy from 0.20.0 to 0.20.1 where they described active runtime behavior.

## 0.20.0 r006 — Whole Hog Repository

- Added a tag-driven GitHub Actions runtime release pipeline. A `v<package-version>` tag runs the test gate, builds macOS arm64, macOS x64 and Windows x64 installers on native GitHub runners, writes SHA-256 checksums and publishes the artifacts as a GitHub Release.
- Runtime installer artifact names are architecture-stable: `Wurster-Setup-<version>-x64.exe`, `Wurster-<version>-mac-arm64.dmg` and `Wurster-<version>-mac-x64.dmg`.
- The wrst.io Runtime page now links directly to those GitHub Release assets and uses a native-looking macOS download dropdown. Linux and the public CDN stay explicitly marked as coming soon.
- GitHub Pages now uploads hidden files so `/.well-known/` survives the Pages artifact step.
- WursterLab Operator gained sealed Mail Relay URL + HMAC secret settings. `Verwursten` exports them only into `authority/wrst.io/private/operator-settings.json` inside the private production ZIP.
- A production workspace can be rehydrated into a fresh WursterLab in one click, including the four WRST.IO Authority files and saved relay settings when present.
- Added `npm run authority:worker:relay-secrets` to restore the two Worker relay secrets from the private operator settings file without retyping them.
- Removed the root `/examples` application projects and every package script that depended on them. Showcase pages may remain on wrst.io, while runnable examples belong in future standalone repositories.

## 0.20.0 - No Fossils in the Sausage

- Hotfix r005: split WRST.IO public discovery, active issuance and mail delivery into three deliberately narrow services. Eleventy/GitHub Pages now publishes `/.well-known/wurst-authority` statically, `authority.wrst.io` keeps only challenge/certificate cryptography, and email delivery goes through a tiny HMAC-authenticated PHP relay that never receives the issuer signing key.
- Hotfix r005: removed Cloudflare Email Sending and the separate `wrangler.email.jsonc`. The Authority now has one current Worker config using SQLite Durable Object `exports`, rate-limit bindings, and two relay secrets (`WRST_MAIL_RELAY_URL`, `WRST_MAIL_RELAY_SECRET`).
- Hotfix r005: added a self-contained PHP mail relay with replay protection and selectable PHP `mail()` or direct SMTP transport (STARTTLS/SMTPS, LOGIN/PLAIN/no auth). The production workspace ZIP includes the relay endpoint and editable configuration template automatically.
- Hotfix r005: Wurster Lab explicit output revisions now become the embedded release revision too, so cache-safe handoff names cannot disagree with `release.json`.
- Hotfix r004: fixed WurstFS catalog lookup ordering so valid files such as `tools_export_wurster_lab.py` cannot become stat/read ghosts behind a stale `first`/`last` page hint. This was the root cause of Wurster Lab `Verwursten` failing with `null.data`. Catalog bounds are now deterministic hints, never authoritative lookup truth.
- Hotfix r004: Wurster Lab now streams complete workspace files in bounded WurstFS reads when producing the private operator ZIP, instead of assuming one renderer read contains the whole file.
- Hotfix r004: Operator is now a real gated admin zone. Selecting the Operator tab presents only Wurster-owned Identity authentication until the personal realm is unlocked; production controls appear afterwards and can be explicitly re-locked. Normal Lab UI text selection is disabled while editable note fields remain selectable.
- Hotfix r003: restored the current desktop WurstFS `/data` path mapper removed during the no-legacy cleanup. `wurst.fs.write()` / streaming `begin-write` now resolves `/data/...` and realm-relative paths again, with a regression covering the exact Operator-material import path.
- Hotfix r002: removed a stale desktop import of the deleted `normalizeFsPath` helper that caused packaged Wurster to fail during ESM startup, and added a runtime module-contract regression that verifies named workspace imports against their actual public exports.
- Adopted the pre-1.0 **no compatibility bridges** rule. Experimental mutable-data and authority paths that are no longer part of the current design were removed instead of kept as migration code.
- Removed WurstFS v1 / single-Vault runtime code and the renderer `wurst.vault` API. Mutable application data now has one current model: `data: { format: "wurst/data-realms-1" }` backed by `wurst/fs-2`.
- Removed the public manifest `mode` concept completely. Ordinary storage is the unnamed default; only `governance: "personal"` or `governance: "shared"` opt into special semantics. Removed `mode` declarations are rejected rather than interpreted.
- Removed the old direct local Authority key/certification CLI model and publisher-certificate v1/v2 acceptance. The current trust chain is Root → Issuer → `wurst/publisher-certificate-3`.
- Removed the standalone Operator Vault prototype. `WursterLab.wurst` is now the reference operator container, with ordinary `/data/workspace` + `/data/lab` realms and one personal sealed `/data/operator` realm.
- Identity auth targeted at a realm can initialize the current realm filesystem on first use, so a fresh personal Wurst can authenticate, initialize and claim its realm in one trusted flow.
- Updated the example set to the current model only. The old v2 certificate demo became a package-signed sample; personal examples use personal WurstFS realms directly.
- MeatGrinder inspection now summarizes live multi-realm `wurst/fs-2` roots directly instead of assuming the removed single-catalog layout.
- Added an explicit WRST.IO email-only Authority regression: a verified email claim requires no domain and receives a valid offline certificate on its own.
- Rewrote the mutable-data/security documentation around ordinary, personal and shared realms. Ordinary/personal data remain history-free and physically compactable; shared signed integrity and optional audit are explicitly separate capabilities.
- Kept large-write concurrency semantics: unrelated small writes may commit while a long streaming import is still running; same-object races remain explicit conflicts.
- WRST remains v7 and current mutable WurstFS remains `wurst/fs-2`. Pre-1.0 artifacts using discarded schemas are rebuild-only, not compatibility targets.

## 0.19.0 - Wurster Lab

- Replaced the misleading `mode: "crud"` WurstFS v2 schema with orthogonal **realm governance**. Ordinary mutable storage is now the unnamed default; `governance: "personal"` and `governance: "shared"` opt into special ownership semantics only where needed.
- New WurstFS roots no longer write a `crud` mode. Pre-1.0 `mode: "crud" | "personal" | "shared"` manifests/roots remain readable as migration input.
- Added **unclaimed personal realms**. A Wurst can ship ordinary public data beside an empty sealed personal compartment; the first authenticated Wurster Identity that explicitly unlocks it becomes its sole owner. No placeholder key or prior use of the Wurst is required.
- Personal claiming remains history-free when no shared realm exists and can coexist with ordinary mutable realms in the same Wurst. Empty unclaimed personal realms can be compacted without a key; claimed personal realms still require their owner to unlock them before compaction.
- Desktop realm APIs now report `governance` and personal `claimed` state instead of presenting ordinary CRUD as a special filesystem mode. Only shared genesis requires an identity up front.
- Added the first real **WursterLab.wurst** workflow container. Its immutable signed Lab app carries a public mutable `/data/workspace` source tree, public `/data/lab` release notes, and a personal sealed `/data/operator` compartment for WRST.IO operator material.
- Added a pink Wurster-style Lab UI with current-release changelog, traveling project notes, realm/status readouts, operator-file import, compaction controls and scientifically unnecessary pig laboratory telemetry.
- The Lab verifies that imported `root.json`, `issuer.json`, `trust-bundle.json` and `issuer.wurstissuer` form one coherent production WRST.IO chain before presenting the operator kit as valid. Root and Issuer Meatphrases remain outside the Wurst.
- The Lab can locally **Verwursten** its carried public workspace into a private operator build ZIP, overlaying the verified WRST.IO public trust material plus the encrypted Issuer backup. This ZIP is a local build/deploy artifact; the `.wurst` remains the handoff container.
- Added `tools/wurster-lab-wurst.mjs` to build a fresh Lab Wurst and to update a returned Lab Wurst under a new incremental filename while preserving the opaque claimed operator realm. This is the intended Chat workspace handoff path going forward.
- WRST remains v7 and WurstFS remains `wurst/fs-2`; this is a pre-1.0 semantic cleanup and workflow application, not another container-version bump.

## 0.18.0 - Lean Meat

- Reframed **WurstFS v2 as a capability ladder instead of a mandatory signed-history system**. The default `crud` realm is ordinary mutable data with no Wurster Identity, signatures or revision history.
- Added first-class `personal` realms: owner-only sealed storage with encrypted filenames/content, explicitly non-shareable and history-free. This covers diaries, private galleries, operator material and other "only my data" cases without dragging in multi-user policy.
- Kept `shared` realms as the optional federated power mode with Wurster Identity read/write/admin policy. Shared integrity remains signed; `audit: signed` is now an additional explicit opt-in for richer operation summaries instead of the default behavior.
- Added safe WurstFS v2 compaction for history-free CRUD/personal snapshots. Obsolete DATA/MAP/CATALOG records are rewritten away, so deleting or replacing multi-gigabyte data can physically shrink the Wurst again. Sealed personal compaction requires the owner realm to be unlocked.
- Desktop Wurster now measures reclaimable v2 storage and schedules background hygiene for history-free realms instead of treating append-safe records as permanent bloat.
- Added concurrent streaming write sessions with serialized physical appends and short optimistic commits. Unrelated small writes can overtake a long import; simultaneous updates of the same object produce an explicit conflict.
- CRUD-only WurstFS can initialize without a Wurster Identity and can auto-initialize on first write. Personal/shared templates request identity only when their semantics actually need it.
- Personal realms reject grant/revoke/rekey sharing operations by design. Shared realm administration remains a Wurster-owned trusted-UI concern rather than a renderer superpower.
- Added storage regression tests proving physical shrink after large CRUD and encrypted-personal deletes, non-shareable personal storage, history-free defaults, write overtaking and same-object conflict detection.
- Shared-integrity compaction remains intentionally separate until the before-1.0 checkpoint/garbage-collection design can reclaim obsolete payloads without lying about authenticated ancestry.
- WRST remains v7; this release changes mutable WurstFS semantics and runtime behavior, not the immutable container framing.

## 0.17.0 - Federated Meat

- Added **WurstFS v2 (`wurst/fs-2`) realms** inside the existing WRST v7 mutable tail. A Wurst can now carry multiple independent public or sealed data realms instead of one global User Vault protection mode.
- Added portable `wurst/identity-1` Wurster Identities derived deterministically from a Meatphrase with separate Ed25519 signing and X25519 encryption keypairs.
- Added safe public identity exchange as `.wurstid` JSON and `wurstid-v1-...` copy/paste strings. Wurster Settings can export/copy the public record without exposing the Meatphrase or private keys.
- Added signed WurstFS mutation history. Write/admin authorization is evaluated against the parent commit policy, so a cryptographically genuine signature from an unauthorized identity is still rejected as filesystem forgery.
- Added public/member/authenticated/open realm policies plus explicit realm administrators and public identity registry records.
- Added X25519 + HKDF-SHA256 + AES-256-GCM realm-key wrapping for sealed readers. Sealed catalogs, filenames, metadata and DATA chunks remain opaque to identities without a matching key-wrap.
- Added explicit sealed-realm rekeying for read revocation. The current live snapshot is re-encrypted under a fresh realm key and wrapped only for remaining readers; old offline copies remain old copies by design.
- Added offline history comparison with `same`, `ahead`, `behind` and `fork` relationships instead of pretending two independently modified USB copies have one implicit canonical winner.
- Added same-realm rename, public mutation summaries that redact sealed paths, and reader-side full-chain history verification.
- Added signed manifest realm templates via `data: { format: "wurst/data-realms-1" }`. Sealed genesis templates are owner-only so application JavaScript cannot silently pre-share a new private realm with a third-party key.
- Desktop Wurster now exposes realm discovery, initialization, identity-session unlock, lock and history through `wurst.fs`; file writes are signed in the host process when realm policy requires an identity. Private keys never enter the Wurst renderer.
- Deliberately kept grant/revoke/rekey administration out of the raw renderer API. The format primitives exist, but end-user sharing must be mediated by Wurster-owned trusted UI before 1.0.
- Legacy `wurst/fs-1` single-Vault Wursts remain supported. A Wurst declares either legacy `vault` or new realm `data`, never both.
- WurstFS v2 compaction is intentionally disabled until a signed checkpoint/history-compaction design exists; Wurster refuses to silently discard provenance.
- WRST remains v7. This release expands the mutable filesystem/security model without changing immutable container framing.

## 0.16.0 - Verified Claims

- Added the **WRST.IO Operator Vault** Wurst: a sealed portable operator vault that stores production Authority material and personalizes clean Wurster Lab release ZIPs without keeping private operator state in the disposable workspace.
- Desktop Wurster now implements signed, user-selected `files.open` / `files.save` capabilities through Wurster-owned dialogs; Wursts still receive no unrestricted host filesystem access.

- Added `wurst/publisher-certificate-3`, which separates the publisher key from independently verified `domain` and `email` claims. Legacy v1/v2 certificates remain readable during the pre-1.0 transition.
- WRST.IO Authority now exposes explicit domain and email verification endpoints while preserving the original domain endpoint aliases.
- Added optional six-digit email verification from `oink@wrst.io`. Codes are sealed inside issuer-signed challenges rather than returned to the requesting client.
- Added conservative email abuse controls: short-window rate limits, exact global/address/client daily budgets and a hard per-challenge code-attempt limit. Email sending remains an optional Worker deployment so DNS issuance does not depend on outbound mail infrastructure.
- Added a separate email-enabled Cloudflare Worker configuration using Cloudflare Email Service and a SQLite-backed Durable Object for exact operational budgets.
- Added required-secret validation for the online issuer and made the Authority Worker a root npm workspace so a normal workspace install includes Wrangler.
- MeatGrinder CLI can request and complete email verification, merge previously certified claims and inspect v3 claim lists.
- Desktop MeatGrinder can verify domain/email claims with WRST.IO directly from the signer UI, stores the resulting public certificate with the local signer and automatically embeds that certificate when the GUI signs a Wurst.
- Added `/verify/` to the WRST.IO static site. It verifies `.wurstreq` proof-of-possession locally, supports DNS and optional email verification, locally validates existing/returned certificates against the pinned web trust data and downloads portable `.wurstcert` files.
- Updated Wurst Identity presentation so Authority trust displays only the exact certified claim rather than accidentally promoting self-declared publisher metadata.
- Clarified project status: WRST.IO is the official project website and trust service, not a company or incorporated identity provider. The pre-1.0 source remains all rights reserved; MIT is documented only as the current candidate for the eventual 1.0 open-source license.
- WRST remains v7. This release changes certificate semantics and verification UX, not container framing.

## 0.15.0 - Root of Trust

- Established `wrst.io` as the official Wurster project domain and removed the previous domain naming from the workspace.
- Made `.wurst` and `.wrst` equivalent native Wurst file extensions across desktop associations, pickers, verification flows and the browser viewer.
- Added the V1 Authority chain: deterministic offline Ed25519 Root derived from a 24-token Root Meatphrase, root-certified rotatable issuer, publisher certificate v2 and Root-signed trust bundles.
- Added signed issuer/publisher revocation semantics while preserving offline certificate verification.
- Added `tools/wrst-authority.mjs` for production bootstrap, public-material synchronization, production guard, issuer-secret export, issuer rotation and revocation. Root private material is never written to disk; encrypted issuer backups are excluded from Git and release ZIPs.
- Added the stateless `authority.wrst.io` Cloudflare Worker. It verifies publisher proof-of-possession, issues signed short-lived DNS challenges and creates publisher certificates after TXT proof without D1/KV/account storage.
- MeatGrinder can request and complete remote Authority challenges against `https://authority.wrst.io`.
- Desktop Wurster now verifies the full Root → issuer → publisher chain and local Root-signed revocation bundle.
- Wurster Web now ships the same pinned public trust data and reports v2 publisher-certificate trust without a runtime network lookup.
- Added a GitHub Pages deployment workflow and `wrst.io` CNAME; the generated static site receives the current Wurster Web runtime and public Authority trust bundle.
- Added `/authority/` and canonical Authority/operator documentation.
- WRST remains v7; Authority V1 adds trust records and operational infrastructure without changing the Wurst container framing.

## 0.14.0 - Wurst on the Web

- Added the standards-based `<wurst-embed>` Custom Element. A site can embed a Wurst with a normal `src` attribute and size it with CSS.
- Added an isolated CDN/embed host that keeps Wurster's service worker on the Wurster distribution origin. The embedding page supplies bounded Wurst byte ranges over `MessageChannel`, so consumers do not need to install a Wurster service worker at their own origin root.
- Added optional `<wurst-embed wurstkey="…">` application unlock for intentionally shared/demo keys. The host page may know that attribute by design; the key is never exposed to Wurst application JavaScript.
- Added browser-native WurstKey/AES-256-GCM application decryption compatible with existing WRST v7 application key-wraps and protected chunks.
- Added fully sealed application execution in Wurster Web, including the encrypted `wurst/sealed-app-map-1` path/entry map. No sealed application HTML runs before the WurstKey validates.
- Added partial application protection in Web: the public shell runs immediately; protected resource requests pause behind Wurster-owned outer unlock UI, while `<wurster-auth type="wurstkey">` can request the same flow explicitly. Canceling leaves the public shell running.
- Wurster Web now rejects invalid package signatures during mount instead of treating verification as a purely optional inspection step.
- Corrected Web capability reporting so desktop-only `window.alwaysOnTop` and `code.unsafeEval` are no longer advertised as available browser capabilities.
- Added `/viewer/` to the Wurster 11ty site: drag a local `.wurst` into the browser and run it through the same public `<wurst-embed>` implementation.
- Site synchronization now rebuilds Wurster Web and copies the generated browser distribution into the site automatically, preventing the official viewer/docs site from silently shipping a stale runtime.
- Fixed a pre-existing Headless harness race where intentional `Worker.terminate()` could occasionally be observed as a failing exit after a successful Action result.
- WRST remains v7. This release completes WurstKey application execution on Web without introducing a new container or crypto format.

## 0.13.0 - Trust the Wurst

- Added optional `<wurst-identity>` anchors. Desktop Wurster overlays them with a separate sandboxed runtime-owned `WebContentsView`, so the Wurst controls placement but not the seal contents.
- Added a polished Wurster Identity Verification certificate window showing publisher identity, trust route, Ed25519 package-integrity result, fingerprint and source file. The window is outside the Wurst renderer and is the authoritative click-through check for the badge.
- Added verification-only package inspection. Wurster can verify a `.wurst` or Undercover PNG without executing its application entry point.
- Added **File → Verify Wurst Identity…** to the desktop runtime so macOS and Windows can inspect a Wurst before opening it.
- Added a Windows Explorer **Verify Wurst Identity** shell verb scoped only to the `Wurster.Wurst` `.wurst` ProgID. It launches Wurster with `--verify-wurst-identity` and never registers a generic all-files command.
- Deliberately did not install a broad macOS Finder extension: Apple's contextual extension models are folder/provider-oriented rather than a clean extension-only global verb. The trusted verification flow remains available from Wurster's File menu.
- Replaced personal MeatGrinder example domains and labels with neutral `yourwurstdomain.tld` / `Your Wurst Studio` placeholders across GUI, docs and tests.
- Updated the verified seller example to embed the real Wurster-owned identity seal and added conformance checks for trust presentation and scoped Windows registration.
- WRST remains v7; this release hardens publisher identity UX and platform verification behavior without changing the Wurst container format.

## 0.12.1 - Clean Cuts on the Web

- Removed the accidental literal `wurst://data/...` compatibility rewrite from Wurster Web. Wurst application resources keep ordinary relative web URL semantics; mutable data URLs come only from `wurst.fs.url()` and are runtime-owned/opaque.
- Reworked the web WurstFS overlay around bounded chunk storage. Browsers use IndexedDB as an internal session backing store when available, so `beginWrite()` / `writeChunk()` no longer retain the entire file as renderer byte arrays.
- Range reads now cross browser overlay chunks without materializing the complete file, and renaming an immutable-base file is metadata-only instead of copying the whole source into memory.
- Added streamed snapshot record generation, HTTP-style suffix ranges and HEAD support to the Web service-worker resource path.
- Added `@wurster/session`, a runtime-neutral authorization-session broker with runtime binding, scopes, expiry and no renderer-visible bearer token.
- Desktop Wurster now time-bounds Vault/WurstKey Protection Core sessions (60 minutes default, runtime-clamped to 24 hours) and exposes only public state through `wurst.auth.status()`.
- Web `<wurster-auth>` handoff requests now bind origin, Wurst id, one-time request id, purpose and requested duration while still carrying no Meatphrase/private key.
- Expanded the Wurster Web demo and conformance tests around relative URLs, chunked writes, range reads, metadata-only rename and snapshot interoperability.
- WRST remains v7. Sealed browser execution and the cryptographic return leg of Desktop ↔ Web identity handoff remain the next web-runtime milestone.

## 0.12.0 - Wurst Everywhere

- Reorganized runtime work below `runtime/`: shared desktop source, Windows/macOS output homes, browser runtime, and reserved iOS/Android runtime directories.
- Added Wurster Web alpha with WRST v7 local/HTTP-range readers, public app execution, plain WurstFS CRUD overlay, ranged WurstFS media and standalone snapshot export.
- Added service-worker-backed virtual Wurst resources so browser Wursts keep normal relative HTML/CSS/JS resource behavior.
- Added web `<wurster-auth>` handoff controls and registered the desktop `wurster://` custom protocol without placing Meatphrases or private keys in handoff URLs.
- Added `.env.signing.example` / `.env.signing.local` release-signing workflow for macOS Developer ID/notarization and Windows Authenticode builds.
- Desktop build artifacts now land under `runtime/windows/dist/` and `runtime/mac/dist/`.
- Added 11ty-ready runtime layout, web runtime and Wurster release-signing documentation.
- Added web-runtime conformance tests for WRST v7/WurstFS read, browser overlay writes and standalone snapshot export.
- WRST remains v7. The web runtime is explicitly alpha-incomplete for sealed application/WurstFS execution until its portable browser crypto/auth adapter is finished.

## 0.11.1 - Sign the Sausage

- Added Wurster-managed MeatGrinder signing identities alongside user Meat Identities.
- MeatGrinder GUI now defaults to unsigned but can select stored publisher signers per build.
- Added compact signer creation with label, optional domain/email and direct Publisher Meatphrase input.
- Stored signer private material is protected by Electron safeStorage and asks for OS user presence when signing where available.
- Added DNS verification controls for `_wurst.<domain>` publisher records directly in MeatGrinder and Wurster Settings.
- Added publisher signer import/export, Meatphrase reveal and local removal in the Wurster identity manager.
- MeatGrinder can sign from an in-memory protected publisher bundle, so GUI signing needs no temporary `.wurstkey` or Meatphrase text file.
- CLI accepts direct `--key-meatphrase` / `--meatphrase` and asks with hidden terminal input when an interactive signing command needs a Meatphrase.
- WRST remains v7; this patch changes runtime/key-management UX, not the Wurst binary format.

## 0.7.0 - Universal Meat

- WRST v4. No backwards compatibility with earlier experimental formats.
- Formalized the Universal Wurst rule: Wurst crypto never depends on platform-specific key stores.
- Portable Meatphrase remains the universal unlock route on every conforming runtime.
- Added Wurster Settings and Meat Locker management UI.
- Meat Identities can be added, renamed, revealed and deleted locally.
- Added optional local device-presence policy where the runtime exposes it.
- Added optional local TOTP Authenticator protection for stored Meat Identities.
- Platform protection applies only to the local Meat Locker, never to Wurst encryption.
- Added `protection.storedIdentity` so a Wurst may require manual Meatphrase entry.
- Added `application.protection`: `public`, `partial`, `sealed`.
- Partial apps can keep a public shell and place private application resources in `sealed/`.
- Fully sealed apps hide original app paths and entry metadata in an encrypted private application map.
- Added plain or sealed writable Vault via `vault.protection`.
- Removed the old `vault.encrypted` model.
- Shared portable protection key can cover sealed app resources and sealed user Vault content.
- Burn removes only mutable Vault content and preserves protection needed by sealed application code.
- Added public per-Wurst PNG presentation icon/thumbnail metadata.
- Transparent desktop windows default to no OS shadow, fixing the macOS border/shadow around transparent Würste.
- Added macOS ARM64, x64 and Universal build commands.
- Added `sealed-shell` example and expanded tests for full sealing and local identity primitives.

## 0.6.0 - Undercover Wurst

- Added valid PNG carrier mode using private `wuSt` chunks.
- PNG carrier preserves random-access WRST reads.
- Added Undercover Wurst sample.

## 0.5.0 - Scheibchenweise

- Added chunk integrity and lazy file-backed resource reads.
- Added HTTP Range handling for `wurst://` resources.
- Added chunked protected resource crypto and separate Electron utility process.

## 0.4.0 - Wurster Secure

- Added fresh/sealed/open Vault lifecycle.
- Added Wurster-owned secure authentication surface.
- Added local Meat Locker backend.
- Made app-controlled Vault Burn explicit.

## 0.3.0 - Verified Wurst Sellers

- Added seller proof requests, Authority certificates and trusted roots.
- Added binary Vault resources and random-access reader groundwork.

## 0.2.0 - Quality Wurst begins

- Added GREEN/YELLOW/RED capability risk model.
- Added portable encrypted user data, Meatphrase, Ed25519 signing and first Wurster security baseline.
