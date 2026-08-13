---
title: Wurst Interface
group: Building Wursts
groupOrder: 3
order: 3
---
# Wurst Interface

> Everything has an end. Only Wurst has two.

A Wurst may have two public surfaces:

```text
Visible UI  ←  WURST  →  Wurst Interface
```

The visible end is ordinary HTML, CSS and JavaScript. The other end is a declared machine interface made from **Actions** and **Events**.

The point is not to create a special AI API. The same interface is useful to a visible Wurst UI, an embedding website, an automation tool, a test runner or an AI agent.

## Declaring Actions

Add an `interface` section to `wurst.json`:

```json
{
  "interface": {
    "source": "wurst-interface.js",
    "headless": true,
    "actions": {
      "math.add": {
        "description": "Add two numbers.",
        "readOnly": true,
        "input": {
          "type": "object",
          "properties": {
            "a": { "type": "number" },
            "b": { "type": "number" }
          },
          "required": ["a", "b"]
        },
        "output": {
          "type": "object",
          "properties": {
            "sum": { "type": "number" }
          },
          "required": ["sum"]
        }
      }
    }
  }
}
```

`source` is a project-relative JavaScript file. MeatGrinder packs it as a dedicated Interface resource rather than normal visible application content.

## Implementing Actions

The Interface source uses one tiny portable global:

```js
WurstInterface.define({
  actions: {
    "math.add": ({ a, b }) => ({ sum: a + b })
  }
});
```

There is no Node requirement. Interface code should be plain JavaScript and may use the Wurst runtime API that exists in the current execution mode.

A visible Wurst may call its own second end:

```js
const result = await wurst.interface.invoke("math.add", {
  a: 20,
  b: 22
});

console.log(result.sum); // 42
```

That is intentional. UI code and machine control do not need two independent business-logic APIs.

## Events

Actions travel into a Wurst. Events travel out.

Declare an event:

```json
{
  "events": {
    "project.saved": {
      "description": "The current project was saved.",
      "payload": {
        "type": "object"
      }
    }
  }
}
```

Emit it from Interface code:

```js
wurst.interface.emit("project.saved", {
  revision: 12
});
```

A future Web Wurster can map the same event onto its host communication channel. A desktop host, AI bridge or test harness can do the same. The Wurst contract stays unchanged.

## Embedded Web Wursts

The intended Web Wurster model is an isolated visible Wurst plus a message channel owned by the runtime:

```text
Host website
    ↓ invoke()
Web Wurster broker
    ↓
isolated Wurst
    ↑ events
```

The host talks to declared Actions, not to the Wurst DOM. The same Wurst Interface remains valid when the Wurst is opened normally, embedded into a page, or executed headlessly.

## Headless

`"headless": true` means the developer declares that the Interface can run without the visible DOM.

Do not mark an Action headless if it fundamentally requires layout, Canvas, WebGL or arbitrary page DOM state. The Wurst can still expose other machine-friendly Actions next to its visual features.

See [Headless Wursts](headless.md).
