---
title: Wurster Docs
group: Getting Started
groupOrder: 1
order: 1
permalink: /docs/
---
# Wurster

Wurst is a portable application format for small web apps, tools, widgets and delightfully unnecessary software.

A Wurst contains normal web technology: HTML, CSS, JavaScript, media and optional mutable user data. Wurster is the runtime that opens it. MeatGrinder is the tool that turns a project folder into one portable file.

```text
web project
    ↓
MeatGrinder
    ↓
my-app.wurst
    ↓
Wurster
```

The happy path is intentionally boring. Drop a browser-ready project folder into MeatGrinder and press **Start MeatGrinder**. If the folder contains `index.html`, no manifest is required.

A `wurst.json` file only becomes useful when a Wurst needs special behavior such as a frameless window, transparent background, mutable WurstFS data, protected application content or runtime capabilities.

## Four ideas to remember

**A Wurst is universal.** A valid Wurst must be usable by every conforming Wurster runtime. Platform features such as Touch ID or a system keystore may protect a local Wurster Meat Locker, but they never become a requirement of the Wurst file itself.

**Wursts are served in slices.** WRST v7 is a binary random-access container. Runtimes can read metadata first, fetch only the resource slices they need, and append transactional WurstFS writes without rebuilding the immutable application base.

**User secrets and app secrets are different.** A Meatphrase belongs to user-owned mutable data. A WurstKey protects developer-owned sealed application content. They are deliberately separate.

**Everything has an end. Only Wurst has two.** A Wurst may expose a visible UI on one side and PigLink on the other. The same declared Actions already serve UI and headless/tooling paths; brokered links between separate running Wursts are the next communication layer.

## Three v0.30 pillars

**Pigsty is computation.** A Wurst can build and transform its own internal workspace where the runtime provides Pigsty. In normal v0.32 Desktop releases the native Pigsty engine is still coming soon, so Pigsty does not block Windows/macOS/Web releases.

**Piglet is composition.** Wursts can contain and embed other Wursts without merging trust domains.

**PigLink is communication.** Wursts expose declared behavior to other Wursts, tools and automation without turning the DOM into an API.

For exact release maturity, see [Current status](status.md). Next: [Getting Started](getting-started.md).
