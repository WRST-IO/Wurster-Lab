---
title: PigFS
group: Runtime Pillars
groupOrder: 2
order: 1
---
# PigFS

**One file outside, a filesystem inside.** PigFS is the durable storage layer of a Wurst.

Applications use normal paths:

```js
await wurst.pigfs.read('/workspace/project.json');
await wurst.pigfs.write('/workspace/README.md', '# OINK');
await wurst.pigfs.rename('/workspace/a.txt', '/workspace/archive/a.txt');
```

## What it provides

PigFS 0.32.5 has functional support for files/directories, stable object IDs, streaming writes, transactions, snapshots, watches, quotas, internal symlinks, realms, encryption and compaction.

Paths are names; object identity survives rename. Transactions publish groups of changes atomically. Append-safe storage is a crash-safety strategy, not permanent growth: compaction removes dead records and obsolete ciphertext.

## Realms

Realms are boundaries inside one filesystem, not parallel filesystems:

- **ordinary** - normal mutable data;
- **personal** - encrypted for one Wurster Identity;
- **shared** - optional signed governance and wrapped realm keys.

Realm mounts create ordinary paths such as `/workspace` or `/private`. Internal symlinks may never escape to the Host filesystem.

## Shared Wurst state

Multiple Views and machine clients of the same running Wurst share the same durable PigFS world. View-local DOM/JavaScript state stays local until the application commits something to PigFS. Session revisions prevent an older full Wurst snapshot from silently overwriting a newer commit.

## Parent PigFS

A Parent may explicitly lend its own PigFS to a Child:

```html
<wurst-embed src="FileExplorer.wurst" parent-pigfs="read-write"></wurst-embed>
```

The Child keeps its own `wurst.pigfs`; Parent storage appears separately as `wurst.parent.pigfs`. Delegation never creates Host filesystem access and never bypasses Realm lock, governance or encryption rules.
