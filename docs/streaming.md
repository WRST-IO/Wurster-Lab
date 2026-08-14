---
title: Slicing & Streaming
group: Runtime & Format
groupOrder: 2
order: 5
---
# Slicing and Streaming

Wursts are served in slices. 🔪

WRST v7 separates a compact immutable base from an append-only PigFS tail. A runtime can inspect the header, manifest and indexes first, then fetch only the resources, catalog pages and data chunks it actually needs.

## Immutable application ranges

A local reader exposes random access:

```js
reader.entry(path)
reader.read(path)
reader.readRange(path, offset, length)
```

Large immutable resources carry independent integrity chunks. Reading a range verifies only the integrity chunks that intersect that range.

Desktop Wurster's private resource protocol understands HTTP-style Range requests, so Chromium can seek through large public media without loading the complete Wurst. That private scheme is a runtime implementation detail; Wurst application code keeps normal relative resource URLs.

## PigFS ranges

Mutable `/data` files use paged metadata and 4 MiB DATA records.

```js
reader.pigFsStat('/workspace/video.mp4')
reader.fsList('/data')
reader.pigFsReadRange('/workspace/video.mp4', offset, length)
```

`stat` and `list` do not open the file body. `fsReadRange` loads only intersecting map/data records.

Sealed PigFS encrypts each content slice independently. Catalog and map pages can also be sealed, so filenames and sizes are revealed only after user authentication while range access remains possible.

## Streaming writes

WRST v7 also writes scheibchenweise.

The application begins a transaction, sends bounded chunks, and commits only after the final chunk arrives. Normal writes append records and never rebuild the immutable application base.

An interrupted write leaves the previous complete PigFS generation valid.

## HTTP Range source

The format package now includes an HTTP source implementation. Opening a remote Wurst first performs a small byte-range probe, pins the representation with a strong ETag when available (or Last-Modified as a fallback), and issues exact byte ranges afterwards.

Conceptually:

```text
https://foo.baa/example.wurst   15 GB
            │
            ├── tiny header/index ranges
            ├── selected catalog pages
            └── only the requested data chunks
```

A normal full HTTP GET can still download all 15 GB. A Wurst-aware reader does not have to.

If a server stops honoring ranges or changes the pinned representation while the Wurst is open, the range source fails instead of silently combining bytes from different versions.

## Remote runtime status

`openHttpWurst()` exists in the format layer in 0.31.0.

Wurster Web already accepts an HTTP URL as a first-class Range-backed source and layers a writable browser-session PigFS overlay over that immutable remote base. Desktop Wurster does not yet accept an HTTP URL as a first-class launch target. The portable API name is the same in both families: `wurst.snapshot.export()`. Desktop streams its committed virtual WRST bytes through Wurster-owned save UI; Web materializes the remote base plus current overlay as a new standalone snapshot.

The intended model is:

```text
remote immutable/read-only base
          +
optional ephemeral session overlay
          ↓
standalone local snapshot when the user asks
```

A standalone snapshot necessarily has to acquire every byte it needs to become independent. Wurst streaming avoids unnecessary transfer during normal execution; it cannot make missing bytes magically portable.

## Undercover PNG

Undercover PNG preserves the virtual WRST offset model for reads by mapping virtual ranges to intersecting `wuSt` PNG chunks.

Incremental crash-safe PigFS writes inside the current PNG carrier are not implemented in 0.31.0. Carrier Wursts remain read-only for mutation until the carrier framing gains an append-safe journal.
