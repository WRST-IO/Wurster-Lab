---
title: PNG Carrier Reference
group: Specification
groupOrder: 5
order: 2
---
# Undercover Wurst 🥷🌭

Undercover Wurst is the PNG carrier mode for Wurst.

The canonical Wurst container remains WRST. A PNG carrier is only an outer transport layer:

```text
valid PNG image
├── normal PNG chunks
├── wuSt private ancillary chunk 0
├── wuSt private ancillary chunk 1
├── ...
└── IEND
```

Each `wuSt` chunk contains a slice of one complete WRST stream. Normal PNG viewers ignore the private ancillary chunks and display the carrier image. Wurster maps those chunks into one virtual WRST byte stream and then uses the normal Wurst parser, integrity checks, signatures, WurstKey crypto and range reads.

## Build

Project config:

```json
{
  "id": "io.example.secret-widget",
  "name": "Secret Widget",
  "carrier": "carrier.png"
}
```

Or explicitly:

```bash
meatgrinder build . --carrier carrier.png
```

With a carrier and no explicit output filename, Meat Grinder emits `.png` instead of `.wurst`.

## Open

Wurster's picker accepts `.wurst`, `.wrst` and `.png`. The desktop runtime intentionally does not register itself as the global PNG handler. Use the Wurster picker, drag/open workflow, or `Open with Wurster` for a PNG carrier.

## Slices

The PNG carrier does not destroy WRST random access. Wurster first scans PNG chunk headers and records the physical locations of the `wuSt` slices. Reads against the virtual WRST stream are then mapped only to the carrier chunks that intersect the requested byte range.

This means a future multi-gigabyte Undercover Wurst does not inherently need to be loaded as a whole.

## Security

Carrier mode is camouflage, not cryptography.

A knowledgeable observer can detect private `wuSt` chunks. Confidentiality must come from WurstKey-protected application content and/or a sealed personal/shared PigFS realm. Package signatures and WRST integrity checks continue to work exactly as they do for native `.wurst` / `.wrst` files.

Re-saving or optimizing the PNG in an image editor may remove unknown/private chunks and therefore destroy the embedded Wurst payload. Treat the carrier image as a binary package, not as an editable source image.
