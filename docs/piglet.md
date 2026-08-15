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

Wurster 0.33 gives every persistent mutable Child a stable **Wurst Object ID**. The Child keeps its own virtual WRST address space, immutable signed Base and mutable PigFS state, while the authoritative Root Wurst physically hosts mutable records in its append arena. Containment is therefore a logical ownership/authority relationship rather than a requirement that the complete Child remain a contiguous blob inside the Parent.

A Child PigFS write updates the Child object's `stateRevision` and Root Object-index metadata. It does **not** rewrite complete ancestor Wursts and does not propagate state revisions up the containment chain. Immutable Bases are deduplicated by exact `baseBlobHash`, independently from the publisher-protected `packageDigest`.

If another session changed a dependency first, Wurster fails instead of silently choosing a winner. Read-set/write-set conflicts retain `WURST_SESSION_CONFLICT` semantics. Relationship changes have their own revision dimension and are published atomically.

Extraction/materialization produces a standalone Closure containing the selected Wurst, all transitively owned Children, required immutable Bases and current mutable states. Move preserves Object IDs; export/copy creates a new mutable object world with new Object IDs. Publisher-signed immutable Base bytes remain bit-identical. See [Wurst Object Storage](wurst-object-storage.md).

## Desktop and browser presentation

Browser Wurster may use its Service Worker to serve `__wurster/<session>/...` virtual application resources. Electron Desktop does not depend on Service Worker controller takeover. Desktop owns the Child source/session already, so `wurst://runtime/__wurster/<session>/...` is served deterministically by the Desktop runtime protocol layer. Both paths expose the same logical Wurst session to the application.

## Remaining work

The largest open interoperability gap remains an external broker that lets a separate CLI/MCP process discover and attach to a Desktop/Web-owned Wurst session already running elsewhere. More trust/governance policy can be layered onto the 0.33 Object Store without restoring whole-Wurst ancestor writeback.
