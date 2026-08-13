---
title: Headless Development Harness
group: Building Wursts
groupOrder: 3
order: 4
---
# Headless Wursts

A headless Wurst runs its declared Wurst Interface without opening the visible UI.

This is useful for automated tests, build verification, command-line automation and machine control.

## Developer harness

Wurster Lab 0.20.0 includes a browserless development harness:

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

A Wurst may ship small Interface tests in its manifest:

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

## Security status in 0.20.0

The 0.20.0 command-line harness is for Wursts you are developing or otherwise trust. It uses a disposable Node worker and a restricted JavaScript context so that AI/build tooling can exercise Wurst Actions today, but it is **not** the final production sandbox for hostile third-party code.

A production headless Wurster must execute Interface code inside a real untrusted-code boundary with explicit CPU, memory and capability budgets. This limitation is deliberately documented rather than hidden behind a heroic pig costume.

The portable Wurst Interface itself does not depend on the development harness. A Web Wurster, desktop Wurster, iOS Wurster or future runtime can provide its own conforming executor.

## Long-running stdio control

For an AI agent or another local process, starting a new JavaScript runtime for every command is unnecessary. The harness therefore also supports JSON-lines over standard input/output:

```bash
wurster-headless stdio calculator.wurst
```

Request:

```json
{"id":1,"method":"interface.describe"}
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
