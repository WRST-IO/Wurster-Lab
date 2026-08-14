---
title: PigFS
group: Runtime Pillars
groupOrder: 2
order: 1
---
# PigFS

PigFS is Wurster's portable filesystem: one file outside, a filesystem inside.

PigFS stores normal files and directories with filesystem-like semantics. Realms are security, governance and cryptographic boundaries mounted into that tree. They are not a replacement for paths.

```text
/
├── app/
├── workspace/
├── private/
├── toolchain/
├── derived/
└── piglets/
```

A realm declaration names its mount:

```json
{
  "id": "workspace",
  "mount": "/workspace",
  "quotaBytes": 1073741824
}
```

Applications use normal paths:

```js
await wurst.pigfs.read('/workspace/package.json');
await wurst.pigfs.write('/workspace/README.md', '# OINK');
await wurst.pigfs.rename('/workspace/a.txt', '/workspace/archive/a.txt');
```

## Core semantics

PigFS v1 is being built around files, directories, stable object IDs, random access, streams, transactions, snapshots, watches, quotas, internal symlinks, realms, encryption and compaction.

Paths are names. Object identity is stable. Renaming a file does not change its object ID, allowing PigLink and tools to hold safe handles across moves.

Transactions make groups of mutations visible atomically. A Pigsty job can write many files and commit once, or fail without publishing a half-built tree.

Snapshots produce cryptographic logical-tree digests. Derived artifacts can therefore compare source snapshots instead of trusting timestamps.

Append-safe writes never mean append forever. PigFS tracks reclaimable storage and compaction physically removes dead records, including obsolete encrypted ciphertext.

## Realms

Ordinary realms are simple mutable storage. Personal realms can be sealed for one Wurster Identity. Shared realms can use signed governance and wrapped realm keys. A Wurst may mix them.

A PigFS symlink may point within its permitted filesystem boundary. It may never become a host-filesystem escape hatch.

## Relationship to the four pillars

PigFS stores. PigLink connects. Piglet composes. Pigsty computes.

Pigsty works on PigFS transactions. Piglets live as normal Wurst files in PigFS. PigLink can carry stable PigFS handles. The application itself stores state in PigFS.

Security and cryptographic details are documented separately so ordinary filesystem use does not require learning every protection mechanism first.
## Piglets and Parent PigFS

A Piglet always owns its own PigFS. Embedding does not merge child and parent storage. A parent Wurst may explicitly delegate access to its own PigFS through `<wurst-embed parent-pigfs="read">` or `parent-pigfs="read-write"`. The child receives that authority under `wurst.parent.pigfs`, keeping parent storage visibly separate from `wurst.pigfs`.

Delegation is not Host access. PigFS Realm governance, lock state, encryption and the parent's own effective authority still apply. This makes system-style Wursts possible without weakening the boundary around the actual computer OS.
