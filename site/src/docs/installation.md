---
title: Installation
group: Getting Started
groupOrder: 1
order: 3
---
# Installation

Wurster is one desktop application. The runtime, launcher, Meat Locker and MeatGrinder live in the same app, so the machine only needs one pig.

## macOS

```bash
npm install
npm test
npm run dist:mac:arm64
```

Use `dist:mac:x64` for Intel or `dist:mac:universal` for a combined Apple Silicon + Intel build.

Opening Wurster itself shows the small launcher. Opening a `.wurst` or `.wrst` from Finder goes straight to that Wurst. Closing the Wurst ends the Wurster process.

Release distribution will eventually add Apple signing and notarization. Those are distribution concerns and do not change the Wurst format.

## Windows

```bash
npm install
npm test
npm run dist:win
```

This builds one Wurster installer. Wurster registers both `.wurst` and `.wrst` as equivalent document types. The MeatGrinder is the flip side of the Wurster launcher rather than a second executable.

## Linux

The runtime architecture is portable, but packaged Linux targets are still a release task. The Wurst format itself contains no operating-system-specific cryptographic dependency.
