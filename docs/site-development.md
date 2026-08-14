---
title: Documentation & Site Build
group: Project
groupOrder: 6
order: 3
---

# Documentation and wrst.io

`wurster-lab` contains the Eleventy source for the wrst.io documentation surface in `site/`.

The canonical documentation remains in the repository-level `docs/` directory. Every public Markdown document already contains the Eleventy navigation front matter used by the site.

Before a site build, the docs are synchronized into `site/src/docs/`:

```text
npm run docs:sync
npm run docs:build
```

For local development:

```text
npm run docs:serve
```

The export helper also performs the docs synchronization before creating a Wurster Lab ZIP. This keeps every shared lab snapshot self-contained: runtime source, MeatGrinder, format implementation, tests, documentation and the future website live in one workspace.

The website is a presentation layer. Wurst itself has no dependency on wrst.io.

## Monorepo Pages and runtime releases

`wrst.io` stays inside the Wurster monorepo, but the public site follows the **released** documentation snapshot instead of every development commit on `main`.

Repository-level `docs/` is the canonical editing source and may move ahead between releases. `site/src/docs/` is only a build staging area: `.github/workflows/pages.yml` checks out an explicit release commit, synchronizes the public Authority discovery files, Wurster Web and canonical Markdown docs, builds Eleventy and deploys `site/_site` to GitHub Pages. The synchronized files are not committed back to `site/src/docs/`.

Normal pushes to `main` do not deploy Pages. `.github/workflows/release.yml` publishes the Windows, macOS and Web assets first. After that release workflow completes successfully, `.github/workflows/pages.yml` starts through GitHub's `workflow_run` event from the default-branch context and checks out the exact `head_sha` of the successful release run. This keeps the `github-pages` environment restricted to `main` while still deploying the released documentation snapshot. A manual Pages run also requires an explicit tag or commit, so recovery deployments cannot accidentally publish whatever happens to be newest on `main`.

The Pages artifact explicitly includes hidden files. This is required because WRST.IO publishes its static trust discovery under `/.well-known/`.

Local `npm run dist:mac:arm64` and `npm run dist:mac:x64` builds are useful smoke tests, but `dist/` remains gitignored so installer binaries do not bloat Git history. To publish a runtime version, first make the package version final, then push the matching tag:

```bash
git tag v0.32.2
git push origin v0.32.2
```

`.github/workflows/release.yml` verifies that the tag exactly matches the root package version, runs the test gate, builds Windows x64 on a Windows runner, Apple Silicon on an arm64 macOS runner and Intel macOS on an Intel runner, then publishes a GitHub Release with SHA-256 checksums. Only after the release workflow succeeds does the separate Pages workflow deploy wrst.io from that release run's exact commit. The Runtime page derives the repository from GitHub Actions and links directly to these versioned assets.
