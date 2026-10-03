'use strict';

/**
 * Miut — db-manager.js
 * ═══════════════════════════════════════════════════════════════
 * Multi-database (shard) manager, sized to N shards with zero code
 * changes: adding FIREBASE_DBn_* env vars in the Cloudflare Pages
 * dashboard (see config.js) makes shard N appear here automatically.
 *
 * Room → shard resolution, in priority order:
 *   1. In-memory cache for this tab (instant, no network).
 *   2. Server-side authoritative registry (shard-registry.js, backed by a
 *      dedicated Firestore project) — the source of truth every member's
 *      browser and every device agrees on. New rooms are placed on
 *      whichever active shard has the least load and isn't flagged
 *      degraded.
 *   3. This browser's own localStorage binding — used only if the
 *      registry is unreachable, so a registry outage degrades to "this
 *      browser remembers where it left off" rather than breaking access.
 *   4. Deterministic hash across active shards — last resort for a room
 *      neither the registry nor localStorage has ever seen.
 *
 * Quota handling: if a shard returns a Firestore quota-exhaustion error
 * (resource-exhausted), that shard is reported to the registry as
 * degraded so it stops being handed NEW rooms. There is deliberately NO
 * migration of already-placed rooms in this build — an earlier version
 * tried that via a server-side copy (migrate-room.js) but it needed a
 * service account per shard and was more moving parts than this app
 * wants to maintain. A room that lands on a shard which later runs out
 * of quota stays there until Firestore's own daily reset; the sharding
 * this file does is purely about spreading NEW rooms across shards so
 * any one of them is less likely to hit that limit in the first place.
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

/* Per-room database resolution cache (session lifetime, in-memory) */
const _roomDbCache = new Map();

/* ── Persistent room → database binding ───────────────────────────
 * Critical correctness fix: _hashRoom(code) % _ACTIVE_DBS.length means
 * the moment a NEW shard is added, _ACTIVE_DBS.length changes, and the
 * hash result shifts for the MAJORITY of already-existing room codes —
 * confirmed directly: with 1 active DB every code hashes to index 0
 * trivially, but adding a 2nd DB flips roughly half of all existing rooms
 * to index 1 (an empty, brand-new database). Combined with getDb's probe
 * treating "document doesn't exist" as a successful health check (it
 * doesn't throw, so _onSuccess fires and that database gets cached), an
 * active room could get silently rerouted to a database with none of its
 * data the instant a new shard is introduced — indistinguishable from the
 * room having been deleted.
 *
 * Fix: once a room is resolved to a database, that binding is persisted
 * to localStorage and always takes priority over a fresh hash
 * computation, for the life of the browser's storage (which comfortably
 * outlives any room — rooms expire in hours at most, this persists across
 * reloads indefinitely). New room codes (never seen before) still get
 * distributed across all currently active databases via the hash, same
 * as before — this only stabilizes ALREADY-BOUND rooms against future
 * shard additions. */
const _PERSIST_KEY   = 'miut_db_bindings';
const _PERSIST_LIMIT = 500; // oldest evicted first — comfortably more than any real session will bind

function _loadPersistedBindings() {
  try { return JSON.parse(localStorage.getItem(_PERSIST_KEY)) || {}; }
  catch { return {}; }
}
function _getPersistedBinding(code) {
  return _loadPersistedBindings()[code] || null;
}
function _setPersistedBinding(code, dbName) {
  try {
    const map = _loadPersistedBindings();
    map[code] = { db: dbName, at: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > _PERSIST_LIMIT) {
      keys.sort((a, b) => map[a].at - map[b].at)
          .slice(0, keys.length - _PERSIST_LIMIT)
          .forEach(k => delete map[k]);
    }
    localStorage.setItem(_PERSIST_KEY, JSON.stringify(map));
  } catch { /* localStorage full/unavailable — falls back to hash-only routing, not fatal */ }
}

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

/* ── Server-side authoritative shard registry (shard-registry.js) ─────────
 * Everything above (hash + localStorage) stabilizes a room against shard
 * additions/removals FOR ONE BROWSER. It can't tell a second member's
 * browser, or the same person on a different device, that a room moved —
 * only a server-side record can do that. This is that record.
 *
 * getDb() tries the registry FIRST (small network round trip, cheap KV
 * read) and only falls back to localStorage/hash if the registry is
 * unreachable — correctness across devices/members matters more here than
 * shaving off a network round trip, especially right after a migration.
 * ────────────────────────────────────────────────────────────────────── */
async function _registryCall(body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 2500);
  try {
    const res = await fetch('/api/shard-registry', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('shard-registry HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const _expiredRooms = new Set();

async function _resolveViaRegistry(roomCode) {
  const data = await _registryCall({ action: 'resolve', roomCode });
  if (!data || !data.db) throw new Error('shard-registry returned no db');
  if (data.expired) _expiredRooms.add(roomCode); else _expiredRooms.delete(roomCode);
  return data; // { db, isNew, expired? }
}

window.isRoomExpired = function (roomCode) {
  return _expiredRooms.has(roomCode);
};

window.markRoomExpired = function (roomCode, dbName) {
  const name = dbName || _roomDbCache.get(roomCode);
  if (!roomCode || !name) return;
  _registryCall({ action: 'expire', roomCode, db: name }, 6000)
    .then(r => { if (r && r.ok) _expiredRooms.add(roomCode); })
    .catch(() => {});
};

async function _bindRegistry(roomCode, dbName, attempt) {
  // Fire-and-forget from the caller's perspective, but retried internally —
  // this write is what keeps the room findable by every OTHER device, so
  // it's worth a modest retry budget rather than giving up on the first
  // transient failure. A room that only this browser's localStorage knows
  // about is a room a second member can't join.
  attempt = attempt || 0;
  try {
    await _registryCall({ action: 'bind', roomCode, db: dbName }, 4000);
  } catch {
    if (attempt < 2) {
      setTimeout(() => _bindRegistry(roomCode, dbName, attempt + 1), 1000 * (attempt + 1));
    }
  }
}

/** Call this ONCE, right after a room's document has actually been
 * successfully written to Firestore — NOT at getDb()/resolve time, which
 * only picks a shard and does not know whether creation will succeed.
 * This is what the registry's placement actually counts as load; a room
 * that was assigned a shard but never actually got created there (rules
 * denial, network drop, user backing out) must not count against it, or
 * a burst of failed attempts permanently — not just for the day —
 * biases placement away from a shard nothing was ever created on. */
function _confirmRoomCreated(roomCode, dbName) {
  _expiredRooms.delete(roomCode);
  _registryCall({ action: 'confirm', roomCode, db: dbName }, 4000).catch(() => {});
}
window.confirmRoomCreated = _confirmRoomCreated;

const _reportedDegraded = new Set(); // per-tab de-dupe, avoids hammering the registry
function _reportShardDegraded(dbName) {
  if (_reportedDegraded.has(dbName)) return;
  _reportedDegraded.add(dbName);
  setTimeout(() => _reportedDegraded.delete(dbName), 10 * 60 * 1000); // re-report after 10 min if still broken
  _registryCall({ action: 'report-error', db: dbName }, 4000).catch(() => {});
}

/* ── Quota-error detection ──────────────────────────────────────────────
 * Firestore's client SDK surfaces a hard daily-quota rejection as
 * err.code === 'resource-exhausted' (sometimes 'permission-denied' if App
 * Check/rules reject first, but that's not quota-specific so it's
 * deliberately excluded here). */
function _isQuotaError(err) {
  return !!err && (err.code === 'resource-exhausted' || /RESOURCE_EXHAUSTED/i.test(err.message || ''));
}

/**
 * Called the moment ANY Firestore operation for a room fails with a
 * quota-shaped error — from getDb's own probe below, or from app.js's
 * real read/write call sites via window.reportDbError().
 *
 * NOTE: this used to also trigger a server-side migration of the room's
 * data to a healthy shard (migrate-room.js). That's been removed —
 * migration required a service account per project and turned out to be
 * more moving parts than this app wants to maintain. What's left is pure
 * load-based SHARDING: new rooms are placed across shards by
 * shard-registry.js's own load/degraded-aware picker, so any one shard
 * is less likely to hit its quota in the first place. But once a room IS
 * placed, it stays on that shard for its lifetime — if that shard's
 * quota runs out, the room is stuck until Firestore's own daily reset;
 * nothing here moves it. All this function does now is mark the shard
 * degraded in the registry so it stops being handed NEW rooms — it never
 * reroutes the room that just failed.
 */
function _handleQuotaError(roomCode, dbName, err) {
  if (!_isQuotaError(err)) return;
  _onFail(dbName, err);
  _reportShardDegraded(dbName);
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

  /* Fast path — already resolved this session and still healthy */
  if (_roomDbCache.has(roomCode)) {
    const name = _roomDbCache.get(roomCode);
    const inst = _instances.get(name);
    if (inst && _healthy(name)) return inst;
    _roomDbCache.delete(roomCode);  // stale — re-probe
  }

  /* Authoritative source of truth: the server-side shard registry. This is
   * what lets adding shard N+1 in the Cloudflare dashboard start taking
   * NEW rooms immediately (load-aware placement lives server-side), and
   * what lets every member's browser — not just whoever triggered it —
   * learn about a migration. Falls through to localStorage/hash below if
   * the registry is unreachable (KV outage, offline, etc.) rather than
   * blocking room access on it. */
  try {
    const { db: regName } = await _resolveViaRegistry(roomCode);
    if (regName && _ACTIVE_DBS.some(d => d.name === regName) && _healthy(regName)) {
      const cfg = _ACTIVE_DBS.find(d => d.name === regName);
      const fs = _initDb(cfg);
      _roomDbCache.set(roomCode, cfg.name);
      _setPersistedBinding(roomCode, cfg.name);
      return fs;
    }
  } catch { /* registry unreachable — fall through */ }

  /* Persisted binding from a previous session takes priority over any
   * fresh hash computation — see _getPersistedBinding's comment for why.
   * Only used if that database is still in the active pool (it could in
   * principle have been retired) and currently healthy. */
  const persisted = _getPersistedBinding(roomCode);
  if (persisted && _ACTIVE_DBS.some(d => d.name === persisted.db)) {
    const cfg = _ACTIVE_DBS.find(d => d.name === persisted.db);
    if (_healthy(cfg.name)) {
      try {
        const fs = _initDb(cfg);
        _roomDbCache.set(roomCode, cfg.name);
        return fs;
      } catch { /* fall through to normal resolution below */ }
    }
  }

  /* Single DB shortcut — no probing needed */
  if (_ACTIVE_DBS.length === 1) {
    const { name, config } = _ACTIVE_DBS[0];
    const fs = _initDb({ name, config });
    _roomDbCache.set(roomCode, name);
    _setPersistedBinding(roomCode, name);
    _bindRegistry(roomCode, name);
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
      _setPersistedBinding(roomCode, cfg.name);
      _bindRegistry(roomCode, cfg.name);
      return fs;
    } catch (err) {
      _onFail(cfg.name, err);
      if (_isQuotaError(err)) _handleQuotaError(roomCode, cfg.name, err);
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
/**
 * Call this from any Firestore write/read catch handler in app.js when an
 * operation fails, e.g.:
 *   .catch(err => window.reportDbError(state.roomCode, <shard name>, err))
 * If `err` is quota-shaped, this marks the shard degraded in the registry
 * so it stops being handed NEW rooms — it does NOT move the room that
 * just failed (no migration in this build; see _handleQuotaError's
 * comment). Non-quota errors are a no-op. Always returns undefined —
 * callers should not expect a rerouted Firestore instance back.
 */
window.reportDbError = function (roomCode, dbName, err) {
  _handleQuotaError(roomCode, dbName, err);
};
/** Which shard is roomCode currently resolved to, for error-reporting call sites. */
window.getCurrentDbName = function (roomCode) {
  return _roomDbCache.get(roomCode) || null;
};
/**
 * True if `err` is Firestore's daily-quota-exhaustion error specifically
 * (not a permissions error, not a network error). Use this to show the
 * user an accurate "this room is temporarily overloaded" message instead
 * of a generic/raw error string — see app.js's use of this alongside
 * reportDbError.
 */
window.isQuotaError = function (err) {
  return _isQuotaError(err);
};

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
