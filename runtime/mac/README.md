# macOS Runtime Output

`npm run dist:mac:arm64`, `dist:mac:x64`, or `dist:mac:universal` writes macOS Wurster artifacts here under `runtime/mac/dist/`.
The shared Electron implementation lives in `runtime/desktop/`. Developer ID signing and notarization are configured through `.env.signing.local` and run on macOS.
