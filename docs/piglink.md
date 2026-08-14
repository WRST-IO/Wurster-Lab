---
title: PigLink
group: Runtime Pillars
groupOrder: 2
order: 2
---
# PigLink

> Everything has an end. Only Wurst has two.

PigLink is the declared machine side of a Wurst. The visible side is normal HTML, CSS and JavaScript for humans. PigLink is the other side: actions, events and eventually streams, resource handles and Wurst handles for other runtimes, tools and Wursts.

```text
Visible UI  <-  WURST  ->  PigLink
```

PigLink replaces the older "Wurst Interface" wording. The concept is not a separate Wurst type and not a global event bus. It is the native communication contract for one running Wurst instance.

## Status In 0.32.2

The declared Action/Event contract is functional. MeatGrinder signs and packages PigLink code separately from the visible app, Desktop and the headless harness can invoke Actions with schema validation, and Events are validated at the runtime boundary. The Web runtime exposes the same declaration surface.

What is not finished yet is the broker between separate running Wurst instances: runtime handles, connect/disconnect/revoke lifecycle, streams/resource handles and capability-composition approval remain follow-up work. PigLink is therefore active in v0.32 without pretending that cross-Wurst linking is already complete.

## Declaring Actions

Add a `piglink` section to `wurst.json`:

```json
{
  "piglink": {
    "source": "piglink.js",
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

`source` is a project-relative JavaScript file. MeatGrinder packs it as a dedicated PigLink resource rather than ordinary visible application content.

## Implementing Actions

PigLink source uses one tiny portable global:

```js
PigLink.define({
  actions: {
    "math.add": ({ a, b }) => ({ sum: a + b })
  }
});
```

There is no Node requirement. PigLink code should be plain JavaScript and may use the Wurst runtime API that exists in the current execution mode.

A visible Wurst may call its own second end:

```js
const result = await wurst.piglink.invoke("math.add", {
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

Emit it from PigLink code:

```js
wurst.piglink.emit("project.saved", {
  revision: 12
});
```

A Web Wurster, desktop Wurster, CLI harness, AI bridge or MCP adapter can map the same event onto its host communication channel. The Wurst contract stays unchanged.

## Identity, Locator And Handle

PigLink keeps three concepts separate:

- Application identity describes which app is meant.
- A locator says where bytes can be found.
- A runtime handle identifies one running instance.

Do not use a file path, URL or package id as an implicit authority to talk to every matching Wurst. A link is created by Wurster's broker and has an explicit lifecycle.

## Capability Composition

PigLink transfers behavior, not trust. A linked Wurst does not automatically receive the other side's permissions.

The broker still has to reason about composed authority. Connecting a Wurst that can read local files to a Wurst that can send network requests may create an effective "file to network" path even though neither Wurst declared both capabilities. That connection can require its own user approval.

Central rule:

```text
PigLink connects behavior, not trust.
A PigLink may never silently compose authority that was not granted together.
```

## Headless

`"headless": true` means the developer declares that PigLink can run without the visible DOM.

Do not mark an Action headless if it fundamentally requires layout, Canvas, WebGL or arbitrary page DOM state. The Wurst can still expose other machine-friendly Actions next to its visual features.

See [Headless Wursts](headless.md).
