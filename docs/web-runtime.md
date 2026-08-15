---
title: Wurster Web
group: Runtime & Format
groupOrder: 2
order: 3
---
# Wurster Web

Wurster Web is the browser implementation of the portable Wurst runtime. It opens local or HTTP Range-backed WRST v7, serves application resources through a scoped Service Worker and provides the same core PigFS/PigLink/Piglet vocabulary as Desktop.

## 0.32.4 surface

The distribution in `runtime/web/dist/` contains the browser runtime, service worker and universal `<wurst-embed>` host. A normal site can embed a Wurst with:

```html
<wurst-embed src="./example.wurst"></wurst-embed>
```

The host streams byte ranges over `MessageChannel`; consuming sites do not need to install a root Service Worker for every Wurst.

## PigFS

Browser PigFS supports mounted paths, ranged reads, streaming writes, stable object IDs and standalone snapshot export. Multiple Views and in-runtime machine clients of the same Child share one revision-coordinated Wurst session.

## Piglet and machine access

`<wurst-embed>` is the human View path. A `piglink.headless: true` Child may also be reached with `wurst.piglet.connect()` / `invoke()` without creating a visible View. Both address the same durable Child session when they refer to the same Wurst.

Parent PigFS/Piglet delegation and `isolated` relationship semantics match the shared portable contract.

## Protection and trust

Wurster Web supports public, partial and WurstKey-sealed application content and verifies WRST.IO Authority chains offline. Browser parity is not yet complete for every Desktop trust/auth feature, personal/shared PigFS UI flow or local platform integration.

## Build

```bash
npm run runtime:web:build
```

The output is self-contained and is also packaged as the shared Web embed runtime used by Desktop. Source-fragment copying is not the release contract.
