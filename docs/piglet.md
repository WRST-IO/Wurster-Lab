---
title: Piglet
group: Runtime Pillars
groupOrder: 2
order: 3
---
# Piglet

Piglet is composition: one Wurst used inside another while both remain independently identified Wursts.

A Piglet is **not** a package format and `<wurst-embed>` is **not** the Piglet. It is the universal human View path:

```html
<wurst-embed src="/workspace/apps/FileExplorer.wurst"></wurst-embed>
```

Outside a Wurst this embeds a Wurst. Inside a running Wurst the same element establishes a Piglet relationship. Layout remains ordinary HTML/CSS; Wurster owns loading, verification, session coordination and persistence.

## One Wurst, many Views

Two embeds of the same PigFS-held Child are two Views onto one durable Wurst world:

```html
<wurst-embed src="/workspace/apps/FileExplorer.wurst"></wurst-embed>
<wurst-embed src="/workspace/apps/FileExplorer.wurst"></wurst-embed>
```

Each View may keep different tab, selection, scroll or unsaved DOM state. Once a PigFS change is committed, it belongs to the Wurst. Other Views receive `wurst-session-changed`; a stale full-snapshot writer gets `WURST_SESSION_CONFLICT` until refreshed.

`wurst.piglet.running()` reports active Child sessions plus View/Machine attachment counts. Session ids are runtime coordination handles, never second Wurst identities or portable state.

## Machine access

A Child that declares `piglink.headless: true` can run without a visible View:

```js
const packer = await wurst.piglet.connect('/workspace/tools/TexturePacker.wurst');
const result = await packer.piglink.invoke('textures.pack', input);
await packer.close();
```

For one call:

```js
const result = await wurst.piglet.invoke(ref, 'textures.pack', input);
```

On Desktop/Web this machine attachment joins the same durable Child session as visible Views. The browserless harness can also use built-in or PigFS-held Child Wursts as machine subtools without extracting them to Host files.

## Identity and source

Nesting never republishes a Child as the Parent. The exact immutable Child package, publisher signature and identity remain its own. Mutable Child PigFS may change later without changing that immutable publisher identity.

Children may come from immutable Parent content, built-ins or ordinary `.wurst` / `.wrst` files in readable Parent PigFS. `wurst.piglet.install(...)` validates supplied bytes and stores them as an ordinary PigFS file.

## Cooperation

When the Parent declares PigLink, Parent↔Child Actions/Events are available by default. Broader Parent authority is explicit:

```html
<wurst-embed src="FileExplorer.wurst" parent-pigfs="read-write"></wurst-embed>
<wurst-embed src="ProgramManager.wurst" parent-piglets="manage"></wurst-embed>
```

The Child sees these under `wurst.parent.pigfs` and `wurst.parent.piglets`. A Parent can delegate only authority it actually has. There is no inherit-everything switch, and none of this implies Host filesystem, shell/process/environment or Wurster-secret access.

For a stricter compartment:

```html
<wurst-embed src="SensitiveTool.wurst" isolated></wurst-embed>
```

`isolated` removes Wurster-managed Parent PigLink and Parent services. It is an optional relationship mode, not Piglet's default philosophy.

## Persistence and conflicts

Child sources are range-readable. Writable Child PigFS persists back to the Parent-held Wurst with conflict checking. Built-in writable Children materialize a mutable copy in Parent PigFS while the immutable built-in bytes covered by the Parent signature remain unchanged.

If the underlying Child Wurst changes independently, Wurster fails instead of silently choosing a winner. Session-level stale writes use `WURST_SESSION_CONFLICT`; backing-file conflicts use `WURST_PIGLET_CONFLICT`.

## Remaining 0.32.4 work

The largest open gap is an external broker that lets a separate CLI/MCP process discover and attach to a Desktop/Web-owned Wurst session already running elsewhere. The generic CLI Child-subtool path also still needs full writable nested-Child PigFS and Parent-service parity. Path-scoped delegation, lifecycle/revoke, recovery and deep nesting remain pre-1.0 work.
