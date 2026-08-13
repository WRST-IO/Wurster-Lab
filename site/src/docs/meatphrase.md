---
title: Meatphrase
group: Security & Trust
groupOrder: 4
order: 4
---
# Meatphrase

A Meatphrase is the portable recovery secret for a Wurster Identity.

From one normalized Meatphrase Wurster deterministically derives purpose-separated identity material:

```text
Ed25519  signing identity
X25519   encryption identity
```

The Meatphrase itself is never a publisher package-signing key and never a developer WurstKey.

A local Meat Locker may keep an encrypted convenience copy protected by platform-specific user presence. That local mechanism does not change the portable identity: the same Meatphrase reconstructs the same Wurster Identity on another conforming runtime.

Personal sealed WurstFS realms wrap their random realm key for the identity's X25519 public key. Shared sealed realms can wrap the same realm key for several authorized identities.
