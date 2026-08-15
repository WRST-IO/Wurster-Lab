---
title: Current status
group: Project
groupOrder: 6
order: 1
---
# Current status

Wurster 0.32.4 is pre-1.0 but intended for real integration work. Presence of code is not the same as a stable contract; this page is the short maturity map.

| Area | 0.32.4 status | Current boundary |
| --- | --- | --- |
| Windows Desktop | release lane | shared Electron runtime |
| macOS arm64/x64 | release lane | signed/notarized workflow |
| Wurster Web | release lane | browser runtime and `<wurst-embed>` |
| Linux Desktop | development lane | build path exists |
| iOS / Android | reserved | no conforming release yet |
| **PigFS** | **functional / pre-stable** | files, directories, stable IDs, transactions, snapshots, quotas, symlinks, watches, realms, encryption and compaction |
| **PigLink** | **functional / pre-stable** | typed Actions/Events across UI, Desktop, Web and headless paths |
| **Piglet** | **functional / pre-stable** | universal Views, cooperative Parent↔Child links, shared sessions, machine attachments and writable Child PigFS on Desktop/Web |
| **Pigsty** | **experimental / coming soon** | contracts/adapters exist; native Edge/WASIX runtime is not a normal release dependency |

## Important 0.32.4 limits

- Multiple Views and in-runtime machine clients of the same Child share one durable Wurst session and revision-safe PigFS state.
- A browserless Parent Wurst can use Child Wursts as PigLink subtools without a DOM.
- A separately launched CLI/MCP process **cannot yet attach to a Desktop/Web session already owned by another Wurster process**. That external machine broker is still open work.
- The generic CLI Child-subtool path does not yet have full writable nested-Child PigFS and Parent-service parity with Desktop/Web.
- Pigsty's development worker is not the final hostile-code production sandbox.

Pre-1.0 contracts may still change cleanly. Discarded designs are removed rather than preserved through compatibility shims.
