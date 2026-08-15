---
title: Universal Runtime Law
group: Runtime & Format
groupOrder: 2
order: 2
---
# Universal Wurst law

A valid Wurst is the same Wurst on every conforming Wurster runtime.

> Same Wurst semantics, not the same runtime implementation.

Desktop may use Electron, iOS may use WKWebView and another runtime may use something entirely different. The portable contract must still agree on WRST, PigFS, PigLink, Piglet relationships, protection and capability semantics.

## Baseline versus optional capability

A runtime must understand the portable contract even when a host feature is unavailable. A camera or local-network feature may report `unsupported`; the Wurst should still open and choose its fallback UX.

Host-specific facilities such as Touch ID, Windows Hello, Secure Enclave or a keystore are Wurster implementation details. They never become requirements encoded into the Wurst.

## Two ends, one Wurst

Human and machine access are two ways into the same portable world:

```text
human View → Wurst ← PigLink machine client
```

`<wurst-embed>` attaches a human View. `wurst.piglet.connect()` attaches a machine end for a Child that declares `piglink.headless: true`. Desktop/Web can attach both to one durable session; the browserless harness can use Child Wursts as subtools.

The remaining parity gap is cross-process transport: an external CLI/MCP cannot yet join a session already owned by another Wurster process.

## Security law

Portability never means Host access. Wurst code receives portable, mediated behavior, not raw Host FS/process/shell/environment APIs or Wurster-held secrets.

Pigsty follows the same law. A Wurst may remain useful where Pigsty is unavailable; missing compute disables the operation, not the Wurst.
