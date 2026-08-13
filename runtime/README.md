# Wurster Runtime Family

This directory contains host implementations of the same portable Wurst contract.

- `desktop/` shared Electron runtime source used for Windows/macOS today.
- `windows/` Windows release output and platform-specific release notes.
- `mac/` macOS release output and platform-specific release notes.
- `web/` browser runtime and embeddable `wurster.min.js` surface.
- `ios/` reserved native iOS runtime home.
- `android/` reserved native Android runtime home.

A platform directory never defines a platform-specific Wurst format. Platform differences are runtime implementation details and optional capability availability.
