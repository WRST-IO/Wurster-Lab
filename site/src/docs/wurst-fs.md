---
title: WurstFS
group: Runtime & Format
groupOrder: 2
order: 3
---
# WurstFS

WurstFS is the mutable filesystem carried inside a WRST v7 Wurst. The immutable application base stays publisher-signed; mutable runtime-owned data lives after that immutable base.

WurstFS follows one rule: **capabilities are opt-in**. Ordinary storage is ordinary. Encryption, identities, sharing and audit appear only when a Wurst asks for them.

```text
WURST
├── immutable signed application
└── mutable WurstFS
    ├── ordinary realm          default
    ├── personal realm          optional
    └── shared realm            optional
```

All realm kinds may coexist in the same Wurst.

## Ordinary storage is the unnamed default

The smallest realm declaration is:

```json
{ "id": "gallery" }
```

It means public mutable application data with no Wurster Identity, signatures, sharing or retained audit history.

Create/read/update/delete are final from the logical filesystem's point of view. If a 5 GiB video is added and later removed, it disappears logically immediately. Append-safe writes may leave obsolete physical records temporarily, but compaction removes them so the Wurst can shrink again.

If an old state matters, copy the Wurst before changing it.

## Personal governance

```json
{
  "id": "private",
  "governance": "personal"
}
```

A personal realm is sealed, single-owner, mutable, non-shareable and history-free. Its filenames, metadata and payloads are encrypted.

A personal realm may ship empty and unclaimed. The first Wurster Identity that explicitly unlocks it becomes its sole owner. Once claimed, its realm key is wrapped only for that identity.

This is the intended model for diaries, private galleries, private app state and operator secrets.

## Shared governance

```json
{
  "id": "committee",
  "governance": "shared",
  "protection": "sealed",
  "read": "owner",
  "write": "owner",
  "audit": "none"
}
```

Shared realms use public Wurster Identities. Ed25519 proves authorized mutations; X25519 wraps a sealed realm key for permitted readers.

Read, write and administration are separate concepts:

- **read**: who can decrypt a sealed realm;
- **write**: whose signing identity may publish a valid changed state;
- **admin**: whose signing identity may change sharing policy.

Editing raw bytes is never treated as a security boundary. A forged state may be physically created, but Wurster must reject it as unauthorized. Data that must be unreadable is actually encrypted.

`audit` is independent of sharing:

```text
audit: none    no application-visible detailed operation history
audit: signed  retain signed operation summaries intentionally
```

Shared realms currently keep the minimum signed integrity lineage needed to validate policy/write authorization. Safe checkpoint compaction for that lineage remains a pre-1.0 hardening task. Ordinary and personal realms do not inherit that cost merely because another realm is shared.

## Mixed storage

A Wurst may freely combine storage policies:

```json
{
  "data": {
    "format": "wurst/data-realms-1",
    "writable": true,
    "realms": [
      { "id": "scratch" },
      { "id": "mine", "governance": "personal" },
      {
        "id": "committee",
        "governance": "shared",
        "protection": "sealed",
        "read": "owner",
        "write": "owner",
        "audit": "none"
      }
    ]
  }
}
```

`/data/scratch` stays simple even though `/data/committee` is multi-user.

## Wurster Identity

A Wurster Identity derives two purpose-separated keypairs from a portable Meatphrase:

```text
Ed25519  signing / mutation identity
X25519   encryption key agreement / realm-key wrapping
```

Its public half can be exported as `.wurstid` or a `wurstid-v1-...` string. It contains no private key and may be exchanged before the recipient has ever opened a particular Wurst.

Display names are self-declared. Optional WRST.IO claims can bind a verified email or domain to the public identity without creating a central account system.

## Paths

WurstFS realm paths are:

```text
/data/<realm-id>/...
```

Examples:

```text
/data/gallery/videos/pig.mp4
/data/private/dreams/tuesday.txt
/data/committee/checklist.json
```

The realm is the current cryptographic and sharing boundary. Nested per-folder ACL inheritance is not part of the current format.

## Initialization and claiming

A Wurst opts into mutable data with `data`:

```json
{
  "data": {
    "format": "wurst/data-realms-1",
    "writable": true,
    "realms": [
      { "id": "workspace" },
      { "id": "operator", "governance": "personal" }
    ]
  }
}
```

Ordinary realms initialize without an identity. An empty personal realm may initialize unclaimed and bind to the first identity that explicitly unlocks it. Shared genesis needs an authenticated identity because its initial policy needs an accountable administrator.

## Desktop API

```js
await wurst.fs.stat('/data/workspace/package.json');
await wurst.fs.list('/data/workspace/packages');
await wurst.fs.read('/data/workspace/package.json');
await wurst.fs.write('/data/workspace/README.md', text, { mime: 'text/markdown' });
await wurst.fs.mkdir('/data/workspace/new-folder');
await wurst.fs.rename('/data/workspace/a.txt', '/data/workspace/b.txt');
await wurst.fs.remove('/data/workspace/b.txt');
```

Realm helpers:

```js
await wurst.fs.capabilities();
await wurst.fs.realms();
await wurst.fs.initialize();
await wurst.fs.unlockRealm('operator');
await wurst.fs.lockRealm('operator');
await wurst.fs.history();
```

Ordinary realm descriptors omit `governance`. Personal/shared descriptors expose it explicitly.

Raw renderer sharing operations are deliberately not exposed. Sharing belongs behind Wurster-owned trusted UI.

## Large and concurrent writes

Large files are streamed in bounded chunks. Several transactions may be in flight at once. Physical appends are serialized safely, but a long transaction does not monopolize the filesystem.

```text
5 GiB video starts
    ↓ still streaming
small note starts → commits
2 MiB video starts → commits
    ↓
5 GiB video finally commits
```

A long transaction rebases over unrelated commits. If another transaction changed the same logical object or its realm policy, WurstFS raises `WURST_FS_CONFLICT` instead of silently overwriting it.

## Append-safe is not append-forever

WurstFS appends new records before publishing a commit because a crash before commit should leave the previous state valid. This is a write strategy, not a retention policy.

For ordinary and personal storage, compaction writes a fresh current snapshot containing only live data. Deleted/replaced payloads disappear physically. A claimed personal realm must be unlocked to rebuild its encrypted metadata; an empty unclaimed personal realm needs no key.

The original Wurst is never overwritten during the compaction build. Wurster verifies the fresh file before replacing or handing it off.

## Wurster Lab reference case

`WursterLab.wurst` intentionally uses mixed storage:

```text
/data/workspace   ordinary mutable source tree
/data/lab         ordinary notes/release metadata
/data/operator    personal sealed WRST.IO operator material
```

Another maintainer or agent may replace `/data/workspace` while `/data/operator` remains cryptographically opaque and untouched.
