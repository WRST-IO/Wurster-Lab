# Linux Runtime

This directory is the prepared Linux desktop output lane for the shared Electron Wurster runtime.

`npm run dist:linux` builds an x64 AppImage into `runtime/linux/dist/`. Before Electron Builder starts, Wurster Lab stages the pinned `linux-amd64` Pigsty Edge/WASIX bundle from the parallel `WRST-IO/wurster-edge-runtime` release contract.

Linux is intentionally not added to the public Wurster GitHub release asset set yet. The lane exists so the real runtime can be exercised and packaging can be accepted before public Linux distribution is enabled.
