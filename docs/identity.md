---
title: Wurst Identity Seal
group: Trust & Identity
groupOrder: 4
order: 4
---
# Wurst Identity Seal

A Wurst may place a runtime-owned publisher identity seal anywhere in its visible UI:

```html
<wurst-identity></wurst-identity>
```

The element is optional. It is useful in About screens, publisher cards, settings pages or anywhere a Wurst wants to make its signed identity easy to inspect.

## The badge is an anchor, not the trust boundary

Desktop Wurster treats `<wurst-identity>` like `<wurster-auth>`: the Wurst DOM only contributes a rectangle. Wurster overlays that rectangle with a separate sandboxed `WebContentsView` owned by the runtime.

The Wurst cannot read or rewrite the contents of that trusted surface. The seal shows the publisher identity and one of the runtime's current trust states:

- verified domain / trusted Authority / locally trusted signing key;
- valid signature whose publisher is not independently verified;
- unsigned package;
- invalid signature, certificate or publisher-domain conflict.

A Wurst can still draw a fake green badge elsewhere with ordinary HTML. That is why the visual badge alone is never the final proof.

## Click to ask Wurster

Clicking the real seal opens Wurster's own Identity Verification window. That window is outside the Wurst renderer and repeats the package result using runtime-owned UI:

- Wurst name and version;
- publisher identity;
- trust route;
- Ed25519 package-integrity result;
- publisher fingerprint;
- source file when Wurster has one.

This second step is the important anti-spoof property. A Wurst can imitate the appearance of a seal, but it cannot make Wurster open its trusted verification window and confirm a false package identity.

## Verify before opening

Wurster can also inspect a package without executing its application:

```text
Wurster → File → Verify Wurst Identity…
```

On Windows, the assisted installer adds **Verify Wurst Identity** to the Explorer context menu for the Wurster-owned `.wurst` and `.wrst` ProgIDs only. The command starts Wurster with a verification-only launch argument and does not open the Wurst application.

macOS keeps normal `.wurst` / `.wrst` Finder/Open-With association. A dedicated Finder contextual command is deliberately not installed in this release because Apple's Finder extension models require a native extension and are not a clean extension-only registration across arbitrary folders. macOS users get the same verification-only flow from Wurster's File menu without broad Finder monitoring.

## Trust stays separate from capability

Identity verification never grants a Wurst extra capabilities. It answers "who signed this immutable package, and does this Wurster have an independent reason to trust that identity?" Runtime permissions remain a separate decision.
