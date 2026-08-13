---
title: Wurst Manifest
group: Building Wursts
groupOrder: 3
order: 2
---
# Wurst manifest / WRST v7

`wurst.json` is optional. MeatGrinder can build an ordinary browser-ready folder directly. Add a manifest only when the Wurst needs explicit runtime behavior.

```json
{
  "id": "io.wrst.example",
  "name": "Example Wurst",
  "version": "0.20.0",
  "type": "widget",
  "entry": "index.html",
  "source": "src",
  "versionedOutput": true,

  "application": {
    "protection": "public"
  },

  "data": {
    "format": "wurst/data-realms-1",
    "writable": true,
    "realms": [
      { "id": "workspace" },
      { "id": "private", "governance": "personal" }
    ]
  },

  "protection": {
    "storedIdentity": true
  },

  "capabilities": {}
}
```

MeatGrinder emits `format: "wurst/7"` into the built package manifest.

## Application protection

`application.protection` controls immutable application content:

```json
{ "application": { "protection": "public" } }
```

```json
{ "application": { "protection": "partial" } }
```

```json
{ "application": { "protection": "sealed" } }
```

- `public`: application files are ordinary immutable package resources.
- `partial`: public app files remain readable; developer-protected files from `sealed/` require the WurstKey when requested.
- `sealed`: the complete application resource map and protected application files require the WurstKey before entry code runs.

WurstKey protects developer-owned immutable content. It is independent of WurstFS user data.

## Mutable WurstFS data

Mutable data is declared only through `data`:

```json
{
  "data": {
    "format": "wurst/data-realms-1",
    "writable": true,
    "realms": [
      { "id": "gallery" }
    ]
  }
}
```

An ordinary realm has no `governance` field. That is the simplest default: mutable public app data, no identity, no signatures and no retained audit history.

### Personal realm

```json
{
  "id": "private",
  "governance": "personal"
}
```

Personal data is always sealed, owner-only and non-shareable. `protection`, `read` and `write` are intentionally omitted because their values are defined by personal governance.

### Shared realm

```json
{
  "id": "committee",
  "governance": "shared",
  "protection": "sealed",
  "read": "owner",
  "write": "owner",
  "audit": "none"
}
```

Shared realms opt into Wurster Identity based read/write/admin policy. `protection` may be `public` or `sealed`. `audit` may be `none` or `signed`.

Multiple realm kinds may coexist in one Wurst.

A project may not bake runtime mutable content through a top-level `data/` source directory. Immutable seed content belongs in the application package (`src/` or developer-protected `sealed/`). Runtime WurstFS starts as runtime-owned mutable state.

## Identity release

```json
{
  "protection": {
    "storedIdentity": true
  }
}
```

`storedIdentity` only controls whether Wurster Auth may offer locally stored Meat Identities. It never changes the portable cryptography. `false` means the user must provide the portable identity secret directly instead of using the local locker.

A Wurst may place:

```html
<wurster-auth type="identity" purpose="filesystem"></wurster-auth>
```

or request a specific realm:

```html
<wurster-auth type="identity" purpose="realm" target="private"></wurster-auth>
```

The visible trusted auth surface belongs to Wurster, not the Wurst DOM.

## Capabilities

Capabilities are explicit opt-ins. Examples:

```json
{
  "capabilities": {
    "network.fetch": true,
    "files.open": true,
    "files.save": true
  }
}
```

The runtime reports whether a declared capability is actually available on that platform. Unsupported capabilities do not silently become unrestricted host access.

`files.open` and `files.save` are trusted user-selected host-file bridges. Desktop Wurster owns the file dialogs and returns only the selected file/destination. They are RED capabilities and require a valid package signature.

## Wurst Interface

A Wurst may declare Actions and Events for headless/agent use:

```json
{
  "interface": {
    "format": "wurst/interface-1",
    "headless": true,
    "actions": {
      "ping": {
        "input": { "type": "object" },
        "output": { "type": "object" }
      }
    }
  }
}
```

The same declared interface is used by embedded UI and headless tooling.

## Platform-specific behavior

A Wurst describes intent, not OS-specific authentication mechanisms. Touch ID, Windows Hello, browser handoff and similar platform details belong to Wurster implementations. Portable Wurst cryptography must not depend on one operating system.
