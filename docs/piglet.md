---
title: Piglet
group: Runtime Pillars
groupOrder: 2
order: 3
---
# Piglet

Piglet is composition: a Wurst running inside another Wurst while remaining its own Wurst.

A Piglet is not a package format and not an Electron view. The universal UI contract is the same element Wurster Web already uses everywhere:

```html
<wurst-embed src="./media/example.wurst"></wurst-embed>
```

Outside a Wurst this embeds a Wurst. Inside a running Wurst it creates a Piglet relationship. The element behaves like normal HTML: CSS sizing, Grid/Flexbox, scrolling, clipping, transforms and border radii belong to the parent document. Wurster may use an internal sandboxed iframe, but that is runtime implementation detail.

## Source rules

Inside a Wurst, `src` can refer to ordinary immutable package content or PigFS:

```html
<wurst-embed src="./media/tool.wurst"></wurst-embed>
<wurst-embed src="/workspace/apps/tool.wurst"></wurst-embed>
```

Built-in MeatGrinder children remain discoverable with `wurst.piglet.children()` and can be embedded through their runtime URL when needed. Runtime-installed children are normal `.wurst` / `.wrst` files in PigFS.

## Identity never merges

Nesting never republishes the child as the parent.

```text
WhiteHouse.wurst     signed by WhiteHouse.gov
└── JoeBiden.wurst   signed by JoeBiden.com
```

MeatGrinder preserves the exact child bytes. The parent signature covers those exact bytes as parent content; the child signature continues to authenticate the child's own immutable package. Mutable child PigFS state may grow later without changing the child's immutable publisher identity.

## Runtime installation

A dropped Wurst is stored as an ordinary PigFS file:

```js
await wurst.piglet.install('MyApp.wurst', bytes, {
  path: '/workspace/apps/MyApp.wurst'
});
```

Discovery is filesystem-based. A filename ending in `.wurst` is only returned as a runnable Piglet after it parses as a valid Wurst.

## Lazy startup and persistence

Piglet sources are byte-range sources. Opening an embed does not require buffering the complete child first. Wurster reads metadata and requested resources in slices.

When a child has writable PigFS, its mutations persist back to the parent-held `.wurst` file. Runtime-installed children update that file directly. Writable built-in children materialize a mutable runtime copy in an ordinary parent PigFS realm so the immutable bytes covered by the parent signature remain unchanged.

Write-back is conflict checked. If the parent-held file changes independently while the child is running, Wurster raises `WURST_PIGLET_CONFLICT` rather than silently choosing a winner.

## Parent-granted runtime access

Piglets are isolated by default. A child cannot see its parent Wurst merely because it is embedded. The parent may explicitly delegate selected runtime services on the `<wurst-embed>` element. The first delegation surface is Parent PigFS:

```html
<wurst-embed
  src="/workspace/apps/FileExplorer.wurst"
  parent-pigfs="read-write">
</wurst-embed>
```

The child keeps its own `wurst.pigfs`. Delegated parent storage is separate and explicit:

```js
await wurst.parent.pigfs.list('/');
await wurst.parent.pigfs.write('/workspace-note.txt', 'OINK');
```

`parent-pigfs="read"` exposes read operations only. `parent-pigfs="read-write"` additionally allows mutation. Without the attribute `wurst.parent` is `null`. A grant never means Host filesystem access and never bypasses PigFS governance or encryption: a locked parent Realm remains locked, and a child does not inherit keys for unrelated Wursts. The parent can delegate only the runtime authority it already possesses.

This is intentionally a parent-service capability boundary rather than a merged filesystem. A WurstOS-style FileExplorer can therefore operate on WurstOS PigFS while still keeping its own package identity and private PigFS state. Future parent services can extend the same explicit grant model without turning Piglet into ambient authority.

## Runtime API

Piglet's JavaScript API manages files and discovery, not screen geometry:

```js
await wurst.piglet.children();
await wurst.piglet.inspect(ref);
await wurst.piglet.install(name, bytes, options);
await wurst.piglet.remove(ref);
```

Application presentation is `<wurst-embed>`. There is no public `setBounds`, native surface or Desktop-only open API.

## Trust UI

Application content is web-native. Trusted runtime UI is different.

`<wurster-auth>` and verified Wurster Identity presentation may use runtime-owned trusted surfaces because the application must not be able to forge them. Piglet application UI itself never requires `WebContentsView`.

## Remaining work

The largest remaining Piglet pieces are direct Parent↔Child PigLink handles beyond the scoped Parent PigFS bridge, suspend/resume semantics, tree-level resource budgets, crash/recovery states, finer path-scoped delegation and complete nested-Piglet stress testing.
