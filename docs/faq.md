---
title: FAQ
group: Project
groupOrder: 6
order: 1
---
# FAQ

## Is Wurst a website archive?

No. It is an application container and runtime format that happens to use web languages internally.

## Does every project need wurst.json?

No. A folder with browser-ready files and an HTML entry can be ground directly. The manifest is for special behavior.

## Does a Wurst need Apple Keychain or Windows Hello?

No. Never as part of the file. Local Wurster implementations may use platform security to protect stored Meat Identities, but manual Meatphrase recovery remains universal.

## What is the difference between WurstKey and Meatphrase?

WurstKey protects developer-owned immutable application content. A Wurster Identity derived from a Meatphrase can protect personal/shared mutable WurstFS realms.

## Can user data be unencrypted?

Yes. Ordinary WurstFS realms are mutable public app data: no identity, no encryption, no signatures and no retained audit history. Personal and sealed shared realms are encrypted.

## Why not just one index.html?

A single HTML file is great. Wurst starts where it stops being enough: when state should travel with the app, assets and project structure grow, offline publisher identity matters, capabilities need to be declared or the app needs PigLink as a machine-readable second end.

## Is Wurster an operating system?

No. Wurster should provide a few strong primitives: WRST, WurstFS, the renderer sandbox, the capability broker, Pigsty, Piglet and PigLink. Higher-level systems such as WurstOS can be Wursts.

## Can a Wurst contain gigabytes of media?

The format supports random-access resource slices and chunked protection. Large immutable reads are already designed around that model. Mutable multi-gigabyte repacking is still an active format problem.

## Is Undercover Wurst steganography?

Not in the strong sense. It is a valid PNG with private application chunks. It is camouflage, not a substitute for encryption.

## Why is it called Wurst?

Because `PortableApplicationContainer` had no chance against a pig and a meat grinder.
