---
title: MeatGrinder
group: Building Wursts
groupOrder: 3
order: 1
---
# MeatGrinder

MeatGrinder turns a browser-ready web project into one Wurst.

Open Wurster itself and flip the launcher to **MeatGrinder**. The desktop UI accepts a project folder or ZIP and an optional PNG/JPEG carrier image. Press **Start Grinder** and the project is scanned, packed and written next to the source. The picture shakes because a silent meat grinder would be suspicious.

## Zero configuration

`wurst.json` is optional.

Without one, MeatGrinder uses the folder or ZIP name as the Wurst name, prefers `index.html`, ignores common build junk such as `.git`, `node_modules` and `dist`, creates a normal framed resizable window, and emits an unsigned public Wurst.

If there is no `index.html`, MeatGrinder uses the first HTML file it finds. If there is no HTML entry at all, it stops rather than declaring a random JavaScript file emperor of the sausage.


## GUI signing

MeatGrinder is unsigned by default. The desktop MeatGrinder now has a compact **Signing** selector between the project source and the output controls.

A Wurster may keep any number of local MeatGrinder signing identities in its Meat Locker. A signing identity contains an Ed25519 publisher key plus optional label, domain and email claims. The private key bundle and its Publisher Meatphrase are protected by the runtime's local secure storage. Where the runtime exposes device-presence verification, Wurster asks for that approval before every signed build.

Creating a signer from the GUI supports either a directly entered Publisher Meatphrase or a freshly generated one. An unverified signer may still sign; verification describes publisher identity and never grants capabilities.

Publisher identities can also be managed under **Wurster Settings → MeatGrinder Signers**. From there a developer can use either trust route:

- **Direct DNS** publishes `_wurst.<domain>` and lets a connected Wurster check the publisher key directly.
- **Verified by WRST.IO** turns a one-time proof into an offline-verifiable `.wurstcert`. A domain uses the short-lived `_wurst-authority.<domain>` TXT challenge. An email claim receives a six-digit code from `oink@wrst.io`. Only the exact claims WRST.IO actually proves become verified; a display label remains self-declared.

The Settings UI can start and complete both WRST.IO domain and email verification, reveal the Publisher Meatphrase after local user verification, export the `.wurstkey` for backup or another machine, import an existing `.wurstkey`, or remove the local copy. A stored `.wurstcert` follows the signer and is automatically embedded in later GUI-signed Wursts.

GUI signing does not write a temporary plaintext Meatphrase file. MeatGrinder receives the protected key material from Wurster in memory for that build.

## Undercover output

Drop a PNG or JPEG into the optional carrier slot. JPEG is converted locally to PNG, then the Wurst is pressed into private PNG `wuSt` chunks. The result is a valid image and a valid Wurst source.

## CLI

The GUI is convenience. The CLI remains first-class:

```bash
meatgrinder build ./project
meatgrinder inspect ./project.wurst
meatgrinder verify ./project.wurst
```

Sign from the CLI with a key file. The Meatphrase may come from hidden interactive input, a direct argument, an environment variable, or a file for automation:

```bash
meatgrinder build ./project --sign ./yourwurstdomain.wurstkey
meatgrinder build ./project --sign ./yourwurstdomain.wurstkey --key-meatphrase "your phrase"
```

`--key-meatphrase` is convenient but may be retained by shell history. The hidden prompt or the Wurster-managed GUI signer is preferable for ordinary interactive use.

### WRST.IO verification from the CLI

Create the signed request once from the local publisher key:

```bash
meatgrinder publisher request ./publisher.wurstkey --out ./publisher.wurstreq
```

For a domain claim:

```bash
meatgrinder authority challenge ./publisher.wurstreq --out ./publisher.wurstchallenge
# publish the printed TXT record
meatgrinder authority complete ./publisher.wurstreq \
  --challenge ./publisher.wurstchallenge \
  --out ./publisher.wurstcert
```

For an email claim:

```bash
meatgrinder authority email-challenge ./publisher.wurstreq --out ./publisher.wurstmailchallenge
# read the six-digit code delivered from oink@wrst.io
meatgrinder authority email-complete ./publisher.wurstreq \
  --challenge ./publisher.wurstmailchallenge \
  --out ./publisher.wurstcert
```

When the same publisher key has already proved one claim, pass `--certificate ./publisher.wurstcert` while completing the next proof. WRST.IO verifies the existing certificate before merging its already verified claims into the new certificate. The private publisher key and Publisher Meatphrase never go to WRST.IO.

The public `wrst.io/verify/` page offers the same domain and email flow for a locally created `.wurstreq`; it also verifies returned certificates in the browser against Wurster's pinned WRST.IO Root before displaying **Verified by WRST.IO**.

Generate developer application key material:

```bash
meatgrinder wurstkey
```

Generate a user Meatphrase:

```bash
meatgrinder meatphrase 12
```

See [manifest.md](/docs/manifest/) for optional special sauce such as frameless windows, capabilities, WurstFS realms and application sealing.


## Machine-friendly Wursts

Add an optional `interface` section when the Wurst should expose declared Actions and Events to its own UI, an embedding host, test tools or AI. See [Wurst Interface](/docs/wurst-interface/).
