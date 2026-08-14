---
title: Wurster Runtime
group: Runtime & Format
groupOrder: 2
order: 1
---
# Wurster Runtime

Wurster is deliberately quieter than the applications it runs.

Launching Wurster itself shows a compact frameless launcher. Drop a `.wurst`, `.wrst` or Undercover PNG, click the drop target, open the Meat Locker, or flip the card to MeatGrinder. Opening a Wurst directly from Finder or Explorer skips the launcher and goes straight to the application.

Wurster can also inspect identity without opening the application. **File → Verify Wurst Identity…** reads and verifies the package in Wurster-owned UI. The Windows installer additionally registers **Verify Wurst Identity** only for the `.wurst` and `.wrst` file types; the verification-only launch path never executes the Wurst entry point.

When that Wurst window closes, Wurster exits. It does not reopen its launcher and ask what you would like to eat next.

The runtime hosts Wurst code in a sandboxed web renderer with Node integration disabled. Filesystem, network and privileged runtime features are mediated by Wurster rather than exposed as Node APIs.

## Developer tools

The desktop runtime opens Wurst Developer Tools in a dedicated top-level window. They inspect the Wurst renderer only. Trusted Wurster Auth surfaces do not expose developer tools to the Wurst.

## Meat Locker

Wurster can keep local Meat Identities. A Meat Identity is a name, emoji and portable Meatphrase protected by the local runtime.

Identity administration lives inside the Wurster launcher. Before the Meat Locker is shown, Wurster asks the operating system for local user presence where the runtime has an adapter. macOS uses Touch ID when available. The 0.31.0 Windows adapter asks Windows Security/Hello and is still being validated on real Windows machines before 1.0. This protects Wurster's local copy only and never changes the portable Wurst.

A Wurst still remains unlockable by entering its Meatphrase manually on another conforming runtime.

## Portable storage and snapshots

A Wurst that declares writable user data receives `wurst.fs`, an application-owned filesystem rooted at `/data`. Wurster mediates all reads and writes; Wurst JavaScript never receives a host filesystem path.

`wurst.fs.capabilities()` tells the app whether the current source is readable, writable and persistent. This lets the same app tolerate a local writable Wurst and a future remote/read-only Wurst source without pretending the original remote object can be modified.

WurstFS media is exposed through `wurst.fs.url()`, which returns an opaque runtime URL suitable for normal `<img>`, `<audio>` and `<video>` elements. Wurst code never depends on the physical URL scheme; Desktop, Web and future native runtimes map the logical WurstFS path to their own safe resource surface.

Local raw Wursts can compact stale append-only history in the background. Applications may request this with `wurst.fs.compact()`, while Wurster also performs conservative hygiene when reclaimable data becomes substantial. The visible Wurst renderer is not reloaded during the file swap.

`wurst.snapshot.export()` opens trusted Wurster save UI and streams the currently committed virtual WRST representation to a standalone `.wurst` file. The application chooses when to offer a snapshot, but Wurster chooses the destination with the user. Pending, uncommitted WurstFS transactions are not part of the snapshot.

## Runtime capability availability

A Wurst can ask what this particular runtime can actually provide:

```js
const status = await wurst.capabilities.query("camera");
const all = await wurst.capabilities.list();
```

A declared capability may be `available` or `unsupported`; an undeclared capability reports `undeclared`. Unsupported platform features do not prevent the Wurst from opening. The application chooses its fallback UX.

## User-selected host files

Desktop Wurster supports two explicit red-risk capabilities for tools that must exchange ordinary host files without receiving arbitrary filesystem access:

```json
{
  "capabilities": {
    "files.open": true,
    "files.save": true
  }
}
```

A Wurst with `files.open` may call `wurst.files.open(...)`. Wurster always owns the open dialog and returns only the single file the user selected. `files.save` similarly opens a Wurster-owned save dialog and writes only to the destination chosen by the user. The Wurst never receives a reusable host directory capability or unrestricted path access. Both capabilities are RED and therefore require a valid package signature on Desktop.

`WursterLab.wurst` uses this narrow bridge to import operator files and emit a local production workspace while its operator material stays inside a personal sealed WurstFS realm.
