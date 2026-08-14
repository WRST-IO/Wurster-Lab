---
title: Personal Data
group: Runtime & Format
groupOrder: 2
order: 4
---
# Personal data

Personal PigFS realms are for the simple case: **this mutable data belongs to one Wurster Identity and is not shareable**.

```json
{
  "id": "private",
  "governance": "personal"
}
```

Personal realms are always sealed. Wurster encrypts their file names, metadata and payloads with a random realm key and wraps that key for exactly one Wurster Identity.

A fresh personal realm may be unclaimed. The first authenticated identity that explicitly unlocks it becomes the owner. No server registration is involved.

Personal storage carries no audit history by default. Update and delete are final. After compaction, obsolete ciphertext is physically discarded and the Wurst can shrink again.

Personal storage is intentionally not a one-member sharing group. It has no grant/revoke UI. Moving data into a shared realm is an explicit application/user operation, not a silent policy switch.
