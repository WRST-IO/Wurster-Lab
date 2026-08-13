# wrst.io site inside Wurster Lab

This directory contains the Eleventy presentation layer for the future wrst.io site.

The canonical product documentation does **not** live here. It lives one level up in `../docs/` so runtime/code snapshots and website documentation cannot silently diverge.

Use:

```bash
npm run docs:sync
npm run docs:setup   # first local site setup
npm run docs:build
npm run docs:serve
```

`docs:sync` copies the canonical Markdown into `site/src/docs/` and rewrites source `.md` links to the site's pretty `/docs/.../` URLs. Every canonical page already carries Eleventy-compatible `title`, `group`, `groupOrder` and `order` front matter.

`tools_export_wurster_lab.py` runs the sync automatically before creating a Lab ZIP.

The website is optional infrastructure. Existing Wursts and Wurster runtimes never depend on wrst.io being online.
