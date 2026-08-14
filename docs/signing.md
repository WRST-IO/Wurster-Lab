---
title: Package Signing
group: Trust & Identity
groupOrder: 4
order: 2
---

# Package Signing

Signing answers a narrow question: does this immutable Wurst application still match the Ed25519 key that signed it?

Unsigned Wursts remain valid. A signature is not a capability grant and it is not an online dependency.

## Create a publisher key

Anonymous/local key:

```text
meatgrinder publisher create --label "My local publisher"
```

Domain claim:

```text
meatgrinder publisher create --domain example.com
```

Email claim:

```text
meatgrinder publisher create --email dev@example.com
```

The private Ed25519 key is stored encrypted in the local `.wurstkey` bundle and protected by its key Meatphrase.

## Sign a Wurst

In the desktop MeatGrinder, signing is a runtime-owned choice. **Unsigned** is the default. Select a stored MeatGrinder signer, press **Start Grinder**, and Wurster asks for local device presence where available before the private publisher key is used. The Wurst app/project never receives that key.

The CLI remains equivalent:

```text
meatgrinder build ./my-project --sign ./example.com.wurstkey
```

If no key Meatphrase source is supplied in an interactive terminal, MeatGrinder asks for it with hidden input. Automation may use `--key-meatphrase-file`; `--key-meatphrase` also exists for direct string input but can appear in shell history.

Wurster-managed signing identities can be created, imported, exported and DNS-checked under **Wurster Settings → MeatGrinder Signers**. Their protected local copies are Wurster convenience state, not part of the Wurst format.

The signature covers the immutable application signing projection: manifest information, application resources, public metadata, built-in child Wurst bytes and PigLink code. Mutable WurstFS generations are deliberately outside this publisher signature so user data can change without invalidating the application.

Signatures identify publishers. They do not grant Pigsty, PigLink or host capabilities.

Changing signed application content invalidates the package signature. Changing or compacting committed WurstFS user data does not.

## Publisher identity is federated

The signing key may make optional identity claims. Wurster can layer different verification methods over the same package signature:

- locally trusted key;
- domain verification through `_wurst.example.com` DNS TXT records;
- optional Authority certificate, such as a verified email identity;
- future independent authorities.

None of these are required for the package signature itself to verify offline.

See [Federated Publisher Identity](federated-publishers.md).
