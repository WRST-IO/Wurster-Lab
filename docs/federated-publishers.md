---
title: Federated Publisher Identity
group: Trust & Identity
groupOrder: 4
order: 3
---

# Federated Publisher Identity

Wurst signing has no required central authority.

Every publisher may generate an Ed25519 key locally and sign Wursts with it. The package signature is completely offline-verifiable and means only that the immutable signed application matches the key that signed it.

Identity is optional information layered on top of that key.

```text
package integrity     Ed25519 signature          offline
publisher identity    local / domain / authority optional
runtime capabilities  Wurster + user             separate
```

A valid Wurst does not need a signature, an account, a marketplace or an online service.

## Local publisher keys

Create an anonymous key:

```text
meatgrinder publisher create --label "My local key"
```

Or attach identity claims:

```text
meatgrinder publisher create --domain example.com --label "Example"
meatgrinder publisher create --email dev@example.com
```

Claims are not trusted merely because the publisher key contains them. They are signed claims that another mechanism may verify.


## Wurster-managed publisher identities

The desktop runtime can keep publisher identities in the same local secure identity manager used for Wurster convenience state. User Meat Identities and MeatGrinder publisher identities are deliberately separate categories: a user Meatphrase unlocks user-owned WurstFS content, while a publisher identity signs immutable application builds.

The MeatGrinder UI defaults to unsigned. Developers may create or select a stored publisher signer and optionally verify its domain directly from the UI. Signing asks the runtime for local device presence where supported. A stored signer can later be exported as its normal `.wurstkey`, so the Wurster-managed copy does not create a proprietary signing format.

Domain verification may happen before or after the first signed build. A valid package signature made before DNS verification stays the same package signature; once `_wurst.<domain>` authorizes the fingerprint, Wurster can additionally display that domain identity as verified.

## Domain verification

A domain can authorize a Wurst publisher key without asking wrst.io for permission.

For a key whose SHA-256 SPKI fingerprint is `abc...`, MeatGrinder prints a TXT record in this form:

```text
_wurst.example.com TXT "wurst1 ed25519=<64-hex-fingerprint>"
```

Multiple TXT records may authorize multiple active publisher keys.

When Wurster opens a signed Wurst that claims `example.com`, it may query `_wurst.example.com`.

There are deliberately different outcomes:

- **verified** — Wurst's signing key is currently listed by the domain.
- **unverified** — no Wurst TXT record exists, or the domain cannot currently be checked.
- **previously verified** — Wurster has a locally cached successful verification but cannot reach DNS now.
- **identity conflict** — valid Wurst TXT records exist, but none authorize this Wurst's signing key.

An identity conflict is not the same thing as an invalid package signature. The package may be cryptographically intact while its claimed domain identity conflicts with the domain's current statement. Wurster warns clearly and lets the user decide whether to continue.

Successful domain verification may be cached locally. Existing Wursts never become dependent on DNS in order to remain valid files.

## WRST.IO Authority

Wurster 1.0 ships **one Authority root trusted by default: `wrst.io`**. It certifies exact publisher claims such as domain or email control through the WRST.IO Authority Worker. The resulting `wurst/publisher-certificate-3` embeds its Root → issuer chain and remains verifiable offline. Labels remain self-declared unless a future verification method explicitly proves them.

The Authority does not replace direct domain verification or local key trust. A publisher may use only its package signature, let its domain speak directly through `_wurst.<domain>`, or obtain a WRST.IO certificate. These are separate trust routes to the same publisher key.

The older local Authority CLI remains useful for lab/private-root experiments, but it is not the official WRST.IO production issuance path. The V1 runtime has no built-in third-party Authority roots or management UI. The certificate format remains structurally capable of future additional roots without making them part of the V1 trust policy.

The private publisher key never leaves the device that created it.

## Identity never grants capabilities

A verified domain, verified email or locally trusted key does not receive extra runtime privileges.

```text
whitehouse.gov ✓
```

still does not imply access to network, files, camera, microphone, WurstFS or any other capability.

Package integrity, publisher identity and runtime permissions are separate questions.

## Future user attestations

A later Wurster version may let the trusted runtime sign a committed WurstFS state on behalf of a local identity. A Wurst could request such a signing ceremony through a Wurster-owned control, but would never receive the private signing key itself.

That is intentionally post-1.0 work. The V1 publisher model establishes the key and identity foundation it can later reuse.
