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
 * When it bumps automatically:
 *   Only when process.env.CF_PAGES === '1' — the env var Cloudflare Pages
 *   sets on every real Pages build/deploy. A plain local `node build.js`
 *   (e.g. while testing) reads the current version but does NOT bump it,
 *   so version numbers aren't churned by local iteration — only by an
 *   actual "upload"/deploy, matching what was asked for.
 *
 * Manual bumps: `node version.js [patch|minor|major]` (defaults to patch)
 * updates package.json directly — useful for deliberately jumping to a new
 * minor/major before a release. The very next deploy's auto patch-bump then
 * continues on from wherever this left off.
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

/** getVersion() → current version string, unchanged, for read-only callers. */
function getVersion() { return readPkgVersion(); }

/**
 * maybeBumpVersion() → the version build.js should stamp everywhere.
 * Auto-bumps (patch, with rollover) and persists to package.json only on a
 * real Cloudflare Pages build; otherwise returns the current version as-is.
 */
function maybeBumpVersion() {
  const current = readPkgVersion();
  if (process.env.CF_PAGES !== '1') return current;
  const next = nextVersion(current, 'patch');
  writePkgVersion(next);
  return next;
}

module.exports = { nextVersion, getVersion, maybeBumpVersion, parseVersion, formatVersion };

// CLI: `node version.js [patch|minor|major]` — manual bump, always persists.
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
