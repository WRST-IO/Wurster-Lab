---
title: Piglet
group: Runtime & Format
groupOrder: 2
order: 5
---
# Piglet

Piglet is Wurster's composition runtime: one Wurst can keep, discover and run another Wurst without changing the child's package identity.

A Piglet is **not a second package format**. It is still an ordinary `.wurst` / `.wrst` file. Piglet is the runtime relationship around that file.

```text
WhiteHouse.wurst
  owns bytes for JoeBiden.wurst

WhiteHouse publisher signature  -> authenticates WhiteHouse package bytes
JoeBiden publisher signature    -> still authenticates JoeBiden.wurst
```

Nesting never re-signs the child as the parent. A child signed by one publisher remains signed by that publisher whether it shipped inside the parent on day one or was imported into writable WurstFS months later.

## Status In 0.32

Desktop Piglet now has a managed runtime slice:

Piglet package access follows the same random-access principle as top-level Wursts. Opening a child does not require buffering the entire child package first: built-in children expose verified ranges from their immutable parent resource and WurstFS children expose ranges from their stored file. Wurster only materializes a private local backing file when a child actually needs writable WurstFS or protected application unlock. This keeps large read-mostly Piglets fast to inspect and start.

Container applications such as WurstOS must call `wurst.piglet.open(ref, { bounds })` to create a managed renderer. `wurst.piglet.url(ref)` is intentionally only a package-byte transport/debug URL and is not an iframe document. A UI that still displays a "waiting for managed child renderer" placeholder is application-side code that has not switched from the old URL/display pattern to `open()`.

- fixed MeatGrinder children remain byte-identical immutable Wurst resources;
- runtime-installed children are stored as ordinary WurstFS `.wurst` / `.wrst` files;
- `wurst.piglet.children()` discovers both built-in children and valid Wurst files in readable WurstFS realms;
- every discovered candidate is inspected independently and reports its child application identity plus package-signature status;
- `wurst.piglet.install(...)` verifies Wurst structure/signature and writes the exact supplied bytes into WurstFS without repackaging;
- `wurst.piglet.open(...)` creates a Wurster-owned `WebContentsView` child renderer instead of pretending package bytes are an iframe document;
- child surfaces have handles and can be moved, resized, focused and closed by the parent;
- every running child receives its own manifest, renderer session, protocol handler, capability context and runtime binding.

Wurster Web still supports the earlier built-in-child internal-session path. Runtime-installed Web Piglets and managed nested browser surfaces remain follow-up work.

Protected/sealed Desktop children now use the same Wurster-owned Auth controls as top-level Wursts, but bound to the child runtime context and child surface rectangle. WurstKey and Wurster Identity secrets never transit through the parent renderer.

## Two Ways A Wurst Can Contain Another Wurst

### Built-in child

A project can ship a child at MeatGrinder time:

```json
{
  "capabilities": {
    "piglet": true
  },
  "piglet": {
    "children": [
      {
        "id": "flappywurst",
        "source": "apps/FlappyWurst.wurst",
        "label": "Flappy Wurst"
      }
    ]
  }
}
```

MeatGrinder copies the exact bytes to immutable `piglet` scope and records their SHA-256 in the parent manifest. It does **not** decode and rebuild the child.

The parent signature therefore says:

> these exact child bytes were part of the parent package I published.

The child signature separately says:

> this child package was published by its own publisher.

Both statements remain true at the same time.

### Runtime-installed child

A running Wurst may also keep another Wurst as normal mutable data. There is no special Piglet database and no hidden host folder.

For example:

```text
/data/workspace/apps/FlappyWurst.wurst
/data/workspace/apps/Notes.wurst
/data/media/trailer.mp4
/data/media/poster.jpg
```

`FlappyWurst.wurst` and `Notes.wurst` are ordinary WurstFS files just like the MP4 and JPEG beside them. Piglet discovery notices valid `.wurst` / `.wrst` files and exposes them as runnable children.

The parent package signature does not claim authorship of runtime-installed files. Wurster verifies each stored child independently.

## Drag And Drop

Piglet intentionally does not invent a privileged drag-and-drop channel. The parent Wurst owns its UI and receives the browser `File` just like any other dropped file.

```js
surface.addEventListener('drop', async (event) => {
  event.preventDefault();

  for (const file of event.dataTransfer.files) {
    if (!/\.(wurst|wrst)$/i.test(file.name)) continue;

    const installed = await wurst.piglet.install(
      file.name,
      await file.arrayBuffer()
    );

    console.log('installed', installed.ref, installed.signature);
  }
});
```

The default installer writes into `piglets/` below the first writable ordinary WurstFS realm. A Wurst may instead choose an explicit WurstFS destination:

```js
await wurst.piglet.install('MyApp.wurst', bytes, {
  path: '/data/workspace/apps/MyApp.wurst'
});
```

That destination remains a normal WurstFS file and can also be read, renamed or removed through ordinary `wurst.fs` APIs.

## Discovery

```js
const children = await wurst.piglet.children();
```

Descriptors use a runtime reference instead of pretending the parent owns the child's identity:

```js
{
  ref: 'builtin:flappywurst',
  source: 'builtin',
  mutable: false,
  application: {
    id: 'io.example.flappywurst',
    name: 'Flappy Wurst',
    version: '1.2.0'
  },
  signature: {
    status: 'signed',
    publisher: { /* independent child publisher */ }
  }
}
```

or:

```js
{
  ref: 'wurstfs:/data/workspace/apps/MyApp.wurst',
  source: 'wurstfs',
  path: '/data/workspace/apps/MyApp.wurst',
  mutable: true,
  application: { /* child manifest identity */ },
  signature: { /* child package verification */ }
}
```

A filename ending in `.wurst` is not automatically trusted as a Piglet. Discovery attempts to parse it as a Wurst. Malformed files are simply still ordinary files and are not returned as runnable children.

## Managed Desktop Surfaces

`wurst.piglet.url()` still exists, but it returns the **package bytes**. A `.wurst` file is not an HTML document and that URL must not be placed into an iframe.

To execute a child on Desktop, use:

```js
const child = await wurst.piglet.open('builtin:flappywurst', {
  bounds: { x: 80, y: 90, width: 640, height: 420 }
});
```

The returned handle belongs to the parent runtime session:

```js
await wurst.piglet.setBounds(child.handle, {
  x: 120,
  y: 100,
  width: 720,
  height: 480
});

await wurst.piglet.focus(child.handle);
await wurst.piglet.close(child.handle);
```

If `bounds` is omitted, the child surface fills the Wurster content area and follows host-window resizes.

This makes fake-desktop shells such as `WurstOS.wurst` possible without making an inner Wurst an iframe or launching another Electron application.

## Runtime API

Current Desktop surface:

```js
await wurst.piglet.children();
await wurst.piglet.inspect(ref);
await wurst.piglet.url(ref);          // raw Wurst bytes, not an app document
await wurst.piglet.install(name, bytes, options);
await wurst.piglet.remove(ref);       // WurstFS children only
await wurst.piglet.open(ref, options);
await wurst.piglet.surfaces();
await wurst.piglet.setBounds(handle, bounds);
await wurst.piglet.focus(handle);
await wurst.piglet.close(handle);
```

The `piglet` capability is required for install/remove/open lifecycle operations.

## Trust Domains Stay Separate

A child keeps its own:

- immutable application bytes;
- package signature and publisher identity;
- WurstFS realms;
- WurstKey requirements;
- capabilities;
- Pigsty state;
- PigLink declaration.

The parent gains orchestration authority over the child surface. It does not gain the child's secrets or become its publisher.

```text
Parenthood grants orchestration, not authorship.
```

## Child Runtime Isolation

Every managed Desktop child gets a separate renderer context and protocol session. A child request resolves against the child reader, not the parent reader.

The parent therefore cannot make this happen accidentally:

```text
wurst://app/index.html
    -> parent index.html sometimes
    -> child index.html other times
```

Each runtime instance has a Wurster-owned context binding. IPC calls are mapped back to the correct Wurst instance rather than a global `currentContext` assumption.

Managed Desktop children now use writable nested WurstFS when their own manifest declares writable data. Wurster runs the child against a private backing file, fsyncs the child commit, then conflict-checks and writes the resulting complete child-Wurst bytes back into the parent WurstFS. Closing and reopening the Piglet therefore preserves its own WurstFS state.

A runtime-installed Piglet writes back to the exact `.wurst` / `.wrst` file the parent stores. A writable built-in Piglet cannot mutate its immutable copy inside the parent package without invalidating the parent signature, so Wurster materializes an exact runtime copy under the parent's ordinary WurstFS before the first writable run. The built-in package bytes remain immutable and signed by the parent; the materialized child still retains the child's independent immutable application bytes and publisher signature.

Write-back is optimistic and conflict checked. If the parent-held child file changed independently while that child instance was running, Wurster raises `WURST_PIGLET_CONFLICT` instead of silently overwriting either version.

## Remaining Piglet Work

Before a stable Piglet contract, the larger remaining pieces are:

- explicit start/suspend/resume semantics beyond open/focus/close;
- tree-level CPU, memory, renderer, Pigsty and nesting-depth budgets;
- direct brokered PigLink handles between parent and running child;
- equivalent runtime-installed/managed-surface behavior in Wurster Web;
- trust/revocation presentation suitable for shell UIs without allowing the parent to spoof Wurster-owned identity indicators.
