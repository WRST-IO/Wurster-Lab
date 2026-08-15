---
title: Pigsty
group: Runtime Pillars
groupOrder: 2
order: 4
---
# Pigsty

Pigsty is isolated compute over Wurst-owned files: build, compile, transform, install and generate without turning that work into Host Node/Shell/FS authority.

## Status in 0.33.1

**Experimental / coming soon.** The policy, workspace, changeset and engine contracts are implemented and tested. The native Edge.js/WASIX runtime is still being matured separately and is not bundled or required by normal Windows/macOS/Web releases.

If a requested native engine is unavailable, Pigsty reports unavailable/fails explicitly. It does not silently fall back to Host Node.

## Model

```text
/app        immutable application input
/workspace  mutable job workspace
/toolchain  immutable packaged dependencies
/tmp        ephemeral scratch
    ↓
 Pigsty engine
    ↓
validated changeset
    ↓
PigFS transaction
```

A declared build lives in `wurst.json` under `pigsty.builds`. Runtime code uses:

```js
const status = await wurst.pigsty.status();
const result = await wurst.pigsty.build('site');
```

The result must stay inside declared output paths. Path traversal, Host process access and undeclared writes are rejected by the contracts around the engine.

## Development worker

The small worker engine exists for development/testing and is **not** the final hostile-code sandbox. Enable it explicitly with:

```text
WURSTER_PIGSTY_DEV=1
WURSTER_PIGSTY_ENGINE=worker
```

## Edge/WASIX lane

Native builds use the separately produced `wurster-edge-runtime-<target>` bundle containing Edge, Wasmer, package material and a hash-checked manifest. A development machine may point Wurster at it with `WURSTER_EDGE_RUNTIME_DIR` (and optionally `WURSTER_EDGE_CACHE_DIR`).

Desktop packaging may opt into native runtime acquisition with `WURSTER_BUNDLE_PIGSTY=1`, but this is intentionally outside the normal 0.33.1 release gate.

## Security rule

Pigsty runs **inside the Wurst fence**. It may receive the Wurst/PigFS resources its job contract allows; it may not receive arbitrary Host paths, shell, processes or environment. Protected plaintext must not be materialized onto uncontrolled Host storage for backend convenience.
