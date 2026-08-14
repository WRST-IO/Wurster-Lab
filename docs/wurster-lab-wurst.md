# WursterLab.wurst

`WursterLab.wurst` is the self-hosting project handoff container for Wurster Lab.
It is deliberately a normal Wurst application using PigFS rather than a
special repository format.

## Realms

The Lab carries three independent mutable realms:

```text
/workspace   ordinary mutable storage
/lab         ordinary mutable notes/release metadata
/operator    personal sealed storage
```

Ordinary realms have no special mode in a new manifest. They are simply
mutable Wurst data. They do not require an identity, signatures or retained
history.

The `operator` realm is an unclaimed `governance: "personal"` realm in a fresh
Lab. The first Wurster Identity that explicitly unlocks it becomes its sole
owner. Personal realms are non-shareable by definition.

## Operator material

The Lab UI can import exactly these WRST.IO operator files into the sealed
personal realm:

- `root.json`
- `issuer.json`
- `trust-bundle.json`
- `issuer.wurstissuer`

The Root and Issuer Meatphrases are not stored by Wurster Lab. The UI validates
that the four files form one coherent WRST.IO production chain before showing
the kit as verified.

## Project handoff

The full source workspace is stored directly under `/workspace`, not as a
nested ZIP. A maintainer or agent can update that ordinary realm without
unlocking `/operator`.

The workspace updater always writes a new filename:

```text
WursterLab_v0.31.0_r001.wurst
WursterLab_v0.31.0_r002.wurst
WursterLab_v0.31.0_r001.wurst
```

The old Wurst is never overwritten. This is useful for explicit handoff,
backup, and clients that cache downloaded files by filename.

```bash
npm run build:wurster-lab-wurst
npm run update:wurster-lab-wurst -- /path/to/WursterLab_v0.31.0_r001.wurst
```

An incremental update synchronizes only `/workspace` and release metadata.
A claimed personal operator realm is copied forward as opaque encrypted PigFS
state. The updater neither requests nor needs its identity key.

## Local production workspace

After the personal operator realm is unlocked and all four files verify, the Lab
can create a local private operator ZIP from the public `/workspace`. Public
WRST.IO trust material is synchronized into the Desktop, Web, MeatGrinder, site
and Worker locations, while `issuer.wurstissuer` is placed only in the private
Authority workspace path. This ZIP is a local build/deploy artifact and must not
be published or used as the project handoff file.

The project handoff remains the `.wurst` itself.

## Lab UI

The immutable Lab application provides:

- current release and workspace readout;
- current `CHANGELOG.md` presentation;
- portable plain project notes;
- WRST.IO operator-material import and validation;
- local production-workspace export that overlays the verified operator material onto the carried source tree;
- PigFS compaction after the owner unlocks a claimed personal realm;
- scientifically questionable pig diagnostics.

The Lab application is signed because host-file import is a Wurster-controlled
RED capability. Until the official Wurster publisher identity is established,
development builds use an ephemeral application signer.

## Storage semantics

The Lab is intentionally a reference case for mixed PigFS storage. Ordinary
storage, personal sealed storage, and later shared multi-user realms may coexist
inside one Wurst without forcing one another's security or history semantics.

## Sealed operator settings

The personal `/operator` realm can also store `operator-settings.json` with format `wrst/operator-settings-1`. It currently contains the HTTPS Mail Relay endpoint and the HMAC relay secret. Both remain encrypted with the personal realm and are never copied into the public `/workspace`.

`Verwursten` copies those settings only into `authority/wrst.io/private/operator-settings.json` inside the private production ZIP. The root `.gitignore` excludes the complete Authority private directory. From that private workspace, `npm run authority:worker:relay-secrets` can restore `WRST_MAIL_RELAY_URL` and `WRST_MAIL_RELAY_SECRET` to Wrangler without retyping them.

A fresh WursterLab can import a previous private production ZIP. The Lab extracts and verifies only the four known WRST.IO operator files and the optional operator settings, then seals them into the new personal realm. This is the one-step bootstrap path when the immutable Lab application shell itself has changed.
