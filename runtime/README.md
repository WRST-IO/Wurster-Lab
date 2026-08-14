# Wurster Runtime Family

This directory contains host implementations of the same portable Wurst contract.

- `desktop/` shared Electron runtime source used for Windows/macOS today.
- `windows/` Windows release output and platform-specific release notes.
- `mac/` macOS release output and platform-specific release notes.
- `linux/` prepared Linux desktop output lane; public release enablement is separate.
- `web/` browser runtime and embeddable `wurster.min.js` surface.
- `ios/` reserved native iOS runtime home.
- `android/` reserved native Android runtime home.

A platform directory never defines a platform-specific Wurst format. Platform differences are runtime implementation details and optional capability availability.

## Pigsty runtime inputs

Desktop packaging does not keep Edge.js/WASIX binaries in this repository. `runtime/edge-runtime.lock.json` pins release assets from `WRST-IO/wurster-edge-runtime`; `tools/wurster-edge-runtime.mjs` can verify and stage target bundles under the gitignored `runtime/desktop/runtimes/`, and Electron Builder knows how to copy a staged bundle to `resources/runtimes/`.

Normal v0.32 Windows/macOS builds do **not** fetch or require those bundles. Pigsty packaging is opt-in with `WURSTER_BUNDLE_PIGSTY=1` until the native runtime set passes its own release/conformance gates. This keeps Windows, macOS and Web releases independent from unfinished Pigsty infrastructure without throwing away the prepared integration path.
