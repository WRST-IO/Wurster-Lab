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
  "version": "0.32.0",
  "type": "widget",
  "entry": "index.html",
  "source": "src",
  "versionedOutput": true,

  "application": {
    "protection": "public"
  },

  "pigfs": {
    "format": "wurst/pigfs-policy-1",
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

WurstKey protects developer-owned immutable content. It is independent of PigFS user data.

## Mutable PigFS data

Mutable data is declared only through `pigfs`:

```json
{
  "pigfs": {
    "format": "wurst/pigfs-policy-1",
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

A project may not bake runtime mutable content through a top-level `data/` source directory. Immutable seed content belongs in the application package (`src/` or developer-protected `sealed/`). Runtime PigFS starts as runtime-owned mutable state.

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

## PigLink

A Wurst may declare Actions and Events for headless/agent use:

```json
{
  "piglink": {
    "format": "wurst/piglink-1",
    "source": "piglink.js",
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

The same declared PigLink is used by embedded UI, child Wursts, headless tooling and future MCP/CLI adapters.

The old `interface` manifest field was removed before 1.0. Use `piglink`.

## Pigsty

Pigsty is declared as a runtime capability, not as bundled host access:

```json
{
  "pigsty": {
    "version": "node-lts-1",
    "tools": ["eleventy", "typescript"],
    "offline": true,
    "builds": {
      "site": {
        "source": "pigsty-build.js",
        "description": "Build the static site artifacts.",
        "outputs": ["dist"]
      }
    }
  }
}
```

This does not make Node a universal Wurst requirement. A runtime without Pigsty still opens the Wurst and reports Pigsty as unavailable for build operations.

`pigsty.builds` declares named build scripts stored inside the Wurst app workspace. A runtime with Pigsty can run one with `wurst.pigsty.build("site")`.

Engine selection is deliberately not part of the manifest. A Wurst asks for Pigsty; Wurster decides whether the local runtime can provide a conforming internal engine. Fields such as `mode: "node"` are rejected rather than treated as a host-Node fallback.

Successful declared builds may be published as `wurst/pigsty-publication-1` workspace files under `data/builds/<build>/...`. The publication stores generated artifacts separately from authored source and writes a `wurst/pigsty-artifact-store-1` record so Wurster can later report `fresh`, `stale`, `missing` or `invalid` instead of guessing whether source and generated output still match.

## Piglet

Child Wursts are ordinary Wurst resources handled through the Piglet runtime system. A fixed built-in child is immutable content whose exact bytes are covered by the parent signature and whose own package signature is checked independently.

Installed child Wursts live as ordinary `.wurst` / `.wrst` files in the parent's mutable PigFS state and are verified independently of the parent package signature. They are not added to `piglet.children`, because that manifest field describes immutable package content only.

Current built-in child syntax:

```json
{
  "piglet": {
    "children": [
      {
        "id": "child-tool",
        "source": "child-tool.wurst",
        "label": "Child Tool"
      }
    ]
  }
}
```

MeatGrinder writes the exact child bytes into immutable `piglet` scope and records their hash in the parent manifest. It never rebuilds or re-signs the child. Runtime-installed children require no manifest entry; Piglet discovers valid Wurst files from readable PigFS realms.

## Platform-specific behavior

A Wurst describes intent, not OS-specific authentication mechanisms. Touch ID, Windows Hello, browser handoff and similar platform details belong to Wurster implementations. Portable Wurst cryptography must not depend on one operating system.
