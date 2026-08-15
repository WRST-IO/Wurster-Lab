---
title: Wurst Object Storage
group: Runtime
groupOrder: 3
order: 4
---
# Wurst Object Storage

Wurster 0.33 separates logical Wurst containment from physical storage. A nested Wurst remains a complete logical Wurst, but a mutable Child no longer has to remain one contiguous blob inside its Parent.

The authoritative Root Wurst is the physical storage host for the reachable Wurst object world:

```text
logical                         physical Root Wurst
ROOT                            immutable signed bases
└── A                           append-only mutable arena
    ├── X                       persistent Object Table
    └── Y                       persistent Relationship Index
                                Root Commit chain
```

Containment defines ownership, authority and lifecycle. It does not define where mutable bytes must physically live.

## Four different identities

These values are deliberately independent:

- **Application ID**: which application/software.
- **packageDigest**: which publisher-signed immutable package identity.
- **Wurst Object ID**: which persistent mutable instance.
- **Session ID**: which currently opened runtime world.

Relocation and compaction preserve the Wurst Object ID. Export/copy creates fresh Object IDs. Session IDs are never persistent object identity.

## Immutable Base and mutable State

Every persistent Wurst object has two logical layers:

```text
Wurst Object
├── Immutable Signed Base
└── Mutable Instance State
```

`packageDigest` remains the publisher-signature identity. `baseBlobHash` is SHA-256 over the exact immutable Base bytes and is used for physical immutable-blob deduplication. Multiple Wurst Objects may share one bit-identical Base blob.

Mutable state is represented by the object's virtual WRST tail. Its physical records live in the Root Wurst append arena. `stateHash` describes logical mutable state; extent/page hashes authenticate local physical mapping. Different runtimes may coalesce the same logical state differently without changing its logical identity.

## Persistent indexes

The Object Table and both relationship directions are paginated copy-on-write indexes. Updating one object rewrites only the affected index path rather than a monolithic table.

Wurster maintains both:

```text
Child -> Parent
Parent -> direct Children
```

Direct-child enumeration therefore does not require a scan of all Wurst objects.

The containment graph is bounded, cycle checked and limited by the runtime's maximum Piglet depth.

## Revisions and transactions

Each object distinguishes at least:

```text
stateRevision
relationshipRevision
```

A normal PigFS mutation inside Child X increments X's `stateRevision`. It does not increment Parent or ancestor state revisions.

Transactions carry dimension-specific read dependencies and write CAS state. A transaction may depend on an object's state revision, relationship revision or package digest without treating every unrelated change as a conflict.

Prepared transactions append data first. Publication validates against the latest candidate Root and then updates copy-on-write indexes. Compatible prepared transactions can be published as a group with one Root Commit and one durability sync. A stale dependency returns the existing `WURST_SESSION_CONFLICT` semantics instead of silently replaying old payload bytes.

## Root Commit and crash recovery

The physical arena is append-only between compactions. Prepared but unpublished records are allowed to remain as unreachable tail garbage.

A PigFS COMMIT inside a Child is a logical commit in that Child's virtual WRST address space. Once Wurst Object Storage exists, it is not the Root file's durability boundary. The authoritative boundary is the following Root Commit.

A Root Commit binds the current generation, previous Root Commit, Object/Relationship index roots and authoritative arena tail. Recovery locates the latest valid Root Commit and follows the host object's named PigFS state head. Valid-looking records after that point are not automatically authoritative.

This permits recovery from:

```text
[valid Root Commit]
[prepared object/PigFS records]
[partial record]
[random tail garbage]
EOF
```

Scratch files are never required for recovery.

## Materialization, move, export and compaction

Every reachable subtree must remain a closed portable Wurst world. The shared subtree materializer copies immutable Base bytes bit-identically and carries the authoritative mutable state and system-owned relationship metadata.

- **Move / Extract-and-Remove** preserves Wurst Object IDs.
- **Export / Copy** creates new Object IDs for the copied mutable object world.
- **Compaction** preserves Object IDs and relationships while rewriting physical extents.

Opaque application PigFS bytes are never searched for possible Object IDs and are never rewritten as part of ID remapping.

Publisher signatures are not regenerated during embed, mutation, relocation, extraction or compaction. The private publisher key is not required for these operations.

Changing an object's immutable Base is a separate **Package Transition**. Same-publisher upgrades are allowed by policy; publisher changes require either a verified publisher-key transition supplied by the trust layer or explicit user approval.

## Performance invariant

For a deep tree such as:

```text
ROOT
└── A
    └── B
        └── C
            └── X
```

a small write in X prepares X's logical PigFS delta, appends new arena records, updates X plus O(log N) index pages, and publishes a Root Commit. A, B and C are not reserialized merely because X changed.

The storage target is therefore:

```text
payload work:          O(delta)
object/index metadata: O(log N)
nesting depth:         not a storage-mutation factor
```

Compaction is the mechanism that later reclaims unreachable arena extents.
