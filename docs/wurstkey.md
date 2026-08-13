---
title: WurstKey
group: Security & Trust
groupOrder: 4
order: 5
---
# WurstKey

A WurstKey is 256-bit random key material used for **developer-owned immutable application protection**.

It is intentionally independent from:

```text
Wurster Identity / Meatphrase → mutable identity-owned data and signatures
Publisher key                 → immutable package signing
WurstKey                      → immutable application confidentiality
```

A Wurst may be publicly distributed while still requiring a WurstKey for all or part of its application. `<wurst-embed>` may receive a `wurstkey` attribute when a site intentionally publishes the key with the embed, or the user may be asked to enter the key at runtime.

The Wurst application never receives the raw WurstKey through its normal API.
