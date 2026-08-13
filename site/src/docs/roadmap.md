---
title: Road to Wurster 1.0
group: Project
groupOrder: 6
order: 2
---

# Road to Wurster 1.0

Wurster 0.11 began the deliberate alpha/beta stretch toward the first stable format and runtime family.

The working release lane is:

```text
0.11 – 0.14   alpha hardening / runtime expansion
0.15 – 0.19   beta / conformance / platform work
1.0           stable Wurst contract + conforming runtimes
```

The exact feature-to-version assignment can move. The important part is that the project now favors conformance, recovery, documentation and platform behavior over accumulating unrelated features.

## Before 1.0

Primary work includes:

- finish the WurstFS v2 storage model: keep ordinary/personal storage compact and history-free by default, add trusted sharing UI, settle directory-policy inheritance, add safe shared-integrity checkpoints/garbage collection, merge/fork UX and remote read-only/overlay behavior;
- complete Wurster Identity federation around public `.wurstid` exchange, local contacts and optional WRST.IO identity-claim certificates;
- signed network capability policy, including HTTPS, explicit HTTP and local-network use;
- harden the now-established WRST.IO Root → issuer → publisher Authority chain, operator recovery ceremony and revocation presentation;
- runtime capability availability instead of platform-specific Wurst formats;
- a written WRST v7 specification and conformance suite;
- Windows/macOS release signing and installer hardening;
- native Windows user-presence integration with a correctly owned Windows Hello/PIN dialog;
- finish Wurster Web parity after 0.14/0.15 WurstKey + Authority work: personal/shared WurstFS realm crypto, trusted Desktop↔Web identity handoff, live DNS/local-trust presentation, Undercover source support and conformance;
- additional conforming runtimes, with iOS/macOS work able to use the Apple developer distribution path when ready.

## Deliberately later

Tor/VPN routing, TEE confidential execution, external hardware identity providers and high-level document-approval/attestation UX are valuable directions, but they are not required to make Wurst 1.0 a coherent portable application format. The WurstFS v2 identity/signature primitives intentionally land before 1.0 because later attestations can reuse them, but ordinary CRUD and personal storage remain history-free by design.
