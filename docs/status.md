---
title: Current status
group: Project
groupOrder: 6
order: 1
---
# Current status

Wurster 0.32.7 is pre-1.0 but intended for real integration work. Presence of code is not the same as a stable contract; this page is the short maturity map.

| Area | 0.32.7 status | Current boundary |
| --- | --- | --- |
| Windows Desktop | release lane | shared Electron runtime |
| macOS arm64/x64 | release lane | signed/notarized workflow |
| Wurster Web | release lane | browser runtime and `<wurst-embed>` |
| Linux Desktop | development lane | build path exists |
| Desktop auto-update | release lane | default-on GitHub Release checks on packaged macOS/Windows; user opt-out in Settings |
| iOS / Android | reserved | no conforming release yet |
| **PigFS** | **functional / pre-stable** | files, directories, stable IDs, transactions, snapshots, quotas, symlinks, watches, realms, encryption and compaction |
| **PigLink** | **functional / pre-stable** | typed Actions/Events across UI, Desktop, Web and headless paths |
| **Piglet** | **functional / pre-stable** | universal Views, cooperative Parent↔Child links, shared sessions, machine attachments and writable Child PigFS on Desktop/Web |
| **Pigsty** | **experimental / coming soon** | contracts/adapters exist; native Edge/WASIX runtime is not a normal release dependency |

## Desktop updates

Packaged Wurster Desktop builds on macOS and Windows check the public WRST-IO/Wurster-Lab GitHub Releases channel at startup by default. When a newer stable release is available, Wurster shows its own update view, downloads the platform update, then hands installation to the Electron updater.

Automatic updates are a local Wurster setting and can be disabled under **Settings → Updates** to intentionally remain on an older runtime. Development/unpackaged runs never auto-update, and a failed update check falls back to normal startup instead of blocking Wurster.

## Important 0.32.7 limits

- Multiple Views and in-runtime machine clients of the same Child share one durable Wurst session and revision-safe PigFS state.
- A browserless Parent Wurst can use Child Wursts as PigLink subtools without a DOM.
- A separately launched CLI/MCP process **cannot yet attach to a Desktop/Web session already owned by another Wurster process**. That external machine broker is still open work.
- The generic CLI Child-subtool path does not yet have full writable nested-Child PigFS and Parent-service parity with Desktop/Web.
- Pigsty's development worker is not the final hostile-code production sandbox.

Pre-1.0 contracts may still change cleanly. Discarded designs are removed rather than preserved through compatibility shims.
