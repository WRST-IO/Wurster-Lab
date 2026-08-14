---
title: Universal Runtime Law
group: Runtime & Format
groupOrder: 2
order: 2
---

# Universal Wurst Law 🌭🌍

A valid Wurst is the same Wurst on every conforming Wurster runtime.

Windows, macOS, Linux, iOS, Android and future runtimes may use completely different implementation technology. They must agree on the Wurst format, the portable runtime API and its security boundaries.

> Same Wurst semantics, not the same runtime implementation.

## Baseline and optional capabilities

The conforming baseline is the part every Wurster must understand: the WRST container, normal application HTML/CSS/JavaScript, immutable resource integrity, WurstFS semantics, package signatures and the portable Wurster API baseline.

Capabilities are different. A Wurst may declare an optional ability that a particular runtime cannot provide.

That does **not** make the Wurst invalid and does not stop the rest of the application from running.

```js
const lan = await wurst.capabilities.query("network.local");

if (lan.state === "unsupported") {
  // Explain the platform limitation or offer another workflow.
}
```

Current runtime states are intentionally small:

- `available` — declared by the Wurst and implemented by this runtime.
- `unsupported` — declared by the Wurst but unavailable in this runtime.
- `undeclared` — the Wurst did not request it.

Permission-specific states such as user denial can be added as capability brokers become interactive.

## Platform details belong to Wurster

A Wurst does not request Apple Keychain, Windows Hello, Secure Enclave, Android Keystore or a particular browser implementation.

The Wurst asks for portable behavior. The Wurster decides how its platform implements that behavior.

For example, the desktop Wurster may use Electron because controlling Chromium sessions, request boundaries and isolated renderer surfaces is useful. A future iOS Wurster may use WKWebView and native Swift brokers. Android may use the system WebView. Those choices do not alter the Wurst.

## Portable failure is part of portability

A mini-app is allowed to discover that something is not available and remain useful.

A local-model client can run everywhere while explaining that a runtime without local-network access cannot reach the user's Ollama server. A camera tool can still show its imported files on a platform where live camera access is unavailable.

Conformance therefore means understanding the request and denying or marking unavailable what cannot be supplied, not refusing to open the whole Wurst.

## Pigsty follows the same law

Pigsty may exist on Desktop before it exists on mobile or Web. That does not split the Wurst format.

A Wurst can display and edit its data everywhere while enabling source builds only where Pigsty is available. Built output remains ordinary Wurst content or WurstFS state with provenance. The absence of Pigsty disables the build operation, not the Wurst.

## Portable secrets

The same rule applies to cryptography. Meatphrase is the universal recovery/unlock route for user-owned sealed content. Local hardware or OS security may make a particular Wurster more comfortable or safer, but never becomes a requirement embedded in the Wurst file.
