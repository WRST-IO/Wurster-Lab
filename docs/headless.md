---
title: Headless Development Harness
group: Building Wursts
groupOrder: 3
order: 4
---
# Headless Wursts

A headless Wurst runs its declared PigLink without opening the visible UI.

This is useful for automated tests, build verification, command-line automation and machine control.

## Developer harness

Wurster Lab 0.32.0 includes a browserless development harness:

```bash
wurster-headless describe app.wurst
wurster-headless invoke app.wurst math.add --input '{"a":20,"b":22}'
wurster-headless test app.wurst
```

Machine-readable output is available with `--json`.

Example:

```bash
wurster-headless invoke calculator.wurst math.add \
  --input '{"a":20,"b":22}' \
  --json
```

returns a JSON result instead of pixels.

## Self-tests

A Wurst may ship small PigLink tests in its manifest:

```json
{
  "tests": [
    {
      "name": "forty-two",
      "action": "math.add",
      "input": { "a": 20, "b": 22 },
      "expect": { "sum": 42 }
    }
  ]
}
```

Then:

```bash
wurster-headless test calculator.wurst
```

can verify the Action contract without Chromium.

## Security status in 0.32.0

The 0.32.0 command-line harness is for Wursts you are developing or otherwise trust. It uses a disposable Node worker and a restricted JavaScript context so that AI/build tooling can exercise Wurst Actions today, but it is **not** the final production sandbox for hostile third-party code.

## Pigsty Through PigLink

Headless PigLink exposes the same controlled Pigsty surface as Desktop for declared Pigsty Wursts:

```js
PigLink.define({
  actions: {
    async build() {
      const status = await wurst.pigsty.status();
      const result = await wurst.pigsty.build('site');
      return { state: status.state, artifacts: result.artifacts };
    }
  }
});
```

The headless harness seeds Pigsty with the Wurst's public `app` resources and overlays any `workspace` files supplied by the action. The default harness still uses the small `Pigsty.define(...)` worker for development builds. Declared builds can request Edge.js/WASIX explicitly:

```js
const result = await wurst.pigsty.build('site', {
  engine: 'edge-wasix'
});
```

If the Wurst carries `pigsty-toolchain/node_modules/...`, the headless harness extracts that tree into Pigsty's immutable `/toolchain` mount before invoking Edge. This is the intended offline path for dependencies such as Eleventy, Vite or Vue compiler packages.

`WURSTER_PIGSTY_ENGINE=edge-wasix` makes Edge/WASIX the default build engine. The preferred runtime input is a manifest-checked bundle:

```bash
WURSTER_EDGE_RUNTIME_DIR=/opt/wurster/runtimes/wurster-edge-runtime-linux-amd64
WURSTER_EDGE_CACHE_DIR=/tmp/wurster-pigsty-edge-cache
```

The bundle contains Edge, Wasmer, the Edge/WASIX package and a `manifest.json` that identifies the platform target and required file hashes. Status probes report whether this bundle is configured, whether it is bundled, which target it serves and whether `edge --safe` can actually start. `WURSTER_EDGE_BIN` or `PIGSTY_EDGE_BIN` remain available for local adapter diagnosis, but production harnesses should use the runtime directory.

If Edge is selected and unavailable, the build fails explicitly; the harness does not silently fall back to the worker. It still does not expose arbitrary host `fs`, shell or host process access to Wurst code.

A production headless Wurster must execute PigLink code inside a real untrusted-code boundary with explicit CPU, memory and capability budgets. This limitation is deliberately documented rather than hidden behind a heroic pig costume.

Portable PigLink itself does not depend on the development harness. A Web Wurster, desktop Wurster, iOS Wurster or future runtime can provide its own conforming executor.

## Long-running stdio control

For an AI agent or another local process, starting a new JavaScript runtime for every command is unnecessary. The harness therefore also supports JSON-lines over standard input/output:

```bash
wurster-headless stdio calculator.wurst
```

Request:

```json
{"id":1,"method":"piglink.describe"}
```

Invoke an Action:

```json
{"id":2,"method":"actions.invoke","params":{"name":"math.add","input":{"a":20,"b":22}}}
```

Run the Wurst's self-tests:

```json
{"id":3,"method":"tests.run"}
```

Every request receives one JSON response with the same `id`. This is deliberately boring. Machines enjoy boring protocols almost as much as pigs enjoy unattended sandwiches.
