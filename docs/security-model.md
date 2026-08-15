---
title: Security Model
group: Security & Trust
groupOrder: 4
order: 1
---
# Security model

**Wurst gives software a world of its own without giving it the user's computer.**

The primary hard boundary is **Wurst ↔ Host**. Inside the Wurst world, PigFS, PigLink, Piglet and Pigsty are cooperation primitives, not a Zero-Trust microkernel.

> The pigs may share the mud. They may not enter the farmer's house. If two abilities build a ladder over the fence, Wurster notices the ladder.

## Three rules

1. **Host authority is never ambient.** Host FS/process/shell/environment, Wurster Identities, private signing keys, Meatphrases and WurstKeys stay outside application JavaScript.
2. **Internal authority may be shared deliberately.** Parent↔Child PigLink is cheap; Parent PigFS and Piglet management can be explicitly delegated.
3. **Authority composition is visible.** Wurster records combinations that create a meaningful Host/network data path instead of pretending each grant exists in isolation.

Trust-boundary machinery fails closed. Convenience features may degrade; they may not manufacture authority.

## Host brokers

Capabilities such as `files.open` / `files.save` are narrow Wurster-owned bridges. The user chooses a file/destination; the Wurst does not receive a reusable Host directory capability.

Parent PigFS is still Wurst storage, not Host storage. Delegating it never exposes `/Users`, `C:\`, `/etc`, Node, shell or environment variables.

Wurster Auth, verified Identity UI, Meatphrases, WurstKeys and private keys are never generic Parent services.

## Internal cooperation

A normal Piglet may communicate with its Parent through PigLink. The Parent can additionally delegate:

```text
parent-pigfs="read" | "read-write"
parent-piglets="read" | "manage"
```

There is no inherit-all-parent-capabilities switch. `<wurst-embed isolated>` removes the managed Parent relationship when a Child needs a stricter compartment.

Identity separation remains mandatory: a Child keeps its own package, publisher signature, PigFS and protection state. Operational isolation is optional.

## Authority composition

The important question is not whether two Wursts have different identities. It is:

> Does this relationship combine authority that nobody granted in this combination?

For example, Parent PigFS read plus Child network access creates a Parent-data-to-network path. Wurster exposes `wurst/authority-composition-1` metadata for such relationships. This is observability-first; it is not an automatic prompt for every internal connection.

## Data protection

- **WurstKey** protects developer-owned immutable application content.
- **PigFS ordinary Realm** is normal mutable data.
- **PigFS personal Realm** encrypts data for one Wurster Identity.
- **PigFS shared Realm** adds explicit governance and wrapped Realm keys.

Delegation never bypasses PigFS lock/governance/encryption. If a Parent cannot read a Realm, its Child cannot read it through Parent PigFS either.

Publisher signatures authenticate immutable application bytes. Carrying or embedding a Child never makes the Parent its publisher.

## Pigsty

Pigsty may compile, install or transform against Wurst-owned files, but it must not become a Host Node/Shell/FS escape hatch or materialize protected plaintext onto uncontrolled Host storage. Native Edge/WASIX production isolation remains unfinished, so Pigsty stays non-blocking and experimental in 0.32.8.

## Current crypto primitives

- scrypt for Meatphrase KDF
- Ed25519 for package/identity signing
- X25519 for sealed Realm key delivery
- AES-256-GCM for protected application content and sealed PigFS Realms
- SHA-256 for hashes/integrity

Wurst does not invent custom ciphers.
