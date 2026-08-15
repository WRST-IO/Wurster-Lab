---
title: Signing Wurster Releases
group: Project
groupOrder: 6
order: 4
---

# Signing Wurster Releases

Wurster runtime code signing is separate from Wurst publisher signing.

```text
Wurst publisher signature  -> signs a .wurst / .wrst application
Wurster release signature  -> signs the runtime executable / installer
```

Do not place runtime release certificates in Wurst packages and do not use Wurst publisher keys to sign Wurster executables.

## Local signing environment

Copy:

```text
.env.signing.example
```

to:

```text
.env.signing.local
```

The local file and common certificate/private-key file extensions are ignored by git. Build scripts load this file only for release packaging.

## macOS

Direct macOS distribution uses a Developer ID Application identity. The build can either discover an appropriate certificate already installed in the macOS Keychain or receive a `.p12` through the signing environment.

Typical local values are:

```text
WURSTER_MAC_IDENTITY=Developer ID Application: Example Name (TEAMID)
WURSTER_MAC_CSC_LINK=/private/path/WursterDeveloperID.p12
WURSTER_MAC_CSC_KEY_PASSWORD=...
```

To request notarization:

```text
WURSTER_MAC_NOTARIZE=1
```

and provide either App Store Connect API-key credentials or Apple-ID/app-specific-password credentials supported by the packaging tool.

macOS signing/notarization builds are expected to run on macOS even though Apple also offers a Notary REST API for custom workflows.

## Windows

Windows release signing uses Authenticode. Wurster Lab supports a PFX path/value through:

```text
WURSTER_WIN_CSC_LINK=...
WURSTER_WIN_CSC_KEY_PASSWORD=...
```

A certificate already available through the Windows certificate store or hardware provider can instead be selected with:

```text
WURSTER_WIN_CERTIFICATE_SUBJECT_NAME=...
```

or:

```text
WURSTER_WIN_CERTIFICATE_SHA1=...
```

The Windows build itself is expected to run on Windows when using local Windows signing providers.

### Azure Trusted Signing

Electron-builder also supports Microsoft Azure Trusted Signing. Wurster Lab exposes its profile fields through the local signing environment:

```text
WURSTER_AZURE_SIGNING_PUBLISHER_NAME=...
WURSTER_AZURE_SIGNING_ENDPOINT=...
WURSTER_AZURE_SIGNING_CERTIFICATE_PROFILE_NAME=...
WURSTER_AZURE_SIGNING_ACCOUNT_NAME=...
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
```

When all four Wurster Azure profile fields are present, the Windows build selects the Azure signing path instead of relying on a local certificate file.

## Build output

```bash
npm run dist:win
npm run dist:mac:arm64
npm run dist:mac:x64
npm run dist:mac:universal
```

Outputs are organized below `runtime/windows/dist/` and `runtime/mac/dist/`.

## GitHub runtime releases

Pushing a tag that exactly matches `v<package.json version>` triggers `.github/workflows/release.yml`. The workflow runs the test gate, builds each desktop target on its native GitHub-hosted operating system and publishes the resulting installers plus updater metadata as normal Release assets. Wurster 0.x tags remain pre-1.0 software versions, but the GitHub Releases are intentionally not marked as prereleases so the stable desktop updater channel can discover them.


The desktop package carries a GitHub `publish` configuration for `WRST-IO/Wurster-Lab`. Release builds use it to embed Electron's private `app-update.yml` runtime configuration while CI still publishes the final, cross-architecture Release asset set itself. The packaged updater therefore has one canonical public feed configuration without runtime-side `setFeedURL` overrides.

Windows Authenticode remains independently configurable. When the Windows build is signed, electron-builder records the resolved publisher in `app-update.yml` and electron-updater verifies downloaded installers against that publisher. The release metadata also marks the current per-machine NSIS installer as requiring elevation during update installation.

Signing credentials are never stored in the repository. The current hosted macOS release jobs fail closed unless all five repository secrets are configured:

```text
MAC_CSC_LINK
MAC_CSC_KEY_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

`MAC_CSC_LINK` carries the Developer ID Application `.p12` as a Base64 value and `MAC_CSC_KEY_PASSWORD` unlocks that `.p12`. `APPLE_ID` is the Apple Account used for notarization, `APPLE_APP_SPECIFIC_PASSWORD` is a dedicated app-specific password generated for that account rather than the normal account password, and `APPLE_TEAM_ID` selects the Apple Developer Program team used for the notarization request.

The workflow creates the hardened-runtime Electron entitlements temporarily on the GitHub runner, signs and notarizes each macOS build, then verifies the resulting app with `codesign`, Gatekeeper and `stapler` before publishing it. These temporary CI entitlements do not change the configuration of a normal local `npm run dist:mac:*` build.

The Windows hosted build remains a separate signing concern. Its installer can be produced without the Apple credentials, while Windows Authenticode or Azure Trusted Signing can be enabled independently.
