'use strict';

/**
 * Miut — db-manager.js
 * ═══════════════════════════════════════════════════════════════
 * Multi-database manager. Currently one database is active.
 * Add DB1 and DB2 configs when ready — the manager will
 * automatically distribute rooms across all active databases
 * and fall back if one is unavailable.
 *
 * How distribution works:
 *   roomIndex = hash(roomCode) % activeDbCount
 *   Same room code → same database, always, deterministically.
 *
 * How fallback works:
 *   If the primary database for a room fails, the next one in
 *   the list is tried. The working database is cached per-room
 *   for the session lifetime.
 * ═══════════════════════════════════════════════════════════════
 */

/* ── App Check configuration ──────────────────────────────────
 * Firebase App Check prevents unauthorized clients from accessing
 * your Firestore database.
 *
 * HOW TO GET YOUR SITE KEY:
 *   1. Go to https://www.google.com/recaptcha/admin
 *   2. Register your domain (e.g. miutchat.pages.dev) as reCAPTCHA v3
 *   3. Copy the "Site key" and paste it below
 *   4. Back in Firebase Console → App Check → Register your web app
 *      → choose reCAPTCHA v3 → paste the same site key
 *
 * Leave RECAPTCHA_SITE_KEY as an empty string only if you have
 * completely disabled App Check in the Firebase Console.
 * ─────────────────────────────────────────────────────────── */
const RECAPTCHA_SITE_KEY = '6LcduZosAAAAAHhBdWag1xYW3myZ_XOA4an3IpmV'; // ← replace this

/* ── Initialise Firebase App Check (runs once, before any db use) */
(function _initAppCheck() {
  try {
    if (typeof firebase === 'undefined' || !RECAPTCHA_SITE_KEY) return;
    const appCheckInstance = firebase.appCheck();
    appCheckInstance.activate(
      new firebase.appCheck.ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
      /* isTokenAutoRefreshEnabled */ true
    );
  } catch (e) {
    console.warn('[Miut] App Check init skipped:', e.message);
  }
})();



const _DB_CONFIGS = window.__MIUT_DB_CONFIGS__ || []

/* ── Only work with active databases ─────────────────────────── */
// _ACTIVE_DBS is populated after _loadConfig() resolves (see getDb / getDbStatus)
let _ACTIVE_DBS = _DB_CONFIGS.filter(d => d.active);

/* ── Health tracker — exponential backoff per database ──────── */
const _health = new Map();
function _syncHealth() {
  _ACTIVE_DBS.forEach(d => {
    if (!_health.has(d.name)) _health.set(d.name, { fails: 0, cooldownUntil: 0, lastErr: null });
  });
}
_syncHealth();

/* ── Fetch config from Cloudflare Worker (/api/config) ──────── */
let _configLoaded   = false;
let _configPromise  = null;

async function _loadConfig() {
  if (_configLoaded) return;
  if (_configPromise) return _configPromise;
  _configPromise = (async () => {
    try {
      // 5s timeout — prevents hanging forever if Cloudflare Worker is slow
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let res;
      try {
        res = await fetch('/api/config', { credentials: 'same-origin', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error('Config fetch HTTP ' + res.status);
      const data = await res.json();
      if (Array.isArray(data.databases) && data.databases.length) {
        const active = data.databases.filter(d =>
          d.active && d.config?.apiKey && d.config.apiKey.length > 10
        );
        if (active.length) {
          window.__MIUT_DB_CONFIGS__ = data.databases;
          _ACTIVE_DBS = active;
          _syncHealth();
          console.log('[MiutDB] Config loaded —', active.length, 'active DB(s)');
        } else {
          throw new Error('No active databases in config response');
        }
      } else {
        throw new Error('Config response missing databases array');
      }
    } catch (err) {
      console.warn('[MiutDB] Remote config failed:', err.message);
      // Hard fallback: use window.__MIUT_DB_CONFIGS__ if pre-loaded by build
      if (Array.isArray(window.__MIUT_DB_CONFIGS__) && window.__MIUT_DB_CONFIGS__.length) {
        _ACTIVE_DBS = window.__MIUT_DB_CONFIGS__.filter(d => d.active);
        _syncHealth();
        console.log('[MiutDB] Using pre-loaded config fallback');
      }
    }
    _configLoaded = true;
  })();
  return _configPromise;
}

/* Cooldown durations indexed by consecutive failure count */
const _COOLDOWNS = [30e3, 120e3, 480e3, 1800e3, 3600e3]; // 30s→2m→8m→30m→1h

/* Per-room database resolution cache (session lifetime) */
const _roomDbCache = new Map();

/* Initialised Firestore instances */
const _instances = new Map();

/* ── Initialise a Firebase app + Firestore instance ─────────── */
function _initDb(cfg) {
  if (_instances.has(cfg.name)) return _instances.get(cfg.name);
  if (typeof firebase === 'undefined') {
    throw new Error('Firebase SDK not loaded. Check that gstatic.com is reachable and no extension blocks it.');
  }
  // Validate config has real values (not placeholder strings)
  const c = cfg.config || {};
  if (!c.apiKey || c.apiKey.startsWith('YOUR_')) {
    throw new Error(`Database "${cfg.name}" has placeholder credentials. Fill in real Firebase config values.`);
  }
  let app;
  try { app = firebase.app(cfg.name); }
  catch (e) {
    try { app = firebase.initializeApp(cfg.config, cfg.name); }
    catch (e2) { throw new Error(`Firebase initializeApp failed for "${cfg.name}": ${e2.message}`); }
  }
  const fs = firebase.firestore(app);
  fs.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  _instances.set(cfg.name, fs);
  return fs;
}

/* ── Deterministic room → database index ─────────────────────── */
function _hashRoom(code) {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h) ^ code.charCodeAt(i);
  return (h >>> 0) % _ACTIVE_DBS.length;
}

/* ── Fallback order: primary first, then round-robin ─────────── */
function _fallbackOrder(code) {
  if (_ACTIVE_DBS.length === 1) return [0];
  const pri = _hashRoom(code);
  const order = [pri];
  for (let i = 1; i < _ACTIVE_DBS.length; i++) order.push((pri + i) % _ACTIVE_DBS.length);
  return order;
}

/* ── Health helpers ───────────────────────────────────────────── */
function _healthy(name) { return _health.get(name).cooldownUntil <= Date.now(); }

function _onSuccess(name) {
  const h = _health.get(name);
  h.fails = 0; h.cooldownUntil = 0; h.lastErr = null;
}

function _onFail(name, err) {
  const h = _health.get(name);
  h.fails++;
  h.lastErr = err?.message ?? String(err);
  h.cooldownUntil = Date.now() + (_COOLDOWNS[Math.min(h.fails - 1, _COOLDOWNS.length - 1)]);
}

/* ── Core: resolve the best database for a room code ────────── */
async function getDb(roomCode) {
  /* Load remote config first (no-op if already loaded) */
  await _loadConfig();
  /* Guard: no active databases configured */
  if (!_ACTIVE_DBS.length) {
    throw new Error('No Firebase config loaded. Set FIREBASE_API_KEY and related env vars in Cloudflare Pages dashboard.');
  }

  /* Guard: invalid room code passed in */
  if (!roomCode || typeof roomCode !== 'string' || !roomCode.trim()) {
    throw new Error('getDb: roomCode must be a non-empty string.');
  }

  /* Fast path — already resolved and still healthy */
  if (_roomDbCache.has(roomCode)) {
    const name = _roomDbCache.get(roomCode);
    const inst = _instances.get(name);
    if (inst && _healthy(name)) return inst;
    _roomDbCache.delete(roomCode);  // stale — re-probe
  }

  /* Single DB shortcut — no probing needed */
  if (_ACTIVE_DBS.length === 1) {
    const { name, config } = _ACTIVE_DBS[0];
    const fs = _initDb({ name, config });
    _roomDbCache.set(roomCode, name);
    return fs;
  }

  /* Multi-DB: probe each candidate in fallback order */
  const order = _fallbackOrder(roomCode);
  const candidates = [
    ...order.filter(i => _healthy(_ACTIVE_DBS[i].name)),
    ...order.filter(i => !_healthy(_ACTIVE_DBS[i].name))
      .sort((a, b) => _health.get(_ACTIVE_DBS[a].name).cooldownUntil
                    - _health.get(_ACTIVE_DBS[b].name).cooldownUntil),
  ];

  for (const idx of candidates) {
    const cfg = _ACTIVE_DBS[idx];
    const fs  = _initDb(cfg);
    try {
      await Promise.race([
        fs.collection('rooms').doc(roomCode).get(),
        new Promise((_, r) => setTimeout(() => r(new Error('probe timeout')), 8000)),
      ]);
      _onSuccess(cfg.name);
      _roomDbCache.set(roomCode, cfg.name);
      return fs;
    } catch (err) {
      _onFail(cfg.name, err);
    }
  }

  /* All failed — return primary as last resort to avoid blocking UI */
  const fallback = _ACTIVE_DBS[_hashRoom(roomCode) % _ACTIVE_DBS.length];
  try { return _instances.get(fallback.name) ?? _initDb(fallback); }
  catch (err) {
    throw new Error('All databases unavailable. Check your network and Firebase credentials. Last error: ' + err.message);
  }
}

/* ── Status helper for debugging ─────────────────────────────── */
function getDbStatus() {
  return _ACTIVE_DBS.map(({ name }) => {
    const h = _health.get(name);
    return {
      name,
      healthy: _healthy(name),
      fails:   h.fails,
      cooldownRemaining: Math.max(0, Math.ceil((h.cooldownUntil - Date.now()) / 1000)),
      lastError: h.lastErr,
    };
  });
}

/* ── Manual health reset (call from console after outage) ─────── */
function resetDbHealth(name) {
  const targets = name ? [name] : _ACTIVE_DBS.map(d => d.name);
  targets.forEach(n => {
    if (_health.has(n)) _health.set(n, { fails: 0, cooldownUntil: 0, lastErr: null });
  });
  _roomDbCache.clear();
}

/* ── Firebase-ready guard ─────────────────────────────────────────
 * The compat SDK scripts are loaded with defer, guaranteeing they run
 * before db-manager.js and app.js (defer preserves source order).
 * This guard catches the edge case where an external CDN script fails
 * to load (network error, ad-blocker, etc.) and surfaces a clear error
 * instead of a cryptic "firebase is not defined" cascade.
 * window._dbFirebaseReady resolves to true when all instances are warm,
 * or rejects with a descriptive error if Firebase is unavailable.
 * ──────────────────────────────────────────────────────────────── */
// ── _dbFirebaseReady ────────────────────────────────────────────
// CRITICAL FIX: Must await _loadConfig() BEFORE initialising Firebase apps.
// Previous bug: resolved immediately with empty _ACTIVE_DBS → ensureAuth()
// then called firebase.app('miut-db0') before it was ever created → crash.
window._dbFirebaseReady = new Promise((resolve, reject) => {
  async function tryInit() {
    // 1. Firebase SDK must be available
    if (typeof firebase === 'undefined') {
      reject(new Error(
        'Firebase SDK not loaded. Check your connection or disable ad-blockers.'
      ));
      return;
    }

    // 2. Fetch config from Cloudflare (/api/config) — populates _ACTIVE_DBS
    try {
      await _loadConfig();
    } catch (configErr) {
      // _loadConfig() swallows its own errors internally; this is extra safety
      console.warn('[MiutDB] _loadConfig threw:', configErr);
    }

    // 3. Validate we have at least one active database
    if (!_ACTIVE_DBS.length) {
      reject(new Error(
        'No Firebase database configured. ' +
        'Add FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, ' +
        'FIREBASE_MESSAGING_SENDER and FIREBASE_APP_ID in Cloudflare Pages ' +
        'Settings → Environment Variables, then redeploy.'
      ));
      return;
    }

    // 4. Initialise all active Firebase app instances
    let initErr = null;
    _ACTIVE_DBS.forEach(cfg => {
      try { _initDb(cfg); }
      catch (e) { initErr = e; console.warn('[MiutDB] initDb failed for', cfg.name, e.message); }
    });

    // Only reject if the primary db (index 0) failed — others are optional shards
    if (initErr && _ACTIVE_DBS.length === 1) {
      reject(initErr);
      return;
    }

    resolve(true);
  }

  // DOMContentLoaded ensures deferred scripts have run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => tryInit().catch(reject), { once: true });
  } else {
    tryInit().catch(reject);
  }
});

/* ── Explicit window exports ─────────────────────────────────────
 * Assigned explicitly so getDb / getDbStatus / resetDbHealth are
 * accessible globally regardless of build tool output format.
 * Without this, esbuild --platform=browser can scope them to the
 * file, making them invisible to app.js.
 * ────────────────────────────────────────────────────────────── */
window.getDb         = getDb;
window.getDbStatus   = getDbStatus;
window.resetDbHealth = resetDbHealth;

window._dbFirebaseReady.catch(err => {
  // Surface a visible banner so developers immediately see the issue
  const banner = document.createElement('div');
  banner.setAttribute('style',
    'position:fixed;top:0;left:0;right:0;z-index:99999;padding:12px 16px;' +
    'background:#7f1d1d;color:#fecaca;font:13px/1.5 monospace;text-align:center'
  );
  banner.textContent = '⚠ Firebase failed to load — check browser extensions or network. ' + err.message;
  document.body?.appendChild(banner);
});
