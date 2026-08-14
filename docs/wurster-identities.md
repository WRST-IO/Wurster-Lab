---
title: Wurster Identities
group: Security & Trust
groupOrder: 3
order: 4
---
# Wurster Identities

A Wurster Identity is the public cryptographic persona behind a Meat Identity.

It is designed for an offline/federated world: two people can exchange public identities by file, QR code, chat message or USB and then grant each other PigFS access without creating an account anywhere.

## Public and private halves

The private recovery secret remains the Meatphrase.

From it Wurster deterministically derives two independent keypairs:

```text
Ed25519 signing key
  signed PigFS mutations and future attestations

X25519 encryption key
  receives wrapped PigFS realm keys
```

The public record is `wurst/identity-1` and has an identity ID derived from both public keys:

```text
wuid:...
```

Display name and emoji are self-declared presentation fields. They are self-signed so another party cannot relabel the record without invalidating it, but that signature does not turn the name into a civil identity claim.

## `.wurstid`

Wurster can export a public identity as:

```text
bauer-humpe.wurstid
```

or a copy/paste string:

```text
wurstid-v1-...
```

Both representations are safe to share publicly. They contain public keys and a self-signature, not the Meatphrase or private keys.

A recipient can therefore add an identity to access policy before the owner has ever opened that Wurst.

## Unknown signers

A PigFS commit identifies its signer by Wurster Identity fingerprint and carries/retains the public identity record needed to validate that signature.

A Wurster does not need the signer in its local contacts first.

Without third-party verification it can show:

```text
Bauer Humpe
Self-declared Wurster Identity
wuid:7f91…a822
```

If a future WRST.IO identity certificate binds a verified claim to the same Wurster Identity, the UI can instead show a precise claim such as:

```text
humpe@example.com
✓ Verified by WRST.IO
```

The contact book remains local convenience. It is not a global Wurster account system.

## Federation rule

WRST.IO must not be required to create or use a Wurster Identity.

WRST.IO verification, when present, only adds evidence that a public claim belongs to a key. The key remains usable offline and independently of WRST.IO.
