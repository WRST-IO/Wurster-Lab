---
title: Wurster Runtime
group: Runtime & Format
groupOrder: 2
order: 1
---
# Wurster Runtime

Wurster opens and mediates Wursts. The application runs in a sandboxed web environment with Node integration disabled; Host filesystem, network and privileged features are reached only through Wurster-owned brokers.

## Portable state

A Wurst that declares PigFS receives `wurst.pigfs`. Paths such as `/workspace`, `/private` and `/derived` are Wurst paths, never Host paths. PigFS provides durable state, transactions, snapshots, stable object IDs and optional realm protection.

`wurst.snapshot.export()` writes the current committed Wurst through trusted Wurster save UI. Uncommitted transactions are not included.

## Views, sessions and Piglets

Desktop and Web present Wursts with the same element:

```html
<wurst-embed src="/workspace/apps/Editor.wurst"></wurst-embed>
```

Inside a running Wurst this is a Piglet relationship. `<wurst-embed>` is only a human View: layout belongs to ordinary HTML/CSS.

Opening the same PigFS-held Child in multiple Views does not clone its durable world. Views share one runtime Wurst session and Child PigFS revision while their DOM/tab/cursor state stays local. `wurst.piglet.running()` reports the active Child sessions and View/Machine attachment counts.

A `piglink.headless: true` Child also exposes the machine path:

```js
const tool = await wurst.piglet.connect('/workspace/tools/Tool.wurst');
const result = await tool.piglink.invoke('run', input);
await tool.close();
```

`wurst.piglet.invoke(ref, action, input)` is the one-shot form. Machine commits and View commits share the same session revision; stale full-snapshot writers fail with `WURST_SESSION_CONFLICT`.

## Parent cooperation

Normal Parent↔Child PigLink is cheap. Broader Parent authority is explicit:

```html
<wurst-embed src="FileExplorer.wurst" parent-pigfs="read-write"></wurst-embed>
<wurst-embed src="ProgramManager.wurst" parent-piglets="manage"></wurst-embed>
```

Those services live under `wurst.parent`. They do not expose Host files, Wurster Auth/Identity secrets, shell/process/environment or generic Parent capabilities. `<wurst-embed isolated>` removes the managed Parent relationship for sensitive Children.

## Host-facing capabilities

Runtime availability is queryable through `wurst.capabilities`. Host file exchange remains narrow and user-mediated through declared `files.open` / `files.save`; the Wurst never receives a reusable Host directory capability.

## Trusted UI

Auth, verified identity presentation and other security-sensitive surfaces remain Wurster-owned. Developer Tools inspect application web content, not Wurster-held secrets.
