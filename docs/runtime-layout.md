---
title: Runtime Layout
group: Runtime
groupOrder: 3
order: 1
---

# Runtime Layout

Wurster Lab separates the portable Wurst contract from the runtimes that implement it.

```text
runtime/
├── desktop/   shared Electron desktop implementation
├── windows/   Windows build output / platform notes
├── mac/       macOS build output / platform notes
├── web/       browser-hosted runtime
├── ios/       reserved native iOS runtime
└── android/   reserved native Android runtime
```

The shared desktop implementation remains one codebase because Windows and macOS currently share Electron/Chromium behavior. Release artifacts no longer live beside that source: Windows builds go to `runtime/windows/dist/` and macOS builds go to `runtime/mac/dist/`.

This layout is organizational, not part of WRST. A Wurst never contains a `windows`, `mac`, `ios`, `android` or `web` mode.

## Conformance, not identical internals

A Wurster runtime may use Electron, a system WebView, a native renderer host or another implementation. Conformance means that the runtime understands the same Wurst package, enforces the same portable boundaries and exposes the same baseline Wurst APIs.

Optional host functionality is reported as runtime capability availability. Missing host functionality must not create a new platform-specific Wurst format.
