---
title: Security Overview
group: Security & Trust
groupOrder: 4
order: 0
---
# Security overview

Wurster separates four questions:

1. **Application integrity:** who signed the immutable Wurst application?
2. **Application confidentiality:** does immutable developer content require a WurstKey?
3. **Mutable-data confidentiality:** is a WurstFS realm ordinary, personal sealed, or shared sealed?
4. **Mutable-data governance:** does a realm use Wurster Identity based write/admin authorization or signed audit?

Ordinary WurstFS storage opts into none of the identity machinery.

A Meatphrase is the portable secret behind a Wurster Identity. It deterministically recovers the identity's Ed25519 signing and X25519 encryption identities. Local Meat Locker storage is only a protected convenience copy.

A WurstKey is separate 256-bit application key material controlled by the developer/distributor.

Package publisher keys are separate again. They sign immutable application packages and may carry WRST.IO verified publisher claims.

Keeping these domains separate prevents one convenient secret from silently becoming every kind of authority in the system.
