---
title: PigLink
group: Runtime Pillars
groupOrder: 2
order: 2
---
# PigLink

PigLink is the declared machine API of a Wurst. It connects Wursts, UI code and automation through typed Actions and Events instead of treating the DOM as an API.

## Declaration

A Wurst declares its PigLink entry, Actions, Events and JSON schemas in `wurst.json`. A headless-capable contract adds:

```json
{
  "piglink": {
    "format": "wurst/piglink-1",
    "entry": "piglink.js",
    "headless": true
  }
}
```

Handlers register with `PigLink.define(...)`; application code emits declared Events through `wurst.piglink.emit(...)`. Inputs, outputs and Events are validated at runtime boundaries.

## Parent and Child

A normal Piglet gets direct Parent↔Child PigLink when the Parent declares PigLink. The Parent can call the Child through `<wurst-embed>`:

```js
const editor = document.querySelector('wurst-embed');
await editor.ready;
await editor.piglink.invoke('document.open', { path: '/workspace/readme.md' });
```

The Child reaches the Parent through `wurst.parent.piglink`. This is a direct relationship, not a global event bus.

## Machine end

A `headless: true` Child can be used without a View:

```js
const tool = await wurst.piglet.connect('/workspace/tools/TexturePacker.wurst');
const result = await tool.piglink.invoke('textures.pack', input);
const off = tool.piglink.on('progress', console.log);
await tool.close();
```

`wurst.piglet.invoke(ref, action, input)` is the one-shot form. On Desktop/Web a machine client and human Views of the same Child share one durable Wurst session. The browserless harness can also drive Child Wursts as DOM-free subtools.

## Security boundary

PigLink makes internal behavior connection cheap; it does not inherit Host authority. Parent PigFS/Piglet services are separate explicit delegations, and Host files, shell/process/environment, Auth, Identity keys and WurstKeys are not Parent PigLink services.

Wurster records host-boundary-relevant combinations as authority-composition metadata rather than prompting for every internal connection.

## Still pre-stable

Open work includes external cross-process attachment to an already running Wurst session, stronger lifecycle/revoke semantics, generic resource/stream handles where needed and deeper recovery testing.
