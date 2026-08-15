---
title: Road to Wurster 1.0
group: Project
groupOrder: 6
order: 2
---
# Road to Wurster 1.0

The 0.3x line is about making the existing Wurst model dependable rather than collecting unrelated features.

```text
0.32.x   PigFS + PigLink + Piglet real-world integration
0.4x     conformance, recovery, lifecycle and platform hardening
1.0      stable Wurst contract + conforming runtimes
```

## Before 1.0

The main remaining work is:

- external machine broker so CLI/MCP can attach to an already running Desktop/Web Wurst session;
- complete nested headless Child write/delegation parity;
- path-scoped Parent PigFS delegation and stronger connect/disconnect/revoke lifecycle;
- generic PigLink resource/stream handles where real applications require them;
- multi-process write coordination for the same physical Wurst file;
- crash/recovery, deep nesting and adversarial authority-composition tests;
- conformance tests shared by Desktop, Web and future native Wursters;
- production Pigsty isolation and release-ready Edge/WASIX bundles.

Pigsty remains independent of the normal release lane until its native runtime is ready. WurstOS is a valuable real-life consumer, not the definition of Wurst; runtime contracts should remain useful for small tools, automation, editors, workspaces and other application shapes.

## Pre-1.0 rule

When a pre-1.0 contract is replaced, remove the discarded design instead of maintaining two competing ways to do the same thing.
