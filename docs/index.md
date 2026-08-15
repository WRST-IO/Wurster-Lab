---
title: Wurster Docs
group: Getting Started
groupOrder: 1
order: 1
permalink: /docs/
---
# Wurster

**Wurst is a portable software format for useful everyday tools, workflows and applications, from a tiny utility to a complete working environment.**

A Wurst can contain normal HTML, CSS, JavaScript, media, PigFS data, PigLink behavior and other Wursts. MeatGrinder turns a project folder into one portable `.wurst`; Wurster runs it without handing that software the user's computer.

```text
project → MeatGrinder → my-tool.wurst → Wurster
```

A browser-ready folder with `index.html` is enough for the simple case. Add `wurst.json` only when the application needs PigFS, PigLink, protection, runtime capabilities or special presentation.

## The five sentences to remember

1. **A Wurst is universal.** Host-specific implementation details belong to Wurster.
2. **Wurst ↔ Host is the hard security boundary.** Host FS, shell, processes and Wurster secrets are never ambient.
3. **PigFS stores, PigLink connects, Piglet composes, Pigsty computes.**
4. **Everything has an end. Only Wurst has two.** Human Views and machine clients can address the same durable Wurst world.
5. **`<wurst-embed>` is only a View.** Inside another Wurst it creates a Piglet relationship; it is not the Piglet itself.

## Where to go next

- [Getting Started](getting-started.md) - build and open a Wurst.
- [Current status](status.md) - what 0.32.5 actually supports.
- [PigFS](pigfs.md), [PigLink](piglink.md), [Piglet](piglet.md), [Pigsty](pigsty.md) - the four runtime pillars.
- [Security Model](security-model.md) - the Host fence and internal cooperation.
- [Universal Runtime Law](universal-runtime.md) - what every conforming Wurster must preserve.
