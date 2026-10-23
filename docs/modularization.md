# Modularization notes

Upstream base: 3fa9eea (v1.2.34). Re-check line numbers against the current main before reapplying anything.

## Layout
Source is organised by role under `src/`, `public/`, `config/`; `dist/` stays flat. `scripts/build.js` indexes source files by name and fails on duplicates. See README → Project structure.

## Runtime modules
- `src/app/app.js` — core ES module (`<script type="module">`).
- `src/app/lazy/file-transfer.js`, `feedback.js` — loaded with `import()` through `_lazyModule()` in app.js. A failed load shows a toast and retries with `?r=N`.
- The build bundles each lazy module separately (`--external:./app.min.js`) into `lz-<name>-<hash>.js`, rewrites the import path in app.min.js, and adds the names to the service worker's optional precache.
- Small latency-sensitive UI (attach tabs, report button, media placeholder) intentionally stays in app.js.

## Standing checks
- `.mjs` copy + `node --check` for every module.
- eslint `no-undef` on app.js, file-transfer.js, feedback.js (remaining app.js hits are globals from security.js, db-manager.js, crypto-bridge.js).
- Headless Chromium: 0 lazy requests on load, 1 per feature use, a 404 shows a toast, a retry recovers.
- After any layout change: build before and after and `diff -r` the two `dist/` folders (only `sri-manifest.json`'s timestamp may differ).

## Fixed on the way
- `bootApp()` reassigned the now-private `_chunkGroups` (ReferenceError in strict ESM).

## Open items
- `archive/notify.js` differs from `functions/api/notify.js` and nothing references it; `archive/miut-protocol.js` is referenced by nothing.
- Next split candidates: settings and member-detail panels, multi-select bar.
- The boot splash is a fixed 1800 ms timer.
- A real file send/receive could not be tested without the Firebase SDK; test one image in a real room.
