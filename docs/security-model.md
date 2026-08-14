---
title: Security Model
group: Security & Trust
groupOrder: 4
order: 1
---
# Security model

Wurster separates trust domains instead of treating "encrypted" or "signed" as one giant switch.

## Immutable application integrity

The application package is immutable. Publisher signatures use Ed25519 and cover the application resources, manifest, public metadata and declared PigLink code. A package signature answers: **which publisher key signed this application, and are the signed bytes unchanged?**

WRST.IO Authority certificates may bind verified domain/email claims to that publisher key. Verification is offline when the WRST.IO Root is pinned in the runtime.

## WurstKey: developer-owned application confidentiality

A WurstKey protects immutable application content selected by the developer.

- `application.protection: "partial"` leaves the public application shell readable and seals selected application resources.
- `application.protection: "sealed"` seals the application resource map and protected application content before entry code runs.

The WurstKey is not a user identity and is not reused as a mutable-data key.

## PigFS: mutable data

Mutable data uses independent PigFS realms.

### Ordinary

No identity, no encryption, no signatures, no retained audit history. This is the default.

### Personal

One Wurster Identity owns an encrypted realm. The realm is intentionally non-shareable and history-free. A random realm key encrypts metadata and payloads and is wrapped for that identity's X25519 public key.

### Shared

Shared realms explicitly opt into Wurster Identity based governance. Ed25519 proves authorized mutations; X25519 wraps sealed realm keys for readers. Read, write and admin are separate capabilities.

`audit: "signed"` is an additional opt-in. Sharing does not automatically imply application-visible detailed history.

## Wurster Identity

A Wurster Identity derives two independent keypairs from its portable Meatphrase:

```text
Ed25519  signing / mutation authorization
X25519   encrypted realm-key delivery
```

The public identity may be exported as `.wurstid`. Public identities are safe to exchange; Meatphrases and private keys are not.

A Wurster Identity may carry self-declared display information and optional WRST.IO verified claims. Wurster must visually distinguish the two.

## Trusted Wurster UI

A Wurst can draw convincing HTML. Therefore sensitive trust operations are not trusted merely because they look like Wurster.

Trusted surfaces such as `<wurster-auth>` and `<wurst-identity>` are rendered by Wurster outside the Wurst renderer. Clicking identity verification opens a Wurster-owned certificate view. Sharing policy changes should follow the same rule.

## Host filesystem boundary

Wurst JavaScript does not receive arbitrary host paths or Node filesystem access. `files.open` and `files.save` are narrow user-selected bridges owned by Wurster dialogs.

PigFS paths are inside the Wurst itself and are not host filesystem permissions.

## Pigsty boundary

Pigsty may provide Node-powered tooling inside a Wurster-controlled Wurst workspace. It is not Node access to the host computer. Host filesystem, shell, processes, network, other Wursts and private keys remain behind explicit Wurster capabilities.

Pigsty permission is independent of package signature. A signature identifies a publisher; it does not authorize computation.

## Piglet boundary

Piglet lets a parent Wurst keep and orchestrate child Wursts. It does not merge trust domains. MeatGrinder preserves built-in child bytes exactly, and runtime installation writes the supplied child bytes unchanged into PigFS. A child keeps its own signature, publisher, realms, WurstKey state, Pigsty permission and PigLink declarations.

Managed Desktop children run in separate renderer/runtime contexts. Invalid child signatures fail before execution. Sealed child surfaces currently fail closed until authentication is child-context aware.

Parenthood grants orchestration, not authorship or omnipotence.

## PigLink boundary

PigLink connects behavior, not trust. A link does not transfer capabilities, but it may compose them. Wurster must treat relevant links as security decisions when the resulting data flow is stronger than either side alone.

## Append-safe writes and compaction

Mutable writes append new records before publishing a commit. If the process crashes before commit, the previous committed state remains authoritative.

Append-safe is not permanent retention. Ordinary and personal PigFS storage can be compacted to the current live snapshot, physically removing deleted/replaced data. Compaction writes a separate file, verifies it and only then may replace the old file.

## Multi-user integrity boundary

Readonly is not a promise that a hostile hex editor cannot change bytes. It means an unauthorized changed state cannot validate as an authorized PigFS state.

Confidentiality is stronger: data another identity must not read is actually encrypted.

## Current primitives

- Meatphrase KDF: scrypt
- publisher/package signing: Ed25519
- Wurster Identity signing: Ed25519
- Wurster Identity key agreement: X25519
- protected application content: chunked AES-256-GCM
- sealed PigFS realms: AES-256-GCM with per-realm random keys
- hashes/integrity: SHA-256
- application WurstKey: 256-bit random key material

Wurst does not invent custom ciphers.

## Pre-1.0 rule

Wurster is still under active format development. There are no compatibility bridges for discarded experimental mutable-data or authority models. The current codebase validates the current model only; incompatible pre-release artifacts should be rebuilt.
