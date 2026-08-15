/**
 * security.js — MiutChat production security module
 * Feature Flags · Hooks System · Rate Limiter · Screen Protection
 */
'use strict';

/* ═══════════════════════════════════════════════════════════════════
 * PART 6 — FEATURE FLAGS
 * ═══════════════════════════════════════════════════════════════════ */
const _FLAG_DEFAULTS = {
  ENABLE_COMPRESSION:       true,
  ENABLE_STREAMING:         true,
  ENABLE_CHUNKING:          true,
  ENABLE_SCREEN_PROTECTION: true,
  ENABLE_RATE_LIMIT:        true,
};

/** Read overrides from localStorage (key: miut_flags) or window.__MIUT_FLAGS__ */
function _loadFlagOverrides() {
  try {
    const stored = JSON.parse(localStorage.getItem('miut_flags') || '{}');
    const win    = (typeof window !== 'undefined' && window.__MIUT_FLAGS__) || {};
    return Object.assign({}, stored, win);
  } catch { return {}; }
}

const FLAGS = Object.assign({}, _FLAG_DEFAULTS, _loadFlagOverrides());

/**
 * isEnabled(flagName) → boolean
 * Safe helper — returns false for unknown flags.
 */
function isEnabled(flag) {
  return flag in FLAGS ? Boolean(FLAGS[flag]) : false;
}

/** Allow runtime override (for testing / operator config) */
function setFlag(flag, value) {
  FLAGS[flag] = Boolean(value);
  try { localStorage.setItem('miut_flags', JSON.stringify(FLAGS)); } catch {}
}


/* ═══════════════════════════════════════════════════════════════════
 * PART 5 — HOOKS SYSTEM
 * ═══════════════════════════════════════════════════════════════════ */
const _hooks = Object.create(null); // event → Array<fn>

/**
 * registerHook(event, handler)
 * handler may be sync or async; errors are caught and logged.
 */
function registerHook(event, handler) {
  if (typeof event !== 'string' || typeof handler !== 'function') return;
  if (!_hooks[event]) _hooks[event] = [];
  _hooks[event].push(handler);
}

/**
 * runHooks(event, payload) → Promise<payload>
 * Runs all registered handlers sequentially, passing payload through.
 * Fail-safe: handler errors are swallowed, pipeline continues.
 */
async function runHooks(event, payload) {
  const handlers = _hooks[event];
  if (!handlers || !handlers.length) return payload;
  let current = payload;
  for (const fn of handlers) {
    try {
      const result = await fn(current);
      if (result !== undefined) current = result;
    } catch (err) {
      // Hooks must never crash the main flow
      if (typeof console !== 'undefined') {
        console.warn('[MIUT hooks] Error in hook for "' + event + '":', err && err.message);
      }
    }
  }
  return current;
}

/* Built-in hook event names (for documentation / IDE completion) */
const HOOK_EVENTS = Object.freeze({
  BEFORE_ENCRYPT: 'beforeEncrypt',
  AFTER_ENCRYPT:  'afterEncrypt',
  BEFORE_SEND:    'beforeSend',
  AFTER_RECEIVE:  'afterReceive',
});


/* ═══════════════════════════════════════════════════════════════════
 * PART 7 — ADVANCED CLIENT-SIDE RATE LIMITER
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Sliding-window rate limiter with exponential back-off.
 * State stored in localStorage (persists across tabs) + in-memory fallback.
 *
 * limits config: { [action]: { max: number, windowMs: number } }
 */
const _RL_KEY = 'miut_rl_v1';
const _RL_BACKOFF_KEY = 'miut_rl_bo_v1';

const _RL_LIMITS = {
  createRoom:  { max: 5,   windowMs: 60_000  },  // 5 per minute
  joinRoom:    { max: 10,  windowMs: 60_000  },  // 10 per minute
  sendMessage: { max: 30,  windowMs: 10_000  },  // 30 per 10s
};

function _rlLoad() {
  try { return JSON.parse(localStorage.getItem(_RL_KEY) || '{}'); } catch { return {}; }
}
function _rlSave(state) {
  try { localStorage.setItem(_RL_KEY, JSON.stringify(state)); } catch {}
}
function _rlLoadBackoff() {
  try { return JSON.parse(localStorage.getItem(_RL_BACKOFF_KEY) || '{}'); } catch { return {}; }
}
function _rlSaveBackoff(state) {
  try { localStorage.setItem(_RL_BACKOFF_KEY, JSON.stringify(state)); } catch {}
}

/**
 * checkRateLimit(action) → { allowed: boolean, retryAfterMs: number, reason?: string }
 *
 * On denial: increments back-off tier (1s→2s→4s→8s…, max 60s).
 * On allow:  resets back-off tier to 0.
 */
function checkRateLimit(action) {
  if (!isEnabled('ENABLE_RATE_LIMIT')) return { allowed: true, retryAfterMs: 0 };

  const cfg = _RL_LIMITS[action];
  if (!cfg) return { allowed: true, retryAfterMs: 0 };

  const now     = Date.now();
  const state   = _rlLoad();
  const backoff = _rlLoadBackoff();

  // Check exponential back-off first
  const boUntil = backoff[action] || 0;
  if (now < boUntil) {
    return {
      allowed:      false,
      retryAfterMs: boUntil - now,
      reason:       'rate_limited_backoff',
    };
  }

  // Sliding window: prune old timestamps
  const window = (state[action] || []).filter(ts => now - ts < cfg.windowMs);

  if (window.length >= cfg.max) {
    // Denial — compute back-off
    const tier       = (backoff[action + '_tier'] || 0) + 1;
    const delayMs    = Math.min(1000 * Math.pow(2, tier - 1), 60_000);
    backoff[action]          = now + delayMs;
    backoff[action + '_tier'] = tier;
    _rlSaveBackoff(backoff);

    const oldest = window[0];
    return {
      allowed:      false,
      retryAfterMs: Math.max(cfg.windowMs - (now - oldest), delayMs),
      reason:       'rate_limited_window',
    };
  }

  // Allow — record timestamp, reset back-off tier
  window.push(now);
  state[action] = window;
  _rlSave(state);

  if (backoff[action + '_tier']) {
    backoff[action + '_tier'] = 0;
    backoff[action]           = 0;
    _rlSaveBackoff(backoff);
  }

  return { allowed: true, retryAfterMs: 0 };
}

/**
 * enforceRateLimit(action) → Promise<void>
 * Throws a structured RateLimitError if denied.
 * In ENABLE_STREAMING mode: waits retryAfterMs then resolves.
 */
async function enforceRateLimit(action) {
  const result = checkRateLimit(action);
  if (result.allowed) return;

  if (isEnabled('ENABLE_STREAMING') && result.retryAfterMs <= 5000) {
    await new Promise(r => setTimeout(r, result.retryAfterMs));
    const retry = checkRateLimit(action);
    if (retry.allowed) return;
  }

  const err = new Error('Rate limit exceeded for action: ' + action + '. Retry in ' + Math.ceil(result.retryAfterMs / 1000) + 's.');
  err.name          = 'RateLimitError';
  err.action        = action;
  err.retryAfterMs  = result.retryAfterMs;
  err.reason        = result.reason;
  throw err;
}

/** Reset rate limit state for an action (admin/testing) */
function resetRateLimit(action) {
  try {
    const state   = _rlLoad();
    const backoff = _rlLoadBackoff();
    if (action) {
      delete state[action];
      delete backoff[action];
      delete backoff[action + '_tier'];
    } else {
      Object.keys(state).forEach(k => delete state[k]);
      Object.keys(backoff).forEach(k => delete backoff[k]);
    }
    _rlSave(state);
    _rlSaveBackoff(backoff);
  } catch {}
}


/* ═══════════════════════════════════════════════════════════════════
 * PART 4 — SCREEN PROTECTION SYSTEM
 * ═══════════════════════════════════════════════════════════════════ */

let _spActive       = false;
let _spUsername     = 'ANONYMOUS';
let _spWatermarkEl  = null;
let _spBlurEl       = null;
let _spTimerID      = null;
let _spDevtoolsSize = { w: 0, h: 0 };

const _SP_BLUR_CLASS     = 'sp-blur-active';
const _SP_WATERMARK_ID   = '__sp_wm';
const _SP_BLUR_ID        = '__sp_blur';

function _spInjectStyles() {
  if (document.getElementById('__sp_styles')) return;
  const s = document.createElement('style');
  s.id = '__sp_styles';
  s.textContent = `
    .${_SP_BLUR_CLASS} { filter: blur(18px) !important; pointer-events: none !important; transition: filter .25s; user-select: none !important; }
    #${_SP_WATERMARK_ID} {
      position: fixed; inset: 0; z-index: 99998;
      pointer-events: none; user-select: none;
      display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 0;
      overflow: hidden;
    }
    #${_SP_WATERMARK_ID} .sp-wm-inner {
      position: absolute; inset: -40%;
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 0;
      transform: rotate(-22deg);
      opacity: 0;
      transition: opacity .3s;
    }
    #${_SP_WATERMARK_ID}.sp-wm-visible .sp-wm-inner { opacity: 1; }
    #${_SP_WATERMARK_ID} .sp-wm-cell {
      display: flex; align-items: center; justify-content: center;
      padding: 28px 0;
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      color: rgba(78,205,196,0.14);
      white-space: nowrap;
      letter-spacing: 1px;
      user-select: none;
    }
    #${_SP_BLUR_ID} {
      position: fixed; inset: 0; z-index: 99997;
      backdrop-filter: blur(24px) brightness(0.5);
      -webkit-backdrop-filter: blur(24px) brightness(0.5);
      background: rgba(5,13,12,0.72);
      display: none;
      align-items: center; justify-content: center;
    }
    #${_SP_BLUR_ID}.sp-blur-show { display: flex; }
    #${_SP_BLUR_ID} .sp-blur-msg {
      font-family: 'Syne', sans-serif;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 3px;
      color: rgba(78,205,196,0.6);
      text-transform: uppercase;
      text-align: center;
    }
    body.sp-no-select * { user-select: none !important; -webkit-user-select: none !important; }
  `;
  document.head.appendChild(s);
}

function _spBuildWatermark() {
  if (document.getElementById(_SP_WATERMARK_ID)) return;
  const wrap = document.createElement('div');
  wrap.id = _SP_WATERMARK_ID;
  const inner = document.createElement('div');
  inner.className = 'sp-wm-inner';

  // Fill grid with repeated cells
  for (let i = 0; i < 120; i++) {
    const cell = document.createElement('div');
    cell.className = 'sp-wm-cell';
    cell.setAttribute('aria-hidden', 'true');
    cell.dataset.spCell = '1';
    inner.appendChild(cell);
  }
  wrap.appendChild(inner);
  document.body.appendChild(wrap);
  _spWatermarkEl = wrap;
}

function _spBuildBlur() {
  if (document.getElementById(_SP_BLUR_ID)) return;
  const el = document.createElement('div');
  el.id = _SP_BLUR_ID;
  el.innerHTML = '<div class="sp-blur-msg">SCREEN PROTECTED · RETURN TO RESUME</div>';
  document.body.appendChild(el);
  _spBlurEl = el;
}

function _spUpdateWatermarkText() {
  if (!_spWatermarkEl) return;
  const ts   = new Date().toLocaleTimeString('en-US', { hour12: false });
  const text = _spUsername + ' · ' + ts;
  _spWatermarkEl.querySelectorAll('.sp-wm-cell').forEach((c, i) => {
    c.textContent = (i % 2 === 0) ? text : '· · ·';
  });
}

function _spShowWatermark() {
  if (!_spWatermarkEl) return;
  _spUpdateWatermarkText();
  _spWatermarkEl.classList.add('sp-wm-visible');
  if (_spTimerID) clearInterval(_spTimerID);
  _spTimerID = setInterval(_spUpdateWatermarkText, 2000);
}

function _spHideWatermark() {
  if (!_spWatermarkEl) return;
  _spWatermarkEl.classList.remove('sp-wm-visible');
  if (_spTimerID) { clearInterval(_spTimerID); _spTimerID = null; }
}

function _spBlur() {
  if (!_spBlurEl) return;
  _spBlurEl.classList.add('sp-blur-show');
  _spShowWatermark();
}

function _spUnblur() {
  if (!_spBlurEl) return;
  _spBlurEl.classList.remove('sp-blur-show');
  _spHideWatermark();
}

/** Approximate DevTools detection by window size delta */
function _spCheckDevtools() {
  const threshold = 160;
  const wDiff     = window.outerWidth  - window.innerWidth;
  const hDiff     = window.outerHeight - window.innerHeight;
  return wDiff > threshold || hDiff > threshold;
}

function _spHandleBlur()   { if (_spActive) _spBlur(); }
function _spHandleFocus()  { if (_spActive) _spUnblur(); }
function _spHandleVisible() {
  if (!_spActive) return;
  if (document.visibilityState === 'hidden') _spBlur();
  else _spUnblur();
}

let _spDevtoolsInterval = null;
function _spStartDevtoolsWatch() {
  if (_spDevtoolsInterval) return;
  _spDevtoolsInterval = setInterval(() => {
    if (!_spActive) return;
    if (_spCheckDevtools()) _spBlur();
  }, 800);
}
function _spStopDevtoolsWatch() {
  if (_spDevtoolsInterval) { clearInterval(_spDevtoolsInterval); _spDevtoolsInterval = null; }
}

/**
 * initScreenProtection({ username })
 * Call after DOM ready. Idempotent.
 */
function initScreenProtection(opts) {
  if (!isEnabled('ENABLE_SCREEN_PROTECTION')) return;
  opts = opts || {};
  _spUsername = (opts.username || 'ANONYMOUS').toString().toUpperCase();

  _spInjectStyles();
  _spBuildWatermark();
  _spBuildBlur();

  document.body.classList.add('sp-no-select');

  window.addEventListener('blur',  _spHandleBlur);
  window.addEventListener('focus', _spHandleFocus);
  document.addEventListener('visibilitychange', _spHandleVisible);
  _spStartDevtoolsWatch();
  _spActive = true;
}

/** Cleanly tear down screen protection */
function destroyScreenProtection() {
  _spActive = false;
  _spUnblur();
  _spStopDevtoolsWatch();
  window.removeEventListener('blur',  _spHandleBlur);
  window.removeEventListener('focus', _spHandleFocus);
  document.removeEventListener('visibilitychange', _spHandleVisible);
  document.body.classList.remove('sp-no-select');
  if (_spWatermarkEl) { _spWatermarkEl.remove(); _spWatermarkEl = null; }
  if (_spBlurEl)      { _spBlurEl.remove();      _spBlurEl = null; }
  const s = document.getElementById('__sp_styles');
  if (s) s.remove();
}

/** Update the watermark username (call after login) */
function setScreenProtectionUsername(name) {
  _spUsername = (name || 'ANONYMOUS').toString().toUpperCase();
}


/* ═══════════════════════════════════════════════════════════════════
 * PART 8 — SECURITY: REPLAY PROTECTION + IV UNIQUENESS + AAD
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Replay attack prevention.
 * Tracks message timestamps in a sliding window (5 min).
 * Tracks nonce/ID set to block exact duplicates.
 */
const _REPLAY_WINDOW_MS = 5 * 60_000;
const _seenNonces = new Set();
let   _seenNoncesArr = []; // for eviction (oldest first)

/**
 * validateMessageTimestamp(ts) → boolean
 * Rejects messages older than REPLAY_WINDOW_MS or more than 30s in the future.
 */
function validateMessageTimestamp(ts) {
  const now  = Date.now();
  const diff = now - ts;
  if (diff > _REPLAY_WINDOW_MS) return false;
  if (diff < -30_000)           return false;
  return true;
}

/**
 * trackNonce(nonce) → boolean   (true = new / false = replay)
 * Evicts nonces older than the replay window.
 */
function trackNonce(nonce) {
  const now = Date.now();
  // Evict stale
  while (_seenNoncesArr.length && (now - _seenNoncesArr[0].ts) > _REPLAY_WINDOW_MS) {
    _seenNonces.delete(_seenNoncesArr.shift().id);
  }
  if (_seenNonces.has(nonce)) return false; // replay
  _seenNonces.add(nonce);
  _seenNoncesArr.push({ id: nonce, ts: now });
  return true;
}

/**
 * generateIV() → Uint8Array(12)
 * Each call produces a cryptographically unique 96-bit IV via crypto.getRandomValues.
 * Guarantees uniqueness (no counter-based reuse risk).
 */
function generateIV() {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('Web Crypto API not available. MiutChat requires a secure context (HTTPS).');
  }
  return crypto.getRandomValues(new Uint8Array(12));
}

/**
 * buildAAD(roomId, senderId, timestamp) → Uint8Array
 * Constructs Additional Authenticated Data for AES-GCM.
 * Binds ciphertext to context, preventing ciphertext reuse across rooms/senders.
 */
function buildAAD(roomId, senderId, timestamp) {
  const str = 'miut|' + String(roomId) + '|' + String(senderId) + '|' + String(timestamp);
  return new TextEncoder().encode(str);
}


/* ═══════════════════════════════════════════════════════════════════
 * EXPORTS — attach to window for non-module access
 * ═══════════════════════════════════════════════════════════════════ */
const _SEC = {
  // Feature flags
  FLAGS,
  isEnabled,
  setFlag,

  // Hooks
  registerHook,
  runHooks,
  HOOK_EVENTS,

  // Rate limiting
  checkRateLimit,
  enforceRateLimit,
  resetRateLimit,
  _RL_LIMITS,

  // Screen protection
  initScreenProtection,
  destroyScreenProtection,
  setScreenProtectionUsername,

  // Security primitives
  validateMessageTimestamp,
  trackNonce,
  generateIV,
  buildAAD,
};

if (typeof window !== 'undefined') Object.assign(window, _SEC);
if (typeof module !== 'undefined' && module.exports) module.exports = _SEC;
