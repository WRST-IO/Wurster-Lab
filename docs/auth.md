---
title: Wurster Auth
group: Security & Trust
groupOrder: 4
order: 3
---
# Wurster Auth

`<wurster-auth>` is a Wurster-owned trusted authentication surface anchored at a location chosen by the Wurst UI.

```html
<wurster-auth type="identity" purpose="filesystem"></wurster-auth>
```

For a specific identity-backed realm:

```html
<wurster-auth type="identity" purpose="realm" target="private"></wurster-auth>
```

For developer-owned application encryption:

```html
<wurster-auth type="wurstkey" purpose="application"></wurster-auth>
```

The Wurst controls placement, not the trusted UI contents. Wurster owns the authentication renderer and result binding.

Identity authentication can initialize identity-backed PigFS realms on first use. An unclaimed personal realm binds to the authenticated Wurster Identity when that realm is explicitly opened.

WurstKey authentication is independent from Wurster Identity and PigFS data protection.

Stored Meat Identities are a local runtime convenience. Portable recovery remains the identity's Meatphrase; platform-local user-presence mechanisms do not change Wurst cryptography.
