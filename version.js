#!/usr/bin/env node
'use strict';
/**
 * version.js — MiutChat's single source of truth for the app version.
 *
 * package.json's "version" field is canonical. Every other file that shows
 * or embeds a version (app.js, sw.js, index.html, manifest.json,
 * wrangler.toml, functions/api/health.js) gets it stamped in at BUILD time
 * by build.js reading through this module — never hand-edited — so the
 * version can never drift out of sync between files again.
 *
 * Bump scheme (custom, per product decision — not strict semver):
 *   patch increments normally: 1.0.0 → 1.0.1 → 1.0.2 → ...
 *   patch caps at 25: once it would exceed 25, it rolls into minor instead:
 *     1.0.25 → 1.1.0   (not 1.0.26)
 *   minor/major only change via an explicit 'minor'/'major' bump, or by
 *   rolling over from a capped patch as above.
 *
 * WHERE THE AUTOMATIC BUMP ACTUALLY HAPPENS — this matters:
 * It's the GitHub Action at .github/workflows/bump-version.yml, triggered
 * on every push to main. That workflow runs `node version.js patch` and
 * COMMITS the result back to the repository.
 *
 * build.js deliberately does NOT bump the version itself anymore — it only
 * reads whatever's already in package.json and stamps it everywhere. An
 * earlier version of this file tried bumping during the Cloudflare Pages
 * build instead, gated on process.env.CF_PAGES. That didn't work: Cloudflare
 * (and most CI) clones the repo fresh — and shallow — for every single
 * build, so any change build.js made to package.json during that build only
 * ever existed inside that one throwaway container. It never made it back
 * into the actual GitHub repository, so the next push started from the
 * exact same committed version and computed the exact same "next" value —
 * looking permanently stuck one bump behind, no matter how many times you
 * pushed. Bumping in the GitHub Action instead means the new version is
 * genuinely committed to the repo — real, permanent, visible in git log —
 * before anything ever clones the repo to build or deploy it.
 *
 * Manual bumps: `node version.js [patch|minor|major]` (defaults to patch)
 * updates package.json directly — useful for deliberately jumping to a new
 * minor/major before a release. Commit and push it like any other change;
 * the next automatic bump continues on from wherever this left off.
 */
const fs   = require('fs');
const path = require('path');

const PATCH_CAP = 25;               // 1.0.25 is the highest patch — next bump rolls to 1.1.0
const PKG_PATH  = path.join(__dirname, 'package.json');

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '0.0.0').trim());
  if (!m) return { major: 0, minor: 0, patch: 0 };
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/** nextVersion(current, level) → next version string, per the capped-patch scheme above. */
function nextVersion(current, level = 'patch') {
  let { major, minor, patch } = parseVersion(current);
  if (level === 'major') { major += 1; minor = 0; patch = 0; }
  else if (level === 'minor') { minor += 1; patch = 0; }
  else {
    patch += 1;
    if (patch > PATCH_CAP) { patch = 0; minor += 1; }
  }
  return formatVersion({ major, minor, patch });
}

function readPkgVersion() {
  try { return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version || '1.0.0'; }
  catch { return '1.0.0'; }
}

function writePkgVersion(v) {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  pkg.version = v;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

/** getVersion() → current version string, unchanged. This is what build.js calls. */
function getVersion() { return readPkgVersion(); }

module.exports = { nextVersion, getVersion, parseVersion, formatVersion };

// CLI: `node version.js [patch|minor|major]` — bumps and persists.
// Used both by the GitHub Action (automatic, on every push) and for manual
// deliberate bumps (run locally, then commit + push the result).
if (require.main === module) {
  const level = (process.argv[2] || 'patch').toLowerCase();
  if (!['patch', 'minor', 'major'].includes(level)) {
    console.error(`Usage: node version.js [patch|minor|major]`);
    process.exit(1);
  }
  const current = readPkgVersion();
  const next    = nextVersion(current, level);
  writePkgVersion(next);
  console.log(`Version bumped: ${current} → ${next}`);
}
