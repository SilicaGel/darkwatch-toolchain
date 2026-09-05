## 2.0.0 — 2026-09-04 (#2128)

- The brochure is generated from `site/manifest.mjs`; `site/index.html` is never hand-edited.
- Captures moved from `site/screenshots.js` to `tests/brochure/` (Playwright project, own config, own database lane). `screenshots.js` and the old PNGs are removed in PR 1b.
- Retired `references/processes.md` (the Feature added/changed/removed, `--audit`, `--full-audit`, `--add`, `--ignore` processes) and `references/brochure-server.md` (the port-3099/5199 stack). `--audit` is now `node site/audit.mjs`; the maps coverage-gap table is gone because the rows exist in the manifest.
- Theme axis is War Table only (Storm Glass, Torchlit), alternating by row within a section.
