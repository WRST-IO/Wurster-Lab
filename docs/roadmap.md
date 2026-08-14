---
title: Road to Wurster 1.0
group: Project
groupOrder: 6
order: 2
---

# Road to Wurster 1.0

Wurster 0.11 began the deliberate alpha/beta stretch toward the first stable format and runtime family.

The working release lane is:

```text
0.20          WRST v7 / WurstFS v2 / Authority foundation
0.30          PigLink/Piglet stabilization; Pigsty matures independently
0.40+         conformance, recovery, platform hardening
1.0           stable Wurst contract + conforming runtimes
```

The exact feature-to-version assignment can move. The important part is that the project now favors conformance, recovery, documentation and platform behavior over accumulating unrelated features.

Pigsty is intentionally not a release blocker for the current 0.3x line. Windows, macOS and Web may ship a coherent runtime while native Edge/WASIX bundles continue to mature. A declared Pigsty remains visible as unavailable/coming-soon rather than forcing a partial or host-Node fallback.

## Pre-1.0 compatibility policy

Before Wurster 1.0, experimental contracts are allowed to change cleanly. When a schema, runtime path, capability or security model is replaced, the discarded design is removed instead of being kept alive through backwards-compatibility shims, migration bridges or dual behavior.

Pre-1.0 Wursts that depend on a discarded contract are rebuilt against the current contract. Compatibility guarantees begin only when a behavior is explicitly promoted into the 1.0 contract. Bug fixes and current-format recovery are still required; compatibility code for superseded alpha designs is not.

## Before 1.0

Primary work includes:

- keep the v0.3x Desktop/Web release lane buildable and documented without requiring unfinished Pigsty native bundles;
- finish Piglet suspend/resume, tree-level resource budgets, Wurster-owned child trust presentation and brokered Parent↔Child PigLink on top of managed Desktop child surfaces, child-scoped Auth and persistent nested WurstFS;
- finish PigLink brokers, runtime handles, lifecycle/revocation and capability-composition prompts on top of the working Action/Event contract;
- mature Pigsty independently: complete native runtime distribution, durable WurstFS commit, network capability mediation and native-runtime conformance before enabling it in normal Desktop releases;
- define derived artifact provenance so source, generated output and toolchain state cannot silently drift;
- specify Application Identity, locator, runtime handle and publisher lineage as separate concepts for state migration and automation;
- finish the WurstFS v2 storage model: keep ordinary/personal storage compact and history-free by default, add trusted sharing UI, settle directory-policy inheritance, add safe shared-integrity checkpoints/garbage collection, merge/fork UX and remote read-only/overlay behavior;
- complete Wurster Identity federation around public `.wurstid` exchange, local contacts and optional WRST.IO identity-claim certificates;
- specify shared-realm rekey epochs and document that old offline copies cannot be made secret retroactively;
- signed network capability policy, including HTTPS, explicit HTTP and local-network use;
- harden the now-established WRST.IO Root → issuer → publisher Authority chain, operator recovery ceremony and revocation presentation;
- runtime capability availability instead of platform-specific Wurst formats;
- a written WRST v7 specification and conformance suite;
- byte-exact Meatphrase normalization, KDF parameters, domain separation, key-rotation and Rekey test vectors;
- Windows/macOS release signing and installer hardening;
- native Windows user-presence integration with a correctly owned Windows Hello/PIN dialog;
- finish Wurster Web parity after 0.14/0.15 WurstKey + Authority work: personal/shared WurstFS realm crypto, trusted Desktop↔Web identity handoff, live DNS/local-trust presentation, Undercover source support and conformance;
- additional conforming runtimes, with iOS/macOS work able to use the Apple developer distribution path when ready.

## Deliberately later

Tor/VPN routing, TEE confidential execution, external hardware identity providers and high-level document-approval/attestation UX are valuable directions, but they are not required to make Wurst 1.0 a coherent portable application format. The WurstFS v2 identity/signature primitives intentionally land before 1.0 because later attestations can reuse them, but ordinary CRUD and personal storage remain history-free by design.
