
'use strict';
// @ts-check
(function (_W) {
// script internals are now encapsulated — only window.X exports below are public.

/* ── Global error telemetry ─────────────────────────────────────────────────
 * Catches all uncaught JS errors and unhandled promise rejections.
 * Reports to /api/csp-report (reuses the existing CF Function endpoint)
 * with a distinct type so server logs can split CSP vs JS errors.
 * Rate-limited to 5 reports per session to avoid flooding on bad states.
 * ───────────────────────────────────────────────────────────────────────── */
(function _installGlobalErrorHandlers() {
  let _errReportCount = 0;
  const _ERR_REPORT_LIMIT = 5;

  function _reportError(detail) {
    if (_errReportCount >= _ERR_REPORT_LIMIT) return;
    _errReportCount++;
    try {
      navigator.sendBeacon('/api/csp-report', JSON.stringify({
        type:      'js-error',
        message:   String(detail.message  || '').slice(0, 300),
        source:    String(detail.source   || '').slice(0, 200),
        lineno:    detail.lineno   || 0,
        colno:     detail.colno    || 0,
        stack:     String(detail.stack    || '').slice(0, 500),
        userAgent: navigator.userAgent.slice(0, 200),
        href:      location.pathname,
        ts:        Date.now(),
      }));
    } catch { /* sendBeacon may fail in some environments — never throw from error handler */ }
  }

  window.onerror = function (message, source, lineno, colno, error) {
    console.error('[MIUT] Uncaught error:', message, { source, lineno, colno, error });
    _reportError({ message, source, lineno, colno, stack: error?.stack });
    return false; // let browser default handling proceed
  };

  window.addEventListener('unhandledrejection', function (ev) {
    const reason = ev.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('[MIUT] Unhandled rejection:', message, reason);
    _reportError({
      message: 'UnhandledRejection: ' + message,
      stack:   reason instanceof Error ? reason.stack : '',
    });
  });
})();

// DevTools. Full mitigation requires ES module migration (type="module") which
// is a larger refactor outside this patch pass. The Firestore Security Rules
// (firestore.rules) provide the authoritative server-side enforcement regardless.

// Firebase configuration lives entirely in db-manager.js → _DB_CONFIGS[0].
// db-manager.js initialises all Firebase apps before app.js runs.
// app.js references apps by name ('miut-db0') — never calls initializeApp itself.
//
// NOTE on Anonymous Auth: the compat SDK is loaded via <script> tags, so use:
//   firebase.auth(app).signInAnonymously()   ← correct for this project
// NOT the ES module import style:
//   import { getAuth, signInAnonymously } from "firebase/auth"  ← wrong (needs bundler)

// Room codes are used as Firestore document IDs. Without an allowlist, special
// characters like / cause path-traversal, and . / .. cause SDK errors.
// Applied at every entry point (handleCreate, handleEnter, joinFromInvite).
const _ROOM_CODE_RE = /^[a-zA-Z0-9 _\-@#!?+*=.]{6,64}$/;
const APP_VERSION = '1.0.0';

function validateRoomCode(code) {
  if (!code || typeof code !== 'string') {
    showError('Please enter a room code'); return false;
  }
  // Reject codes with zero-width or homoglyph-prone chars
  const cleaned = code.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
  if (cleaned !== code) { showError('Room code contains invalid characters'); return false; }
  if (!_ROOM_CODE_RE.test(code)) {
    showError('Room code contains invalid characters. Use letters, numbers, spaces, or _ - @ # ! ? + * = .'); return false;
  }
  if (code === '.' || code === '..') {
    showError('Invalid room code'); return false;
  }
  return true;
}

const CONFIG = {
  SESSION_KEY:        'miut_session_v2',
  ROOM_KEY:           'miut_room_v1',
  PREFS_KEY:          'miut_prefs_v1',
  TYPING_WRITE_MS:    2000,
  TYPING_EXPIRE_MS:   5000,
  TYPING_IDLE_MS:     3000,
  HEARTBEAT_MS:       20000,
  MAX_FILE_BYTES:     25 * 1024 * 1024,


  CHUNK_BYTES:        600 * 1024,  // 600KB raw → ~800KB base64 + metadata < Firestore 1MB limit
  IDB_NAME:           'miut-v1',
  IDB_VER:            2,
  EDIT_WINDOW_MS:     2 * 60 * 1000,
};
let _authReady = null;

// Anonymous Auth uses the Firebase compat SDK (script-tag loaded).
// Compat syntax: firebase.auth(app).signInAnonymously()
// NOT the ES module syntax (import { getAuth } from "firebase/auth") — that needs a bundler.
async function ensureAuth() {
  if (_authReady) return _authReady;
  _authReady = (async () => {
    if (window._dbFirebaseReady) {
      try { await window._dbFirebaseReady; }
      catch (e) { _authReady = null; throw e; }
    } else {
      await Promise.resolve();
      if (typeof firebase === 'undefined') {
        throw new Error('Firebase SDK unavailable — check your connection or ad blocker.');
      }
    }
    // Retry up to 3 times with exponential backoff for network failures
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 900 * Math.pow(2, attempt - 1)));
      try {
        const uid = await new Promise((resolve, reject) => {
          try {
            // Use the first active DB's app — supports dynamic config from /api/config
        const _firstDbName = (window.__MIUT_DB_CONFIGS__ || []).find(d => d.active)?.name || 'miut-db0';
        const authApp  = firebase.app(_firstDbName);
        const authInst = firebase.auth(authApp);
            const unsub = authInst.onAuthStateChanged(user => {
              unsub();
              if (user) { resolve(user.uid); return; }
              authInst.signInAnonymously()
                .then(cred => resolve(cred.user.uid))
                .catch(reject);
            }, reject);
          } catch (err) { reject(err); }
        });
        return uid;
      } catch (err) {
        lastErr = err;
        const code = err?.code || '';
        // Only retry transient network errors, not config errors
        if (code.startsWith('auth/') && !code.includes('network') && !code.includes('too-many-requests')) break;
      }
    }
    _authReady = null;
    throw lastErr;
  })().catch(err => { _authReady = null; throw err; });
  return _authReady;
}

let state = {
  me:         null,
  roomCode:   null,
  prefs: {
    sound:            true,
    animations:       true,
    approvalRequired: false,
  },
};

let db             = null;
let _unsubMsgs     = null;
let _unsubMembers  = null;
let _unsubTyping   = null;
let _heartbeat     = null;
let _typingTimer   = null;
let _lastTypeWrite = 0;
let _isTyping      = false;
let _sidebarOpen   = false;
let _renderedIds   = new Set();
let _lastCachedTs  = 0;
let _idb           = null;
let _onlineCount   = 0;
let _sigPrivKey    = null;
let _pubKeyB64     = null;

// ─── Advanced security & feature state ───────────────────────────────────────
let _seenDocIds        = new Set();   // canary: detect Firestore injection replay
let _integrityViolations = 0;         // count of failed signature verifications
let _sessionHmacKey    = null;        // per-session HMAC key for local integrity
let _lastEpochRotate   = 0;           // timestamp of last epoch rotation
let _readReceiptTimer  = null;        // debounce handle for bulk read-receipt writes
let _pendingReadAcks   = new Set();   // docIds queued to be marked as read
let _expiryTimer       = null;        // setInterval handle for message expiry sweep
// ─────────────────────────────────────────────────────────────────────────────

function _lruMap(maxSize) {
  const m = new Map();
  return {
    has: k => m.has(k),
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k); m.delete(k); m.set(k, v); return v;
    },
    set(k, v) {
      if (m.has(k)) m.delete(k);
      else if (m.size >= maxSize) m.delete(m.keys().next().value);
      m.set(k, v);
    },
  };
}

const _pubKeyCache = _lruMap(200); // LRU-capped; was unbounded Map
let _unsubApproval   = null;
let _isAdmin         = false;
let _presenceSettled = false;
let _roomWasEmpty    = false; // tracks whether the room-expiry countdown is currently pending (see startPresenceListener)

// ── Vault auth token (set when passkey matched, cleared on exit) ──
let _vaultToken = null;

// ── Multi-select state ────────────────────────────────────────────
let _selectMode    = false;
const _selectedIds = new Set(); // docId set


let _unreadCount     = 0;

function openIDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((res, rej) => {
    const req = indexedDB.open(CONFIG.IDB_NAME, CONFIG.IDB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('msgs')) {
        const s = d.createObjectStore('msgs', { keyPath: 'id' });
        s.createIndex('room_ts', ['room', 'ts']);
      }
      if (!d.objectStoreNames.contains('meta'))
        d.createObjectStore('meta', { keyPath: 'k' });
      if (!d.objectStoreNames.contains('blobs'))
        d.createObjectStore('blobs', { keyPath: 'id' });

      if (!d.objectStoreNames.contains('sigkey'))
        d.createObjectStore('sigkey', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('pubkeys'))
        d.createObjectStore('pubkeys', { keyPath: 'uid' });
    };
    req.onsuccess = e => { _idb = e.target.result; res(_idb); };
    req.onerror   = e => rej(e.target.error);
  });
}
async function idbTx(stores, mode, fn) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(stores, mode);
    let _result;
    tx.oncomplete = () => res(_result);
    tx.onerror    = e => rej(e.target.error);
    tx.onabort    = e => rej(e.target.error || new Error('IDB transaction aborted'));
    fn(tx, v => { _result = v; }, rej);
  });
}

async function idbPut(store, val) {
  return idbTx(store, 'readwrite', (tx, res) => {
    const req = tx.objectStore(store).put(val);
    req.onsuccess = () => res(req.result);
  });
}

async function idbGetAll(store) {
  return idbTx(store, 'readonly', (tx, res) => {
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
  });
}

async function idbGetMeta(k) {
  return idbTx('meta', 'readonly', (tx, res) => {
    const req = tx.objectStore('meta').get(k);
    req.onsuccess = () => res(req.result?.v ?? null);
  });
}
async function idbSetMeta(k, v) { return idbPut('meta', { k, v }); }
async function idbGetBlob(id) {
  return idbTx('blobs', 'readonly', (tx, res) => {
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => res(req.result?.bytes ?? null);
  });
}
async function idbSetBlob(id, bytes) { return idbPut('blobs', { id, bytes }); }
async function cacheMsg(docId, room, data) {
  try {
    const ts = data.createdAt?.toMillis?.() ?? data.ts ?? 0;
    await idbPut('msgs', { id: docId, room, data, ts });
    // Only update high-water mark if ts is meaningful (non-zero)
    if (ts > 0) {
      const prev = (await idbGetMeta(`ts:${room}`)) || 0;
      if (ts > prev) await idbSetMeta(`ts:${room}`, ts);
    }
  } catch {}
}
async function loadCached(room) {
  try {
    const idb = await openIDB();
    return await new Promise((res, rej) => {
      const tx    = idb.transaction('msgs', 'readonly');
      const idx   = tx.objectStore('msgs').index('room_ts');
      const range = IDBKeyRange.bound([room, 0], [room, Infinity]);
      const req   = idx.getAll(range);
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  } catch { return []; }
}
async function clearCacheForRoom(room) {
  try {
    const idb     = await openIDB();
    const records = await loadCached(room);
    await new Promise((res, rej) => {
      const tx  = idb.transaction(['msgs', 'meta'], 'readwrite');
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
      tx.onabort    = e => rej(e.target.error);
      records.forEach(r => tx.objectStore('msgs').delete(r.id));
      tx.objectStore('meta').delete(`ts:${room}`);
    });
  } catch {}
}

let _roomEpoch   = 0;
let _roomSalt    = /** @type {string|null} */ (null); // null = legacy deterministic salt
let _unsubRoom   = null;

const _epochKeys       = _lruMap(50);   // (code:epoch) → CryptoKey
const _importedPubKeys = _lruMap(200);  // b64 → CryptoKey
const _substCache      = _lruMap(20);   // code → { fwd, rev } substitution tables

// ─── Room-code-derived substitution cipher ───────────────────────────────────
// Applied BEFORE compression and AES-GCM encryption.
// Each room code produces a unique, deterministic byte-shuffling table via
// SHA-256. Even if AES were somehow compromised, an attacker would only see
// shuffled bytes — not recognisable text patterns.
// Pipeline: text → substituteBytes → compress → AES-256-GCM → base64
async function _getSubstTable(code) {
  if (_substCache.has(code)) return _substCache.get(code);
  const seed  = new TextEncoder().encode('MIUT_SUBST_V1|' + code);
  const hash  = new Uint8Array(await crypto.subtle.digest('SHA-256', seed));
  // Fisher-Yates shuffle seeded deterministically from hash
  const fwd = new Uint8Array(256);
  for (let i = 0; i < 256; i++) fwd[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (hash[i & 31] ^ hash[(i * 7) & 31] ^ (i * 13)) & 0xff;
    const t = fwd[i]; fwd[i] = fwd[j % (i + 1)]; fwd[j % (i + 1)] = t;
  }
  const rev = new Uint8Array(256);
  for (let i = 0; i < 256; i++) rev[fwd[i]] = i;
  const tbl = { fwd, rev };
  _substCache.set(code, tbl);
  return tbl;
}
function _applySubst(bytes, table) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = table[bytes[i]];
  return out;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Auto epoch rotation counters ────────────────────────────────────────────
const _AUTO_EPOCH_MSG_COUNT = 100; // rotate key every N messages (admin only)
let   _msgsSinceEpoch       = 0;
// ─────────────────────────────────────────────────────────────────────────────

async function _getEpochKey(code, epoch) {
  // v2 rooms: random salt stored in Firestore (more secure)
  // v1 rooms: deterministic salt (backward-compatible with existing rooms)
  const saltTag  = _roomSalt || 'v1';
  const cacheKey = `${code}:${epoch}:${saltTag}`;
  if (_epochKeys.has(cacheKey)) return _epochKeys.get(cacheKey);

  let salt;
  if (_roomSalt) {
    salt = _b64uDec(_roomSalt);                          // random 16 bytes from room doc
  } else {
    const saltInput = new TextEncoder().encode(`NEXUS_EPOCH|${code}|${epoch}`);
    const saltHash  = await crypto.subtle.digest('SHA-256', saltInput);
    salt = new Uint8Array(saltHash).slice(0, 16);         // legacy deterministic
  }

  const raw  = new TextEncoder().encode(code);
  const base = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  const key  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  _epochKeys.set(cacheKey, key);
  return key;
}
function _b64uEnc(buf) {
  let s = ''; const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g,'-').split('/').join('_').replace(/=/g,'');
}
function _b64uDec(s) {
  return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
}
const _COMPRESS_MARKER   = 0x43;
const _NOCOMPRESS_MARKER = 0x4e;

let _compressionSupported = null;
async function _testCompression() {
  if (_compressionSupported !== null) return _compressionSupported;
  try {
    if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
      _compressionSupported = false; return false;
    }
    const cs = new CompressionStream('deflate-raw');
    const w  = cs.writable.getWriter();
    w.write(new TextEncoder().encode('test'));
    w.close();
    const reader = cs.readable.getReader();
    const { value } = await reader.read();
    _compressionSupported = value instanceof Uint8Array && value.length > 0;
  } catch {
    _compressionSupported = false;
  }
  return _compressionSupported;
}

async function _collectStream(readable) {
  const chunks = [], reader = readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function _compress(str) {
  const raw = new TextEncoder().encode(str);
  if (!(await _testCompression())) {
    const out = new Uint8Array(1 + raw.length);
    out[0] = _NOCOMPRESS_MARKER;
    out.set(raw, 1);
    return out;
  }
  try {
    const cs = new CompressionStream('deflate-raw');
    const w  = cs.writable.getWriter();
    w.write(raw); w.close();
    const compressed = await _collectStream(cs.readable);
    const out = new Uint8Array(1 + compressed.length);
    out[0] = _COMPRESS_MARKER;
    out.set(compressed, 1);
    return out;
  } catch {
    const out = new Uint8Array(1 + raw.length);
    out[0] = _NOCOMPRESS_MARKER;
    out.set(raw, 1);
    return out;
  }
}

async function _decompress(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < 2) {
    return new TextDecoder().decode(buf);
  }
  const marker  = buf[0];
  const payload = buf.slice(1);
  if (marker === _NOCOMPRESS_MARKER) {
    return new TextDecoder().decode(payload);
  }
  if (marker === _COMPRESS_MARKER) {
    if (typeof DecompressionStream === 'undefined') {
      return '[message requires update to read]';
    }
    try {
      const ds = new DecompressionStream('deflate-raw');
      const w  = ds.writable.getWriter();
      w.write(payload); w.close();
      const decompressed = await _collectStream(ds.readable);
      return new TextDecoder().decode(decompressed);
    } catch {
      return '[decryption error]';
    }
  }
  return new TextDecoder().decode(buf);
}
async function enc(text, code) {
  try {
    // PART 5: beforeEncrypt hook
    const _hookPayload = (typeof runHooks === 'function')
      ? await runHooks('beforeEncrypt', { text, code })
      : { text, code };
    const _text = (_hookPayload && _hookPayload.text !== undefined) ? _hookPayload.text : text;

    const compressed = await _compress(_text);
    const tbl        = await _getSubstTable(code);
    const substituted = _applySubst(compressed, tbl.fwd);
    const epoch      = _roomEpoch;
    const key        = await _getEpochKey(code, epoch);

    // PART 8: guaranteed unique IV via security.js (falls back to native)
    const iv = (typeof generateIV === 'function') ? generateIV() : crypto.getRandomValues(new Uint8Array(12));

    const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, substituted);
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    const result = `e${epoch}:${_b64uEnc(out)}`;

    // PART 5: afterEncrypt hook
    if (typeof runHooks === 'function') await runHooks('afterEncrypt', { result, epoch });

    return result;
  } catch { return ''; }
}
async function dec(payload, code) {
  if (!payload) return '';
  try {
    if (payload.startsWith('e') && /^e\d+:/.test(payload)) {
      const colon = payload.indexOf(':');
      const epoch = parseInt(payload.slice(1, colon), 10);
      const raw   = _b64uDec(payload.slice(colon + 1));
      const key   = await _getEpochKey(code, epoch);
      const pt    = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
      // Reverse substitution cipher, then decompress
      const tbl   = await _getSubstTable(code);
      const unsubstituted = _applySubst(new Uint8Array(pt), tbl.rev);
      return await _decompress(unsubstituted);
    }
    return '[legacy encrypted — rejoin room to continue]';
  } catch { return '[encrypted]'; }
}

async function encBytes(file, code) {
  try {
    const epoch = _roomEpoch;
    const key   = await _getEpochKey(code, epoch);
    const iv    = crypto.getRandomValues(new Uint8Array(12));
    // Compress file bytes before encryption to reduce Firestore document size
    let fileBuf = new Uint8Array(await file.arrayBuffer());
    let compressed = false;
    if (await _testCompression() && file.size > 1024) {
      try {
        const cs = new CompressionStream('deflate-raw');
        const w  = cs.writable.getWriter();
        w.write(fileBuf); w.close();
        const cBuf = await _collectStream(cs.readable);
        if (cBuf.length < fileBuf.length * 0.95) { // only use if >5% saving
          fileBuf = cBuf; compressed = true;
        }
      } catch {}
    }
    // Prepend 1-byte marker: 0xC0 = compressed, 0x00 = raw
    const markedBuf = new Uint8Array(1 + fileBuf.length);
    markedBuf[0] = compressed ? 0xC0 : 0x00;
    markedBuf.set(fileBuf, 1);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      markedBuf
    );
    const epochBuf = new Uint8Array(4);
    new DataView(epochBuf.buffer).setUint32(0, epoch, false);
    const ctBytes = new Uint8Array(ct);
    const out = new Uint8Array(4 + 12 + ctBytes.byteLength);
    out.set(epochBuf, 0);
    out.set(iv, 4);
    out.set(ctBytes, 16);
    // Build base64 in 16KB chunks to avoid stack overflow on large arrays.
    let s = '';
    for (let i = 0; i < out.length; i += 16384) {
      s += String.fromCharCode(...out.subarray(i, i + 16384));
    }
    return 'b:' + btoa(s);
  } catch(e) { throw e; }
}
async function decBytes(b64full, mime, code) {
  if (b64full.startsWith('b:')) {
    const raw   = Uint8Array.from(atob(b64full.slice(2)), c => c.charCodeAt(0));
    const epoch = new DataView(raw.buffer, 0, 4).getUint32(0, false);
    const iv    = raw.slice(4, 16);
    const ct    = raw.slice(16);
    const key   = await _getEpochKey(code, epoch);
    let pt      = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
    // Check compression marker byte
    if (pt.length > 1 && pt[0] === 0xC0) {
      // Decompress
      try {
        const ds = new DecompressionStream('deflate-raw');
        const w  = ds.writable.getWriter();
        w.write(pt.slice(1)); w.close();
        pt = await _collectStream(ds.readable);
      } catch {}
    } else if (pt.length > 1 && pt[0] === 0x00) {
      pt = pt.slice(1); // strip raw marker
    }
    // Legacy files (no marker byte) are returned as-is
    return new Blob([pt], { type: mime });
  }
  throw new Error('Unsupported legacy media format');
}

const _EC_ALGO = { name: 'ECDSA', namedCurve: 'P-256' };
const _EC_SIGN = { name: 'ECDSA', hash: 'SHA-256' };

async function initSigningKey() {
  try {
    const idb = await openIDB();
    const row = await new Promise((res, rej) => {
      const tx = idb.transaction('sigkey', 'readonly');
      const req = tx.objectStore('sigkey').get('my');
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => rej(req.error);
    });
    if (row?.priv && row?.pubB64) {
      _sigPrivKey = await crypto.subtle.importKey('pkcs8', _b64uDec(row.priv), _EC_ALGO, false, ['sign']);
      _pubKeyB64  = row.pubB64;
      return;
    }
    const kp      = await crypto.subtle.generateKey(_EC_ALGO, true, ['sign', 'verify']);
    const privRaw = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const pubRaw  = await crypto.subtle.exportKey('spki',  kp.publicKey);
    const privB64 = _b64uEnc(privRaw);
    const pubB64  = _b64uEnc(pubRaw);
    _sigPrivKey   = await crypto.subtle.importKey('pkcs8', privRaw, _EC_ALGO, false, ['sign']);
    _pubKeyB64    = pubB64;
    await new Promise((res, rej) => {
      const tx  = idb.transaction('sigkey', 'readwrite');
      const req = tx.objectStore('sigkey').put({ id: 'my', priv: privB64, pubB64 });
      req.onsuccess = res; req.onerror = rej;
    });
  } catch (e) {

    _sigPrivKey = null; _pubKeyB64 = null;
  }
}

async function signMsg(senderId, ts, encText) {
  if (!_sigPrivKey) return null;
  try {
    const buf = new TextEncoder().encode(`${senderId}|${ts}|${encText}`);
    const sig = await crypto.subtle.sign(_EC_SIGN, _sigPrivKey, buf);
    return _b64uEnc(sig);
  } catch (e) {  return null; }
}

async function verifyMsg(sig, senderId, ts, encText, pubKeyB64) {
  if (!sig || !pubKeyB64) return 'unsigned';
  try {
    const key = await _importPubKey(pubKeyB64);
    const buf = new TextEncoder().encode(`${senderId}|${ts}|${encText}`);
    const ok  = await crypto.subtle.verify(_EC_SIGN, key, _b64uDec(sig), buf);
    return ok ? 'verified' : 'failed';
  } catch { return 'failed'; }
}
async function _importPubKey(b64) {
  if (_importedPubKeys.has(b64)) return _importedPubKeys.get(b64);
  const key = await crypto.subtle.importKey('spki', _b64uDec(b64), _EC_ALGO, false, ['verify']);
  _importedPubKeys.set(b64, key);
  return key;
}

async function getPubKey(uid) {
  if (uid === state.me?.id) return _pubKeyB64;
  if (_pubKeyCache.has(uid)) return _pubKeyCache.get(uid);
  try {
    const idb = await openIDB();
    const row = await new Promise((res) => {
      const tx  = idb.transaction('pubkeys', 'readonly');
      const req = tx.objectStore('pubkeys').get(uid);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => res(null);
    });
    if (row?.pubB64) { _pubKeyCache.set(uid, row.pubB64); return row.pubB64; }
  } catch {}
  if (!state.roomCode) return null;
  try {
    const snap   = await db.collection('rooms').doc(state.roomCode).collection('members').doc(uid).get();
    const pubB64 = snap.data()?.pubKey ?? null;
    if (pubB64) { _pubKeyCache.set(uid, pubB64); _cachePubKeyIDB(uid, pubB64); }
    return pubB64;
  } catch { return null; }
}

async function _cachePubKeyIDB(uid, pubB64) {
  try {
    const idb = await openIDB();
    await new Promise((res, rej) => {
      const tx  = idb.transaction('pubkeys', 'readwrite');
      const req = tx.objectStore('pubkeys').put({ uid, pubB64 });
      req.onsuccess = res; req.onerror = rej;
    });
  } catch {}
}

async function verifyAndBadge(data, docId) {
  if (!data.sig) return;
  const wrap = document.querySelector(`.msg-wrapper[data-doc-id="${CSS.escape(docId)}"]`);
  if (!wrap) return;
  const pubB64 = await getPubKey(data.senderId);
  const result = await verifyMsg(data.sig, data.senderId, data.ts, data.enc, pubB64);
  if (result === 'failed') {
    wrap.style.display = 'none';
    wrap.setAttribute('data-sig-blocked', '1');
  }
}

const $  = id  => document.getElementById(id);

// Production builds run esbuild with --drop:console (see build.js) to strip
// debug output shipped to end users. That's fine for routine logs, but it
// also silently strips every console.warn we use to surface REAL failures
// (a background write failing, epoch rotation being rejected, etc.) —
// meaning those warnings never actually reached anyone testing the
// deployed app, only local/dev builds. esbuild's drop only pattern-matches
// direct `console.xxx(...)` call sites, so routing through this one level
// of indirection lets diagnostically-important logs survive into
// production while routine ones can still use console.* directly.
const _sysConsole = window.console;
function _log(level, ...args) { try { _sysConsole?.[level]?.(...args); } catch {} }
const qs = sel => document.querySelector(sel);

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function calcEntropy(code) {
  if (!code) return 0;
  let pool = 0;
  if (/[a-z]/.test(code)) pool += 26;
  if (/[A-Z]/.test(code)) pool += 26;
  if (/[0-9]/.test(code)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(code)) pool += 32;

  // Penalise repeated characters e.g. "aaaaaaaaaa"
  const unique = new Set(code).size;
  const diversity = unique / code.length;  // 1 = all unique, 0.1 = very repetitive

  // Bits of entropy approximation
  const bits = code.length * Math.log2(pool || 1) * diversity;

  // Score 0–4
  if (bits < 28) return 0;   // Very Weak  — most PINs, short words
  if (bits < 40) return 1;   // Weak       — phone numbers, "password1"
  if (bits < 55) return 2;   // Fair       — "MySecret99"
  if (bits < 70) return 3;   // Strong     — "Horse#Correct7"
  return 4;                   // Very Strong
}

const _ENTROPY_META = [
  { label: 'VERY WEAK',   color: '#ff4444', width: '15%'  },
  { label: 'WEAK',        color: '#ff8800', width: '30%'  },
  { label: 'FAIR',        color: '#fcc419', width: '55%'  },
  { label: 'STRONG',      color: '#51cf66', width: '78%'  },
  { label: 'VERY STRONG', color: '#2dd4bf', width: '100%' },
];

function updateEntropyMeter(code) {
  const wrap  = $('entropy-wrap');
  const fill  = $('entropy-fill');
  const label = $('entropy-label');
  if (!wrap || !fill || !label) return;

  if (!code) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';

  const score = calcEntropy(code);
  const meta  = _ENTROPY_META[score];
  fill.style.width      = meta.width;
  fill.style.background = meta.color;
  label.textContent     = meta.label;
  label.style.color     = meta.color;
}

// Belt-and-suspenders: also wire a native DOM listener so Android virtual
// keyboards that swallow oninput HTML attributes still trigger the meter.
// Called once after DOM is ready (DOMContentLoaded fires before this via defer).
function _wireEntropyListeners() {
  const el = $('input-create-code');
  if (!el) return;
  ['input', 'keyup', 'compositionend'].forEach(ev => {
    el.addEventListener(ev, function () { updateEntropyMeter(el.value); });
  });
}

// Map Firebase error codes → { title, detail, icon, type }
// type: 'network' | 'auth' | 'quota' | 'permission' | 'notfound' | 'unknown'
const _ERROR_MAP = {
  // ── Firestore errors ──────────────────────────────────────────────────────
  'unavailable':              { title: 'Server unreachable',     detail: 'Check your connection and try again.',           icon: 'net', type: 'network'     },
  'network-request-failed':   { title: 'No internet connection', detail: 'You appear to be offline.',                     icon: '📶', type: 'network'     },
  'deadline-exceeded':        { title: 'Request timed out',      detail: 'Server took too long — try again.',             icon: 'clock',  type: 'network'     },
  'resource-exhausted':       { title: 'Server busy',            detail: 'Quota exceeded. Try again in a few minutes.',   icon: 'warn',  type: 'quota'       },
  'permission-denied':        { title: 'Access denied',          detail: 'Room not found or you are not signed in. Try refreshing the page.',   icon: 'lock', type: 'permission'  },
  'unauthenticated':          { title: 'Not signed in',          detail: 'Reload the page and try again.',                icon: 'key', type: 'auth'        },
  'not-found':                { title: 'Room not found',         detail: 'The room may have been closed.',                icon: '🔍', type: 'notfound'    },
  'already-exists':           { title: 'Already exists',         detail: 'A room with this code already exists.',         icon: '♻',  type: 'notfound'    },
  'cancelled':                { title: 'Operation cancelled',    detail: 'The request was cancelled — try again.',        icon: 'err',  type: 'unknown'     },
  'internal':                 { title: 'Server error',           detail: 'An internal error occurred. Try again.',        icon: '⚡', type: 'unknown'     },
  'DB probe timeout':         { title: 'Connection timeout',     detail: 'Database took too long to respond.',            icon: 'clock',  type: 'network'     },
  // ── Firebase Auth errors ──────────────────────────────────────────────────
  'auth/operation-not-allowed':    { title: 'Anonymous auth disabled',  detail: 'Enable Anonymous Auth in Firebase Console → Authentication → Sign-in method.', icon: 'warn', type: 'auth' },
  'auth/network-request-failed':   { title: 'No internet',              detail: 'Cannot reach authentication servers.',          icon: '📶', type: 'network' },
  'auth/too-many-requests':        { title: 'Too many attempts',        detail: 'Wait a moment before trying again.',            icon: '⛔', type: 'quota'   },
  'auth/invalid-api-key':          { title: 'Firebase config error',    detail: 'Firebase API key is missing or invalid. Check db-manager.js config.', icon: 'key', type: 'auth' },
  'auth/app-not-authorized':       { title: 'Domain not authorized',    detail: 'Add this domain to Firebase Console → Authentication → Settings → Authorized domains.', icon: '🌐', type: 'auth' },
  'auth/unauthorized-domain':      { title: 'Domain not authorized',    detail: 'Add this domain to Firebase Console → Authentication → Settings → Authorized domains.', icon: '🌐', type: 'auth' },
  'auth/invalid-app-id':           { title: 'Firebase config error',    detail: 'Invalid Firebase App ID in db-manager.js.',     icon: 'key', type: 'auth' },
  'auth/app-deleted':              { title: 'Firebase project deleted',  detail: 'The Firebase project no longer exists.',        icon: 'trash', type: 'auth' },
  'auth/cors-unsupported':         { title: 'Browser not supported',    detail: 'Try a different browser.',                      icon: '🌐', type: 'auth' },
  'auth/web-storage-unsupported':  { title: 'Storage disabled',         detail: 'Enable cookies and local storage in your browser settings.', icon: '🍪', type: 'auth' },
  'auth/auth-domain-config-required': { title: 'Firebase config error', detail: 'authDomain is missing from Firebase config.',   icon: 'key', type: 'auth' },
  'appCheck/token-error':             { title: 'App Check not configured', detail: 'Add your reCAPTCHA v3 site key to db-manager.js and register it in Firebase Console → App Check.', icon: 'shield', type: 'auth' },
  'app-check/token-error':            { title: 'App Check not configured', detail: 'Add your reCAPTCHA v3 site key to db-manager.js and register it in Firebase Console → App Check.', icon: 'shield', type: 'auth' },
  'app check token':                  { title: 'App Check not configured', detail: 'Add your reCAPTCHA v3 site key to db-manager.js and register it in Firebase Console → App Check.', icon: 'shield', type: 'auth' },
  'no-app':                        { title: 'Firebase not initialised',  detail: 'Firebase app failed to start. Reload the page.', icon: '🔥', type: 'auth' },
  'load failed':                   { title: 'No internet connection',   detail: 'Check your connection and try again.',           icon: '📶', type: 'network' },
};

/**
 * _classifyError(e)
 * Returns { title, detail, icon, type } for any Firebase or JS error.
 * Always returns something human-readable — never exposes raw SDK messages.
 */
function _classifyError(e) {
  if (!e) return { title: 'Something went wrong', detail: 'Try again.', icon: 'warn', type: 'unknown' };

  // Firebase SDK errors have e.code like 'firestore/unavailable'
  const raw  = (e?.code || e?.message || String(e)).toLowerCase();
  const code = raw.replace(/^[a-z-]+\//, ''); // strip 'firestore/' prefix

  // Direct match
  for (const [key, val] of Object.entries(_ERROR_MAP)) {
    if (code.includes(key.toLowerCase()) || raw.includes(key.toLowerCase())) return val;
  }

  // Heuristic fallbacks
  if (raw.includes('offline') || raw.includes('network') || raw.includes('fetch'))
    return { title: 'No internet connection', detail: 'You appear to be offline.', icon: '📶', type: 'network' };
  if (raw.includes('timeout') || raw.includes('deadline'))
    return { title: 'Request timed out', detail: 'Try again.', icon: 'clock', type: 'network' };
  if (raw.includes('quota') || raw.includes('resource'))
    return { title: 'Server busy', detail: 'Try again in a few minutes.', icon: 'warn', type: 'quota' };
  if (raw.includes('permission') || raw.includes('forbidden') || raw.includes('unauthorized'))
    return { title: 'Access denied', detail: "You don't have permission.", icon: 'lock', type: 'permission' };

  // Show the raw error code so users can report exactly what went wrong
  const hint = e?.code ? ' [' + e.code + ']' : (e?.message ? ' [' + String(e.message).slice(0, 60) + ']' : '');
  return { title: 'Connection error', detail: 'Check your connection and try again.' + hint, icon: 'net', type: 'unknown' };
}

// ─── Persistent Rate Limiter ─────────────────────────────────────────────────
const WRONG_CODE_LIMIT = 3; // 3 attempts before 30-second lockout
let   _countdownTimer  = null;
// Uses localStorage so a page reload does NOT reset the counter.
// Token-bucket: refills 1 token every REFILL_MS up to MAX_TOKENS.
// Wrong-code lockout uses separate exponential backoff also persisted.
const _RL_KEY    = 'miut_rl_v1';        // localStorage key
const _RL_WRONG  = 'miut_rl_wrong_v1';  // wrong-code lockout key

function _loadRlState(key, defaults) {
  try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(key) || '{}')); }
  catch { return Object.assign({}, defaults); }
}
function _saveRlState(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
}

const _RL_CFG = {
  create: { maxTokens: 5,  refillMs: 30000  },   // 5 creates per 30 s
  enter:  { maxTokens: 10, refillMs: 60000  },   // 10 enters per 60 s
  send:   { maxTokens: 20, refillMs: 10000  },   // 20 msgs per 10 s
};

function _consumeToken(type) {
  const cfg  = _RL_CFG[type]; if (!cfg) return true;
  const key  = `${_RL_KEY}_${type}`;
  const now  = Date.now();
  const st   = _loadRlState(key, { tokens: cfg.maxTokens, lastRefill: now });

  // Refill proportionally to elapsed time
  const elapsed = now - (st.lastRefill || now);
  const refilled = Math.floor(elapsed / cfg.refillMs);
  if (refilled > 0) {
    st.tokens     = Math.min(cfg.maxTokens, (st.tokens || 0) + refilled);
    st.lastRefill = now;
  }

  if (st.tokens <= 0) { _saveRlState(key, st); return false; }
  st.tokens--;
  _saveRlState(key, st);
  return true;
}

function _getRlWaitMs(type) {
  const cfg = _RL_CFG[type]; if (!cfg) return 0;
  const key = `${_RL_KEY}_${type}`;
  const now = Date.now();
  const st  = _loadRlState(key, { tokens: cfg.maxTokens, lastRefill: now });
  if ((st.tokens || 0) > 0) return 0;
  const sinceRefill = now - (st.lastRefill || now);
  return Math.max(0, cfg.refillMs - (sinceRefill % cfg.refillMs));
}

/* ── Edge-backed rate limiter ─────────────────────────────────────────────
 * Two-layer approach:
 *  1. localStorage token bucket  — instant, local, bypassable by incognito
 *  2. Edge KV token bucket       — server-side per-IP, bypasses incognito/curl
 * The local check acts as a fast pre-check to avoid unnecessary edge calls.
 * The edge check is the authoritative limit — it runs in parallel and
 * blocks the action if the edge returns 429, even if local tokens remain.
 * ──────────────────────────────────────────────────────────────────────── */
async function checkRateLimit(type) {
  // Fast path: local token consumed — skip edge call for obvious over-use
  const localAllowed = _consumeToken(type);
  if (!localAllowed) {
    const waitMs = _getRlWaitMs(type);
    _startCountdown(waitMs, type);
    showError('');
    return false;
  }

  // Slow path: authoritative edge check (IP-based, KV-backed, incognito-proof)
  try {
    const res = await fetch('/api/rate-limit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: type }),
      // Short timeout — if edge is unavailable, fall through to local-only
      signal:  AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const retryAfterSec = parseInt(res.headers.get('Retry-After') || '30', 10);
      _startCountdown(retryAfterSec * 1000, type);
      showError('');
      return false;
    }

    if (!res.ok) {
      // Non-429 error from edge (500, etc.) — log and allow locally so a
      // temporary edge outage does not block all users
    }
  } catch (err) {
    // Network error or timeout — fall through to local-only mode
    if (err.name !== 'AbortError') {
    }
  }

  return true;
}

// Wrong-code lockout — persisted across reloads
function _loadWrongState() {
  return _loadRlState(_RL_WRONG, { wrongCount: 0, lockedUntil: 0 });
}
function _saveWrongState(obj) { _saveRlState(_RL_WRONG, obj); }

function _recordWrongCode() {
  const now  = Date.now();
  const st   = _loadWrongState();
  st.wrongCount = (st.wrongCount || 0) + 1;

  const errEl = $('join-error') || $('invite-error');

  if (st.wrongCount < WRONG_CODE_LIMIT) {
    // Show remaining attempts — no lockout yet
    const left = WRONG_CODE_LIMIT - st.wrongCount;
    _saveWrongState(st);
    if (errEl) {
      errEl.textContent = `Wrong code — ${left} attempt${left !== 1 ? 's' : ''} remaining`;
      errEl.style.color = 'var(--danger)';
    }
    return;
  }

  // Lockout: 30 seconds flat after exhausting attempts
  st.lockedUntil = now + 30000;
  st.wrongCount  = 0; // reset count so next lockout starts fresh
  _saveWrongState(st);
  if (errEl) errEl.textContent = '';
  _startCountdown(30000, 'enter');
}

function _checkEnterLock() {
  const now = Date.now();
  const st  = _loadWrongState();
  if ((st.lockedUntil || 0) > now) {
    const remaining = st.lockedUntil - now;
    if (!_countdownTimer) _startCountdown(remaining, 'enter');
    return false;
  }
  return true;
}

// Send-rate limit (in-memory only — resets on reload is acceptable for sends)
const _sendRl = { count: 0, resetAt: 0 };
function checkSendRateLimit() {
  const now = Date.now();
  if (now > _sendRl.resetAt) { _sendRl.count = 0; _sendRl.resetAt = now + 10000; }
  _sendRl.count++;
  if (_sendRl.count > 20) { toast('Slow down', 'Too many messages sent too quickly.', 'warn'); return false; }
  return true;
}
// ─────────────────────────────────────────────────────────────────────────────

function _startCountdown(ms, context) {
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
  const endTime = Date.now() + ms;

  const _getBtn = () => {
    if (context === 'create') return $('btn-create');
    return $('btn-enter') || $('invite-join-btn');
  };

  function _tick() {
    const remaining = Math.ceil((endTime - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(_countdownTimer); _countdownTimer = null;
      const errEl = $('join-error') || $('invite-error');
      const cdEl  = $('nx-countdown');
      if (errEl) { errEl.textContent = ''; errEl.className = 'error-msg'; }
      if (cdEl)  cdEl.remove();
      const btn = _getBtn();
      if (btn) {
        btn.disabled = false;
        const sp = btn.querySelector('span');
        if (sp) {
          if (context === 'create')          sp.textContent = 'Create Room';
          else if (btn.id === 'invite-join-btn') sp.textContent = 'Join Room';
          else                               sp.textContent = 'Enter Room';
        }
      }
      return;
    }
    const mins    = Math.floor(remaining / 60);
    const secs    = remaining % 60;
    const timeStr = mins > 0 ? mins + 'm ' + String(secs).padStart(2,'0') + 's' : secs + 's';
    const colour  = remaining < 10 ? '#ff4444' : remaining < 30 ? '#f97316' : 'var(--danger)';
    const pct     = ((ms - (endTime - Date.now())) / ms * 100).toFixed(1);

    let cdEl = $('nx-countdown');
    if (!cdEl) {
      cdEl = document.createElement('div');
      cdEl.id = 'nx-countdown';
      const errEl = $('join-error') || $('invite-error');
      if (errEl) errEl.insertAdjacentElement('afterend', cdEl);
    }
    cdEl.className = 'nx-countdown-bar';
    cdEl.innerHTML =
      '<svg viewBox="0 0 20 20" fill="none" width="13" height="13" style="flex-shrink:0;color:' + colour + '">' +
        '<circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.6"/>' +
        '<path d="M10 6v4l2.5 2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '</svg>' +
      '<span style="color:' + colour + ';font-family:var(--fmono);font-size:.72rem;letter-spacing:.5px">' +
        'Too many attempts — wait <strong>' + timeStr + '</strong>' +
      '</span>' +
      '<div class="nx-countdown-progress" style="--p:' + pct + '%;--c:' + colour + '"></div>';

    const btn = _getBtn();
    if (btn) btn.disabled = true;
  }

  _tick();
  _countdownTimer = setInterval(_tick, 250);
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), n = new Date();
  return d.toDateString() === n.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function fmtBytes(b) {
  return b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(1) + ' KB' : (b/1048576).toFixed(1) + ' MB';
}
function ts_now() { return firebase.firestore.FieldValue.serverTimestamp(); }

const AV_COLORS = ['#2dd4bf','#06b6d4','#3b82f6','#8b5cf6','#ec4899','#f43f5e','#f97316','#eab308','#22c55e','#14b8a6','#6366f1','#a855f7'];
const REACTION_EMOJIS  = ['👍','❤️','😂','😮','😢','🔥','👀','🎉'];
const EXTENDED_EMOJIS = [
  '👍','❤️','😂','😮','😢','🔥','👀','🎉',
  '🙏','💯','✨','🤔','😍','🥰','😎','🤯',
  '😭','🫡','💀','🤣','😅','🙌','💪','🤝',
  '👏','🫶','❗','✅','🚀','💬','🎯','⚡',
];
function avatarColor(s) { let h=0; for(const c of s) h=(h*31+c.charCodeAt(0))&0xffffffff; return AV_COLORS[Math.abs(h)%AV_COLORS.length]; }
function initials(n)     { return n.trim().split(/\s+/).map(w=>w[0]?.toUpperCase()||'').join('').slice(0,2)||'??'; }

const _A=['DARK','FAST','COLD','BOLD','VOID','NEON','GREY','IRON','WILD','FLUX'];
const _N=['FOX','OWL','RAY','ACE','SKY','KAI','ZEN','MAX','REX','DOT'];
function genCallsign() { return `${_A[Math.random()*_A.length|0]} ${_N[Math.random()*_N.length|0]}${(Math.random()*90+10)|0}`; }
// getUID() — always returns the Firebase Anonymous Auth UID.
// If auth fails (network down, quota exceeded), throws — callers must handle.
// A localStorage fallback UID has no JWT and fails all Firestore rules.
async function getUID() {
  const uid = await ensureAuth(); // throws on auth failure — handled by callers
  return uid;
}

function saveSession() { localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(state.me)); }
function loadSession() { try { return JSON.parse(localStorage.getItem(CONFIG.SESSION_KEY)); } catch { return null; } }
function saveRoom(c)   { localStorage.setItem(CONFIG.ROOM_KEY, c); }
function loadRoom()    { return localStorage.getItem(CONFIG.ROOM_KEY); }

window.addEventListener('DOMContentLoaded', () => {
  _wireAllHandlers();
  _wireEntropyListeners();
  // Warm up Anonymous Auth immediately so it's ready when user clicks Enter/Create.
  getUID().catch(() => {});

  // ── Three-finger gesture + screenshot detection ────────────────────
  _initScreenshotProtection();
  // ── Rotating placeholder text (CSP-safe, moved from inline HTML script) ──
  (function initRotatingPlaceholders() {
    function rotatePlaceholder(input) {
      var list;
      try { list = JSON.parse(input.dataset.placeholders || '[]'); } catch { return; }
      if (!list.length) return;
      var idx = 0;
      setInterval(function () {
        if (document.activeElement === input || input.value) return;
        input.classList.add('ph-fade');
        setTimeout(function () {
          idx = (idx + 1) % list.length;
          input.placeholder = list[idx];
          input.classList.remove('ph-fade');
        }, 400);
      }, 2200);
    }
    document.querySelectorAll('[data-placeholders]').forEach(rotatePlaceholder);
  })();


  // ── Offline / online banner ─────────────────────────────────────────────
  function _updateOnlineBanner() {
    let b = document.getElementById('offline-banner');
    if (navigator.onLine) { b?.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = 'offline-banner';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:var(--danger,#e74c3c);color:#fff;text-align:center;padding:6px 12px;font-size:.72rem;font-family:var(--fmono,monospace);letter-spacing:.5px';
      b.textContent = '⚠ No internet connection — messages will not send';
      document.body.prepend(b);
    }
  }
  window.addEventListener('online',  _updateOnlineBanner);
  window.addEventListener('offline', _updateOnlineBanner);
  _updateOnlineBanner();

  // Start anonymous auth immediately — warm up the JWT before any room action.

  // Prefs
  try {
    const p = JSON.parse(localStorage.getItem(CONFIG.PREFS_KEY) || '{}');
    Object.assign(state.prefs, p);
  } catch {}

  // Open IDB (non-blocking)
  openIDB().catch(() => {});
  // db is set to the correct shard on room join/create via getDb(roomCode).
  // We set a default here so code that accesses db before joining (rare)
  // doesn't throw — it will be overwritten by the first getDb() call.
  // Await _dbFirebaseReady to ensure the compat SDK has loaded before use.
  (window._dbFirebaseReady || Promise.resolve()).then(() => {
    try {
      const _bootDbName = (window.__MIUT_DB_CONFIGS__ || []).find(d => d.active)?.name || 'miut-db0';
      db = firebase.firestore(firebase.app(_bootDbName));
    } catch (e) {
    }
  }).catch(err => {
    console.error('[App] Firebase unavailable at startup:', err.message);
  });



  // Ripple
  document.addEventListener('touchstart', handleRipple, { passive: true });
  document.addEventListener('mousedown',  handleRipple);

  document.addEventListener('copy',        e => { if (!e.target.closest('input,textarea')) e.preventDefault(); });
  document.addEventListener('cut',         e => { if (!e.target.closest('input,textarea')) e.preventDefault(); });
  document.addEventListener('contextmenu', e => { if (!e.target.closest('input,textarea,.msg-bubble')) e.preventDefault(); });
  document.addEventListener('selectstart', e => { if (!e.target.closest('input,textarea')) e.preventDefault(); });

  // Sidebar setup
  setupSidebar();
  setupActionBtn();
  // Hide sidebar until app screen is shown (sidebar is now a body-level element)
  const _initSb = $('sidebar');
  if (_initSb) _initSb.style.display = 'none';
  setupClipboardPaste();

  // Restore saved name
  const saved = localStorage.getItem('nx_name');
  if (saved) { const el = $('input-name'); if (el) el.value = saved; }

  // Splash → session restore.
  // Always fires after 1800ms regardless of Firebase state.
  setTimeout(() => {
    hideSplash();
    const inviteCode = _detectInviteParam();
    if (inviteCode) {
      showInviteScreen();
      return;
    }
    // Hash-based routing: miutchat.pages.dev/index.html#enterroom or #createroom
    const _hash = (window.location.hash || '').replace('#','').toLowerCase();
    if (_hash === 'enterroom' || _hash === 'joinroom') {
      showScreen('join-screen');
      // Pre-select the Enter tab
      const tabs = document.querySelectorAll('[data-tab]');
      tabs.forEach(t => { t.classList.toggle('active', t.dataset.tab === 'enter'); });
      const panels = document.querySelectorAll('.tab-panel');
      panels.forEach(p => { p.classList.toggle('active', p.id === 'panel-enter'); });
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }
    if (_hash === 'createroom') {
      showScreen('join-screen');
      const tabs = document.querySelectorAll('[data-tab]');
      tabs.forEach(t => { t.classList.toggle('active', t.dataset.tab === 'create'); });
      const panels = document.querySelectorAll('.tab-panel');
      panels.forEach(p => { p.classList.toggle('active', p.id === 'panel-create'); });
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }
    // PWA / first-visit routing
    // If launched from homescreen (standalone) or already has a session — skip landing
    const _isPWA  = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    const _hasSession = !!(loadSession()?.id && loadRoom());
    const me = loadSession(), room = loadRoom();
    if (me?.id && room) { state.me = me; state.roomCode = room; checkApprovalAndBoot(); return; }
    if (_isPWA) { showScreen('join-screen'); return; }
    // First-time visitor check: if never visited, redirect to landing page
    const _hasVisited = localStorage.getItem('miut_visited');
    if (!_hasVisited) {
      localStorage.setItem('miut_visited', '1');
      // Only redirect if not already on index from landing (no referrer from same origin)
      const _fromLanding = document.referrer && document.referrer.includes(window.location.hostname);
      if (!_fromLanding && !inviteCode) {
        window.location.href = '/landing.html';
        return;
      }
    }
    showScreen('join-screen');
  }, 1800);
});

function hideSplash() { $('splash')?.classList.remove('active'); }
function showScreen(id) {
  const next = $(id);
  if (!next) return;
  // Sidebar visibility — sidebar is a body-level element, only show in app
  const sidebarEl = $('sidebar');
  if (sidebarEl) {
    if (id === 'app') {
      sidebarEl.style.display = '';
    } else {
      sidebarEl.style.display = 'none';
      closeSidebar();
    }
  }
  // Morph-exit the currently active screen
  document.querySelectorAll('.screen.active').forEach(s => {
    if (s.id === id) return;
    s.classList.add('morph-exit');
    s.classList.remove('active');
    setTimeout(() => s.classList.remove('morph-exit'), 350);
  });
  // Small delay so exit animation registers before enter
  requestAnimationFrame(() => {
    next.classList.add('active');
    // Re-trigger nx-anim children so stagger replays each time
    next.querySelectorAll('.nx-anim').forEach(el => {
      el.style.animation = 'none';
      el.style.opacity   = '';
      requestAnimationFrame(() => { el.style.animation = ''; });
    });
  });
}

function setupSidebar() {
  // Create overlay backdrop if not already in DOM
  if (!$('sidebar-overlay')) {
    const o = document.createElement('div');
    o.id = 'sidebar-overlay';
    document.body.appendChild(o);
  }

  // OVERLAY: receives taps on the dark area to the right of sidebar.
  // sidebar is z-index:20, overlay is z-index:18 → browser hit-test
  // ensures taps on the sidebar portion never reach the overlay.
  const ov = $('sidebar-overlay');
  if (ov && !ov._miutWired) {
    ov._miutWired = true;
    // click covers mouse AND tap on most Android/iOS
    ov.addEventListener('click', () => closeSidebar());
    // touchend as belt-and-suspenders for Android Chrome
    ov.addEventListener('touchend', e => {
      e.preventDefault();
      closeSidebar();
    }, { passive: false });
  }

  // HAMBURGER
  const ham = $('hamburger-btn');
  if (ham && !ham._miutWired) {
    ham._miutWired = true;
    ham.addEventListener('click', () => _sidebarOpen ? closeSidebar() : openSidebar());
  }

  // SWIPE: right-from-left-edge opens, left-swipe closes
  if (!document._miutSwipeWired) {
    document._miutSwipeWired = true;
    let _sx = 0, _sy = 0;
    document.addEventListener('touchstart', e => {
      _sx = e.touches[0].clientX;
      _sy = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', e => {
      if (e.target.closest && e.target.closest('#sidebar')) return;
      const dx = e.changedTouches[0].clientX - _sx;
      const dy = e.changedTouches[0].clientY - _sy;
      if (Math.abs(dy) > Math.abs(dx) * 1.4 || Math.abs(dx) < 50) return;
      if (dx > 0 && _sx < 36 && !_sidebarOpen) openSidebar();
      else if (dx < 0 && _sidebarOpen) closeSidebar();
    }, { passive: true });
  }
}

function toggleSidebar() { _sidebarOpen ? closeSidebar() : openSidebar(); }

function openSidebar() {
  if (window.innerWidth >= 641) return;
  _sidebarOpen = true;
  $('sidebar')?.classList.add('open');
  $('sidebar-overlay')?.classList.add('active');
  document.body.classList.add('sidebar-active');
}

function closeSidebar() {
  _sidebarOpen = false;
  $('sidebar')?.classList.remove('open');
  $('sidebar-overlay')?.classList.remove('active');
  document.body.classList.remove('sidebar-active');
}

function switchJoinTab(tab) {
  if (!['create', 'enter'].includes(tab)) return;
  document.querySelectorAll('.join-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.join-tab-panel').forEach(p => p.classList.remove('active'));
  qs(`.join-tab-btn[data-tab="${tab}"]`)?.classList.add('active');
  $(`tab-${tab}`)?.classList.add('active');
}

function resolveName() {
  const typed = ($('input-name')?.value || '').trim();
  if (typed) { localStorage.setItem('nx_name', typed); return typed; }
  let anon = localStorage.getItem('nx_anon');
  if (!anon) { anon = genCallsign(); localStorage.setItem('nx_anon', anon); }
  return anon;
}

async function handleCreate() {
  if (!(await checkRateLimit('create'))) return;
  const code = ($('input-create-code')?.value || '').trim();
  if (!validateRoomCode(code)) return;

  const score = calcEntropy(code);
  if (score < 2) {
    showError('Code too weak — mix uppercase, numbers, and symbols (e.g. Flash#42)');
    return;
  }

  const btn = $('btn-create');
  setLoading(btn, true, 'Creating…');
  try {
    // getUID() throws if Anonymous Auth is unavailable (network down, not enabled in console)
    const uid = await getUID();
    if (typeof getDb !== 'function') throw new Error('Database module not loaded. Please refresh.');
    db = await getDb(code);

    // Room codes are user-chosen (typed in, not randomly generated), so
    // collisions are real: two different people can type the same
    // memorable code, or the same person can reuse a code from a room
    // that was supposed to have expired already. Since creation used to
    // write with { merge: true } and never checked whether a room already
    // existed at this path, "creating" a room whose code was already
    // occupied silently merged into the EXISTING document instead of
    // starting fresh — if that old room's messages/members subcollections
    // hadn't actually been cleaned up yet (wipeRoom failing silently is a
    // real possibility — see its own comment), the "new" room would
    // immediately resurface someone else's old messages and members. This
    // is very likely the cause of rooms reappearing after being "deleted."
    // Fail closed instead: refuse to create over an existing room, rather
    // than silently reusing whatever's there.
    const existing = await db.collection('rooms').doc(code).get();
    if (existing.exists) {
      showError('That room code is already in use — pick a different one.');
      setLoading(btn, false);
      return;
    }

    // Generate cryptographically random 16-byte salt for this room's PBKDF2
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const roomSalt  = _b64uEnc(saltBytes.buffer);
    _roomSalt = roomSalt;
    // autoDeleteAt = 30 min bootstrap safety net (independent of the Room
    // Expiry preference below) — covers the case where the creator abandons
    // the room before anyone ever properly joins. Once the room is actually
    // used and later becomes empty, startPresenceListener takes over and
    // reschedules autoDeleteAt based on inactivityTtlMs instead.
    const _autoDeleteAt = firebase.firestore.Timestamp.fromMillis(Date.now() + 1800000);
    // Every room document gets the FULL canonical field set at creation —
    // no field is ever simply absent. Fields with no current value use an
    // explicit null (or 0/[] as appropriate) rather than being left unset,
    // so every room in the database has the identical shape and any field
    // can be read without an `!== undefined` fallback. (null is safe here
    // specifically for autoDeleteAt/emptyAt: Firestore's `<=` range queries,
    // like the cleanup cron's, never match null or missing fields, so this
    // doesn't risk the cron treating a null deadline as "already passed.")
    // No longer { merge: true } — the existence check above already
    // guarantees this path is empty, so a plain set() is both correct and
    // makes it impossible to ever blend fields into pre-existing data.
    await db.collection('rooms').doc(code).set({
      createdAt:        ts_now(),
      creatorId:        uid,
      epoch:            0,
      salt:             roomSalt,
      autoDeleteAt:     _autoDeleteAt,
      inactivityTtlMs:  300000,   // 5 min — the "after everyone leaves" default
      lastActivity:     ts_now(),
      approvalRequired: true,     // set explicitly below too; kept here so the field always exists from creation
      emptyAt:          null,
      msgTtlMs:         0,        // per-message expiry — off by default
      blockedUsers:     [],       // see blockMember() — ids blocked by the admin, denied re-entry
    });
    _roomEpoch = 0;
    state.me = await buildMe(resolveName()); state.roomCode = code;
    saveSession(); saveRoom(code);
    await registerPresence('admin', true);
    // Approval gate is always on — no choice presented
    // Apply user-selected message expiry (from create room TTL selector)
    const _selectedTtlBtn = document.querySelector('#create-ttl-selector .ttl-opt.active');
    const _selectedTtlSec = parseInt(_selectedTtlBtn?.dataset?.ttl || '0', 10);
    const _createUpdates = { approvalRequired: true };
    if (_selectedTtlSec > 0) _createUpdates.msgTtlMs = _selectedTtlSec * 1000;
    await db.collection('rooms').doc(code).update(_createUpdates).catch(() => {});
    if (_selectedTtlSec > 0) _roomTtlMs = _selectedTtlSec * 1000;
    await sendSys(`${state.me.name} created this room`);
    _ping('room_created');
    bootApp();
  } catch (e) { showSmartError(e, 'create'); }
  finally { setLoading(btn, false); }
}

async function handleEnter() {
  if (!_checkEnterLock()) return;
  if (!(await checkRateLimit('enter'))) return;
  const code = ($('input-room-code')?.value || '').trim();
  if (!validateRoomCode(code)) return;

  // ── Vault passkey check (before any Firebase call) ──────────────
  try {
    const vr = await fetch('/api/vault-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: code }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
    });
    if (vr.ok) {
      const vd = await vr.json();
      if (vd.vault === true) {
        // Open vault as in-app screen — never redirects to a URL
        _vaultToken = vd.token || '1';
        $('input-room-code') && ($('input-room-code').value = '');
        showScreen('vault-screen');
        _vaultInit();
        return;
      }
    }
  } catch { /* vault check timed out or failed — treat as normal room code */ }
  // ─────────────────────────────────────────────────────────────────

  const btn = $('btn-enter');
  setLoading(btn, true, 'Connecting…');
  try {
    // Authenticate FIRST — Firestore rules require request.auth != null.
    // Without this, every read returns permission-denied regardless of room existence.
    const uid = await getUID();
    db = await getDb(code);
    const roomSnap = await db.collection('rooms').doc(code).get();
    if (!roomSnap.exists) {
      _recordWrongCode();
      return;
    }
    _saveWrongState({ wrongCount: 0, lockedUntil: 0 });
    // A blocked user is permanently barred from this room (see blockMember) —
    // check before anything else so there's no path that lets them back in.
    if ((roomSnap.data()?.blockedUsers || []).includes(uid)) {
      const errEl = $('join-error');
      if (errEl) errEl.textContent = 'You have been blocked from this room by an admin.';
      setLoading(btn, false);
      return;
    }
    // Check if room has expired before entering
    const _expired = await _checkRoomExpiry(code, db);
    if (_expired) { setLoading(btn, false); return; }
    _roomEpoch = roomSnap.data()?.epoch || 0;
    _roomSalt  = roomSnap.data()?.salt  || null;
    { const _iv = roomSnap.data()?.inactivityTtlMs; _roomExpiryMs = _iv !== undefined ? _iv : 300000; }
    _healRoomSchema(code, roomSnap.data()).catch(() => {});

    const memberSnap  = await db.collection('rooms').doc(code).collection('members').doc(uid).get();
    const prevData    = memberSnap.exists ? memberSnap.data() : null;
    const wasApproved = prevData?.approved === true;

    state.me = await buildMe(resolveName()); state.roomCode = code;
    saveSession(); saveRoom(code);

    if (wasApproved) {
      // Returning approved member — skip the queue
      const role = prevData.role || 'member';
      await registerPresence(role, true);
      await sendSys(`${state.me.name} rejoined the room`);
      bootApp();
    } else if (prevData && prevData.declined) {
      // Was explicitly declined by admin
      const errEl = $('join-error');
      if (errEl) errEl.textContent = 'Your request was declined by the room admin.';
      setLoading($('btn-enter'), false);
      return;
    } else {
      // D7: check if the room has approval required (stored on room doc)
      const roomData          = roomSnap.data();
      const approvalRequired  = roomData?.approvalRequired === true;

      if (approvalRequired) {
        // Gate — register as pending and show waiting screen
        await registerPresence('member', false);
        showWaitingScreen();
      } else {
        // Open room — approve immediately and boot
        await registerPresence('member', true);
        await sendSys(`${state.me.name} joined the room`);
        bootApp();
      }
    }
  } catch (e) { showSmartError(e, 'enter'); }
  finally { setLoading(btn, false); }
}

async function buildMe(name) {
  const id = await getUID(); // async Firebase Auth UID
  return { id, name, color: avatarColor(name), joinedAt: Date.now() };
}

// registerPresence: creates or updates the caller's member document.
// Firestore rules only allow create with role='member' and approved=false.
// When the creator needs admin+approved=true, we do:
//   1. .set() with role='member', approved=false  (satisfies create rule)
//   2. .update() with role='admin', approved=true  (satisfies update rule — they are now a member)
async function registerPresence(role = 'member', approved = false) {
  await initSigningKey();
  const ref = db.collection('rooms').doc(state.roomCode)
                 .collection('members').doc(state.me.id);

  // Read existing doc — determines whether this is a create or update path.
  // This prevents overwriting an approved member's role/approved with defaults.
  let existingData = null;
  try {
    const snap = await ref.get();
    existingData = snap.exists ? snap.data() : null;
  } catch (_e) { /* ignore — will attempt create below */ }

  if (!existingData) {
    // ── First join: CREATE with role='member' / approved=false (enforced by rules) ──
    await ref.set({
      name:     state.me.name,
      color:    state.me.color,
      online:   true,
      lastSeen: ts_now(),
      joinedAt: ts_now(),
      pubKey:   _pubKeyB64 ?? null,
      role:     'member',    // create rule enforces this
      approved: false,       // create rule enforces this
    });
  } else {
    // ── Returning member: UPDATE only safe presence fields ──
    // Never overwrite role/approved — those are managed by admin or self-escalation.
    await ref.update({
      name:     state.me.name,
      color:    state.me.color,
      online:   true,
      lastSeen: ts_now(),
      pubKey:   _pubKeyB64 ?? null,
    });
  }

  // ── Escalate role / approved only when values genuinely need to change ──
  // For returning members already holding the correct values, skip to avoid
  // triggering rules that only apply to first-join escalation.
  const needsRole     = role === 'admin'  && existingData?.role !== 'admin';
  const needsApproved = approved === true && existingData?.approved !== true;

  if (needsRole || needsApproved) {
    const updates = {};
    if (needsRole)     updates.role     = 'admin';
    if (needsApproved) updates.approved = true;
    await ref.update(updates);
  }

  // Reflect actual DB state into local state
  if (existingData) {
    state.me.role     = existingData.role     ?? role;
    state.me.approved = existingData.approved ?? approved;
  } else {
    state.me.role     = role;
    state.me.approved = approved;
  }
}

function bootApp() {
  _renderedIds.clear();
  _lastCachedTs    = 0;
  _onlineCount     = 0;
  _presenceSettled = false;  // reset — first snapshot must not trigger wipe
  _roomWasEmpty    = false;
  _isAdmin         = state.me?.role === 'admin';

  // Update UI
  ['chat-name','room-code-pill','welcome-room-name'].forEach(id => {
    const el = $(id); if (el) el.textContent = state.roomCode;
  });
  const nsb = $('my-name-sidebar');   if (nsb) nsb.textContent = state.me.name;
  const av  = $('my-avatar-sidebar');
  if (av) { av.textContent = initials(state.me.name); av.style.background = state.me.color; }

  // D7: show admin badge in sidebar profile
  updateAdminBadge();

  showScreen('app');

  // Set solo hint code
  const sc = $('solo-code'); if (sc) sc.textContent = state.roomCode;

  // Advanced security init
  _initSessionHmac().catch(() => {});
  _initAntiCapture();
  _startExpirySweep();

  // Load IDB cache instantly, then fetch history from Firestore
  loadCachedMessages();

  // Start ALL listeners immediately — no gating on user count
  startPresenceListener();
  startChatListeners();
  startRoomListener();
  startHeartbeat();
  initScrollFab();
  toast('Joined room · ' + state.roomCode, 'Share this code to invite others', 'ok');
}

async function checkApprovalAndBoot() {
  try {
    // (same room code → same hash → same db index) but db may be stale.
    db = await getDb(state.roomCode);
    const roomSnap = await db.collection('rooms').doc(state.roomCode).get();
    if (roomSnap.exists) {
      _roomEpoch = roomSnap.data()?.epoch || 0;
      _roomSalt  = roomSnap.data()?.salt  || null;
      { const _iv = roomSnap.data()?.inactivityTtlMs; _roomExpiryMs = _iv !== undefined ? _iv : 300000; }
      _healRoomSchema(state.roomCode, roomSnap.data()).catch(() => {});
    }

    const snap = await db.collection('rooms').doc(state.roomCode)
      .collection('members').doc(state.me.id).get();

    if (!snap.exists) {
      // Room wiped or member doc gone — go back to join
      showScreen('join-screen'); return;
    }
    const data = snap.data();
    // Blocked while this session's saved credentials were still around —
    // don't let a resumed session bypass the same check the fresh-join
    // paths enforce.
    if (data.blocked || (roomSnap.data()?.blockedUsers || []).includes(state.me.id)) {
      localStorage.removeItem(CONFIG.SESSION_KEY);
      localStorage.removeItem(CONFIG.ROOM_KEY);
      const errEl = $('join-error');
      if (errEl) errEl.textContent = 'You have been blocked from this room by an admin.';
      showScreen('join-screen');
      return;
    }
    state.me.role     = data.role     || 'member';
    state.me.approved = data.approved || false;

    if (data.approved) {
      // Re-mark online before starting listeners so presence listener
      // doesn't see count=0 and trigger wipeRoom on the first snapshot.
      await db.collection('rooms').doc(state.roomCode)
        .collection('members').doc(state.me.id)
        .update({ online: true }).catch(() => {});
      bootApp();
    } else if (data.declined) {
      localStorage.removeItem(CONFIG.SESSION_KEY);
      localStorage.removeItem(CONFIG.ROOM_KEY);
      state.me = null; state.roomCode = null;
      showScreen('join-screen');
      setTimeout(() => showError('Your previous join request was declined'), 400);
    } else {
      // Still pending — re-register as online and resume waiting
      await registerPresence('member', false);
      showWaitingScreen();
    }
  } catch(e) {
    _log('warn', '[MIUT] checkApprovalAndBoot error — falling back to boot:', e?.message || e);
    // Mark online best-effort; if offline this fails silently
    if (state.roomCode && state.me?.id) {
      db.collection('rooms').doc(state.roomCode)
        .collection('members').doc(state.me.id)
        .update({ online: true }).catch(() => {});
    }
    bootApp();
  }
}

function showWaitingScreen() {
  const wa = $('waiting-avatar'), wn = $('waiting-name'), wr = $('waiting-room-code');
  if (wa) { wa.textContent = initials(state.me.name); wa.style.background = state.me.color; }
  if (wn) wn.textContent = state.me.name;
  if (wr) wr.textContent = state.roomCode;
  showScreen('waiting-screen');
  startHeartbeat();
  startApprovalListener();
}

function startApprovalListener() {
  if (_unsubApproval) { try { _unsubApproval(); } catch {} }

  _unsubApproval = db.collection('rooms').doc(state.roomCode)
    .collection('members').doc(state.me.id)
    .onSnapshot(snap => {
      if (!snap.exists) { handleDeclined('Room closed or request removed.'); return; }
      const data = snap.data();
      if (data.declined) { handleDeclined('Your request to join was declined.'); return; }
      if (data.approved) {
        // ✓ Approved — clean up and boot into the chat
        if (_unsubApproval) { try { _unsubApproval(); } catch {} _unsubApproval = null; }
        state.me.role     = data.role     || 'member';
        state.me.approved = true;
        saveSession();
        sendSys(`${state.me.name} joined the room`).catch(() => {});
        bootApp();
      }
    }, () => {});
}

function handleDeclined(msg = 'Request declined.') {
  if (_unsubApproval) { try { _unsubApproval(); } catch {} _unsubApproval = null; }
  clearInterval(_heartbeat);
  localStorage.removeItem(CONFIG.SESSION_KEY);
  localStorage.removeItem(CONFIG.ROOM_KEY);
  state.me = null; state.roomCode = null;
  showScreen('join-screen');
  setTimeout(() => showError(msg), 300);
}

async function cancelJoinRequest() {
  if (_unsubApproval) { try { _unsubApproval(); } catch {} _unsubApproval = null; }
  clearInterval(_heartbeat);
  if (state.roomCode && state.me?.id) {
    await db.collection('rooms').doc(state.roomCode)
      .collection('members').doc(state.me.id)
      .update({ online: false }).catch(() => {});
  }
  localStorage.removeItem(CONFIG.SESSION_KEY);
  localStorage.removeItem(CONFIG.ROOM_KEY);
  state.me = null; state.roomCode = null;
  showScreen('join-screen');
}

async function approveUser(uid, name) {
  if (!_isAdmin || !state.roomCode) return;
  try {
    await db.collection('rooms').doc(state.roomCode)
      .collection('members').doc(uid)
      .update({ approved: true });
    // Don't send system message here — the newly approved user sends it on their side (bootApp)
    toast(`${name} approved ✓`, 'They can now read and send messages.', 'ok');
  } catch(e) { toast('Approval failed', e.message, 'err'); }
}

async function declineUser(uid, name) {
  if (!_isAdmin || !state.roomCode) return;
  const ok = await showConfirm(`Decline ${name}?`, 'They will be removed from the room.', 'DECLINE');
  if (!ok) return;
  try {
    await db.collection('rooms').doc(state.roomCode)
      .collection('members').doc(uid)
      .update({ online: false, declined: true });
    toast(`${name} was declined`, '', 'err');
  } catch(e) { toast('Decline failed', e.message, 'err'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Required Firestore Security Rules for admin member-management actions
// (promote, demote, approve, decline, block) — this repo doesn't commit a
// firestore.rules file (rules are managed in the Firebase Console), so add
// something like this there. The key requirement throughout: these are
// role-based checks against the CURRENT admin(s) in the members
// subcollection, never a fixed creatorId — since this app supports
// multiple simultaneous admins and promotion/demotion at any time, a rule
// hardcoded to the original creator would silently reject every one of
// these actions once a different admin (or a second admin) tries them.
//
//   function isAdmin(roomCode) {
//     return exists(/databases/$(database)/documents/rooms/$(roomCode)/members/$(request.auth.uid))
//       && get(/databases/$(database)/documents/rooms/$(roomCode)/members/$(request.auth.uid)).data.role == 'admin';
//   }
//
//   match /rooms/{roomCode} {
//     // blockedUsers is admin-only to modify; anyone approved can read it
//     // (the join flow needs to check it before letting someone in).
//     allow update: if request.resource.data.diff(resource.data).affectedKeys().hasOnly(['blockedUsers'])
//       ? isAdmin(roomCode) : true; // (combine with your other room-doc rules, e.g. epoch — see _autoRotateEpoch)
//
//     match /members/{uid} {
//       // A member can always update their own presence/heartbeat fields.
//       allow update: if request.auth.uid == uid
//           && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['online', 'lastSeen', 'pubKey'])
//         // Admin-only fields: role (promote/demote), approved (approve),
//         // declined (decline), blocked (block) — for ANY member's doc.
//         || (isAdmin(roomCode)
//             && request.resource.data.diff(resource.data).affectedKeys()
//                  .hasOnly(['role', 'approved', 'declined', 'blocked', 'online']));
//     }
//   }
// ─────────────────────────────────────────────────────────────────────────────

async function promoteToAdmin(uid, name) {
  if (!_isAdmin || !state.roomCode) return;
  const ok = await showConfirm(
    `Promote ${name} to Admin?`,
    'They will be able to approve and decline new members.',
    'PROMOTE'
  );
  if (!ok) return;
  try {
    await db.collection('rooms').doc(state.roomCode)
      .collection('members').doc(uid)
      .update({ role: 'admin' });
    await sendSys(`${name} was promoted to admin`);
    toast(`${name} is now Admin`, '', 'star');
  } catch(e) { toast('Promotion failed', e.message, 'err'); }
}

/**
 * Admin-only: demotes another admin back to a regular member. Refuses if
 * the target is the only admin left — demoting them would leave the room
 * with no one able to approve members, rotate keys, or moderate at all.
 */
async function demoteMember(uid, name) {
  if (!_isAdmin || !state.roomCode || !uid) return;
  try {
    const adminSnap = await db.collection('rooms').doc(state.roomCode)
      .collection('members').where('role', '==', 'admin').get();
    if (adminSnap.size <= 1 && adminSnap.docs.some(d => d.id === uid)) {
      toast("Can't demote", `${name} is the only admin — promote someone else first.`, 'err');
      return;
    }
  } catch { /* if the check itself fails, fall through and let the write attempt surface any real error */ }
  const ok = await showConfirm(`Demote ${name}?`, 'They will no longer be able to approve members or moderate the room.', 'DEMOTE');
  if (!ok) return;
  try {
    await db.collection('rooms').doc(state.roomCode)
      .collection('members').doc(uid)
      .update({ role: 'member' });
    await sendSys(`${name} was demoted to member`);
    toast(`${name} is now a member`, '', 'ok');
  } catch (e) { toast('Demotion failed', e.message, 'err'); }
}

/**
 * Admin-only: removes a member from the room and permanently bars them
 * from rejoining with the same account (their uid is added to the room's
 * blockedUsers list — checked at join time, see the join flow). Also
 * force-rotates the encryption key immediately rather than waiting for the
 * normal "member left" auto-rotation, so the blocked member can't read
 * anything sent after this point even if they retained the room code and
 * an old snapshot of the key.
 */
async function blockMember(uid, name) {
  if (!_isAdmin || !state.roomCode || !uid) return;
  if (uid === state.me?.id) { toast("Can't block yourself", '', 'err'); return; }
  const ok = await showConfirm(
    `Block ${name}?`,
    'They will be removed immediately and permanently unable to rejoin this room. The encryption key rotates right away so they can\'t read anything sent afterward.',
    'BLOCK'
  );
  if (!ok) return;
  try {
    const roomRef = db.collection('rooms').doc(state.roomCode);
    await roomRef.update({
      blockedUsers: firebase.firestore.FieldValue.arrayUnion(uid),
    });
    await roomRef.collection('members').doc(uid).update({
      online: false, approved: false, blocked: true,
    }).catch(() => {}); // best-effort — the block list above is what actually matters for re-entry
    await sendSys(`${name} was blocked by an admin`);
    // Force-rotate now rather than waiting for the reactive "member left"
    // trigger — that path depends on a live presence listener noticing the
    // departure, which (per a real bug already fixed once) doesn't
    // reliably fire for every departure path. Blocking is a deliberate
    // security action; it shouldn't be left to chance.
    await _autoRotateEpoch('member blocked');
    toast(`${name} blocked`, 'They can no longer rejoin this room.', 'trash');
  } catch (e) { toast('Block failed', e.message, 'err'); }
}

/**
 * Short "safety number"-style fingerprint of a member's signing public key
 * — a SHA-256 hash of the raw key, formatted as grouped hex, rather than
 * showing the full base64 public key (which is long and not meaningfully
 * comparable at a glance). Two people can read this aloud/compare it to
 * verify they're really talking to who they think they are.
 */
async function _pubKeyFingerprint(pubB64) {
  if (!pubB64) return null;
  try {
    const raw = Uint8Array.from(atob(pubB64), c => c.charCodeAt(0));
    const hash = await crypto.subtle.digest('SHA-256', raw);
    const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 20).match(/.{1,4}/g).join(' ').toUpperCase();
  } catch { return null; }
}

let _mdCurrentUid = null;

/**
 * Opens the member detail panel for a given member — shows role, approval
 * status, a key fingerprint, and (admin viewers only) promote/demote/block
 * or approve/decline actions depending on whether the member is approved
 * or still pending.
 */
async function openMemberDetail(uid, m) {
  if (!uid || !m) return;
  _mdCurrentUid = uid;
  const overlay = $('member-detail-modal');
  if (!overlay) return;

  const isMe = uid === state.me?.id;
  const avatarEl = $('md-avatar');
  if (avatarEl) {
    avatarEl.style.background = m.color || avatarColor(m.name || '?');
    avatarEl.textContent = initials(m.name || '?');
  }
  $('md-name').textContent = m.name + (isMe ? ' (you)' : '');
  const roleEl = $('md-role');
  roleEl.textContent = m.role === 'admin' ? '◆ Admin' : 'Member';
  roleEl.classList.toggle('is-admin', m.role === 'admin');

  const statusEl = $('md-status');
  const online = m.online === true;
  statusEl.textContent = online ? '● Online' : 'Offline';
  statusEl.className = 'md-row-value ' + (online ? 'status-online' : 'status-offline');

  const approvalEl = $('md-approval');
  if (m.blocked) { approvalEl.textContent = 'Blocked'; approvalEl.className = 'md-row-value status-blocked'; }
  else if (m.declined) { approvalEl.textContent = 'Declined'; approvalEl.className = 'md-row-value status-blocked'; }
  else if (m.approved) { approvalEl.textContent = 'Approved'; approvalEl.className = 'md-row-value status-approved'; }
  else { approvalEl.textContent = 'Pending approval'; approvalEl.className = 'md-row-value status-pending'; }

  // joinedAt is written via ts_now() (a Firestore serverTimestamp sentinel),
  // which reads back as a Timestamp object with .toDate()/.toMillis() — not
  // a plain number. Passing that straight to `new Date()` produced
  // "Invalid Date" for every member. Handle both the resolved Timestamp
  // and the plain-number fallback (used by buildMe() for the local/optimistic copy).
  const joinedMs = m.joinedAt?.toMillis?.() ?? (typeof m.joinedAt === 'number' ? m.joinedAt : null);
  $('md-joined').textContent = joinedMs ? new Date(joinedMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown';

  const fpEl = $('md-fingerprint');
  fpEl.textContent = 'Loading…';
  (async () => {
    let pub;
    if (isMe) {
      // Always use the local signing key directly for "you" — it's the
      // authoritative source, whereas m.pubKey came from a snapshot that
      // could be momentarily stale (e.g. opened right after joining,
      // before registerPresence's own write has round-tripped back).
      // If it's still unset for some reason, retry initialization once —
      // idempotent, since it loads the existing IndexedDB-stored keypair
      // rather than generating a new one if one already exists.
      pub = _pubKeyB64;
      if (!pub) { await initSigningKey(); pub = _pubKeyB64; }
    } else {
      pub = m.pubKey || await getPubKey(uid);
      // Cached copy might be stale/empty if they hadn't sent a signed
      // message yet when we first saw them — re-check Firestore directly
      // rather than trusting a null cache result forever.
      if (!pub && state.roomCode) {
        try {
          const fresh = await db.collection('rooms').doc(state.roomCode).collection('members').doc(uid).get();
          pub = fresh.data()?.pubKey || null;
        } catch {}
      }
    }
    const fp = await _pubKeyFingerprint(pub);
    fpEl.textContent = fp || 'Not available yet — they may not have sent a signed message';
  })();

  // Actions — admin viewers only, never shown for your own row
  const actions = $('md-actions');
  actions.innerHTML = '';
  if (_isAdmin && !isMe) {
    if (!m.approved && !m.declined) {
      actions.appendChild(_mdBtn('APPROVE', () => { approveUser(uid, m.name); closeMemberDetail(); }));
      actions.appendChild(_mdBtn('DECLINE', () => { declineUser(uid, m.name); closeMemberDetail(); }, true));
    } else {
      actions.appendChild(_mdBtn(
        m.role === 'admin' ? 'DEMOTE TO MEMBER' : 'PROMOTE TO ADMIN',
        () => { (m.role === 'admin' ? demoteMember : promoteToAdmin)(uid, m.name); closeMemberDetail(); }
      ));
    }
    if (!m.blocked) {
      actions.appendChild(_mdBtn('BLOCK USER', () => { blockMember(uid, m.name); closeMemberDetail(); }, true));
    }
  }

  overlay.style.display = 'flex';
}

function _mdBtn(label, onClick, danger) {
  const btn = document.createElement('button');
  btn.className = 'md-action-btn' + (danger ? ' danger' : '');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function closeMemberDetail() {
  const overlay = $('member-detail-modal');
  if (overlay) overlay.style.display = 'none';
  _mdCurrentUid = null;
}

function updateAdminBadge() {
  const badge = $('my-admin-badge');
  if (!badge) return;
  badge.style.display = _isAdmin ? 'flex' : 'none';
}

function startRoomListener() {
  if (_unsubRoom) { try { _unsubRoom(); } catch {} _unsubRoom = null; }
  _unsubRoom = db.collection('rooms').doc(state.roomCode)
    .onSnapshot(snap => {
      if (!snap.exists) {
        // Room doc is gone — either it expired or an admin used "Clean Up
        // Now". Previously this case was silently ignored, leaving anyone
        // still viewing stuck on a dead room with no explanation.
        if (state.roomCode) {
          toast('Room closed', 'This room no longer exists.', 'clock');
          const code = state.roomCode;
          stopListeners();
          clearCacheForRoom(code).catch(() => {});
          localStorage.removeItem(CONFIG.SESSION_KEY);
          localStorage.removeItem(CONFIG.ROOM_KEY);
          state.me = null; state.roomCode = null;
          showScreen('join-screen');
        }
        return;
      }
      const d = snap.data() || {};
      // Epoch rotation
      const newEpoch = d.epoch || 0;
      if (newEpoch > _roomEpoch) {
        _roomEpoch = newEpoch;
        toast('Encryption key rotated', `Epoch ${newEpoch} — new messages use a fresh key`, 'key');
      }
      // Message TTL — 0 = off, otherwise milliseconds
      const newTtl = (d.msgTtlMs || 0);
      if (newTtl !== _roomTtlMs) {
        _roomTtlMs = newTtl;
        const ttlEl = $('ttl-display');
        if (ttlEl) ttlEl.textContent = _fmtTtl(_roomTtlMs);
      }
      // Room expiry (how long the room persists after everyone leaves) —
      // -1 = never, 0 = instant, otherwise milliseconds. Falls back to 5 min
      // for older rooms that predate this being a stored/configurable field.
      const newRoomExpiry = d.inactivityTtlMs !== undefined ? d.inactivityTtlMs : 300000;
      if (newRoomExpiry !== _roomExpiryMs) {
        _roomExpiryMs = newRoomExpiry;
        const rTtlEl = $('room-ttl-sublabel');
        if (rTtlEl) rTtlEl.textContent = _fmtRoomExpirySentence(_roomExpiryMs);
      }
    }, () => {});
}

// ─── Silent auto epoch rotation (admin only) ─────────────────────────────────
// ─── Session HMAC — local integrity token ────────────────────────────────────
// Generates a per-session HMAC key used to sign state.me locally.
// Prevents a memory-patching attacker from changing their UID/role mid-session
// without being caught on the next heartbeat.
async function _initSessionHmac() {
  try {
    _sessionHmacKey = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    );
  } catch { _sessionHmacKey = null; }
}

async function _signSession(me) {
  if (!_sessionHmacKey || !me) return null;
  try {
    const buf = new TextEncoder().encode(`${me.id}|${me.role}|${me.joinedAt}`);
    const sig = await crypto.subtle.sign('HMAC', _sessionHmacKey, buf);
    return _b64uEnc(sig);
  } catch { return null; }
}

async function _verifySession(me, token) {
  if (!_sessionHmacKey || !me || !token) return true; // no key = skip check
  try {
    const buf = new TextEncoder().encode(`${me.id}|${me.role}|${me.joinedAt}`);
    return await crypto.subtle.verify('HMAC', _sessionHmacKey, _b64uDec(token), buf);
  } catch { return false; }
}

// ─── Canary injection detector ────────────────────────────────────────────────
// Every docId seen from Firestore is registered. If a message is re-delivered
// with the same docId but different content, it's a replay/injection attack.
const _canaryMap = _lruMap(500); // docId → content hash
async function _registerCanary(docId, enc) {
  if (!docId || !enc) return;
  const hash = _b64uEnc(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(docId + enc)));
  if (_canaryMap.has(docId) && _canaryMap.get(docId) !== hash) {
    _integrityViolations++;
    _log('warn', '[MIUT Security] Replay/injection detected on doc', docId);
    if (_integrityViolations >= 3) _triggerSecurityLockdown('replay attack detected');
    return false;
  }
  _canaryMap.set(docId, hash);
  return true;
}

// ─── Security lockdown ────────────────────────────────────────────────────────
function _triggerSecurityLockdown(reason) {
  console.error('[MIUT Security] Lockdown triggered:', reason);
  toast('Security alert', 'Suspicious activity detected — connection closed.', 'alert');
  setTimeout(() => {
    // Clear all state, stop all listeners, return to join screen
    if (typeof handleLogout === 'function') handleLogout();
    else { localStorage.clear(); location.reload(); }
  }, 2000);
}

// ─── Anti-screenshot (screen capture API detection) ───────────────────────────
function _initAntiCapture() {
  document.body.setAttribute('data-sensitive', '1');
  // Delegate to security.js screen protection — guard against double-init
  if (typeof initScreenProtection === 'function' && !document.body.dataset.spInit) {
    try {
      document.body.dataset.spInit = '1';
      initScreenProtection({ username: (state.me?.name || 'ANONYMOUS').toUpperCase() });
    } catch (_e) {}
  } else if (typeof setScreenProtectionUsername === 'function' && document.body.dataset.spInit) {
    try { setScreenProtectionUsername(state.me?.name || 'ANONYMOUS'); } catch {}
  }
}

// ─── Message expiry sweep ─────────────────────────────────────────────────────
// Removes messages from the DOM (not Firestore) after their TTL expires.
// TTL is set per-message by the sender; admin can set room-level default.
let _roomTtlMs = 0; // 0 = no expiry
// Required Firestore Security Rule for message TTL (auto-vanish) deletion —
// this must allow ANY current room member to delete ANY message once it's
// past its TTL, not just the message's own sender or an admin. Automatic
// expiry is triggered by whichever client happens to notice it first
// (the sweep below, or fetchHistoryOnce catching an already-expired
// message at load time) — it is never necessarily the original sender's
// own client, since that person may have left long before the TTL lapsed.
// A rule scoped to sender-or-admin-only will silently reject these
// deletes, which is exactly what makes an "expired" message reappear on
// every future reload despite looking gone locally.
//
//   match /rooms/{roomCode}/messages/{messageId} {
//     allow delete: if
//       // the room has a msgTtlMs set, AND
//       get(/databases/$(database)/documents/rooms/$(roomCode)).data.msgTtlMs > 0
//       // the message is actually past that TTL (createdAt + msgTtlMs <= now), AND
//       && request.time > timestamp.value(resource.data.createdAt.toMillis() + get(/databases/$(database)/documents/rooms/$(roomCode)).data.msgTtlMs)
//       // the requester is a current member of the room (not an outsider)
//       && exists(/databases/$(database)/documents/rooms/$(roomCode)/members/$(request.auth.uid));
//     // (combine with your existing sender/admin-based delete rule for
//     // manual "Delete Message" — this is strictly additive, not a replacement)
//   }
function _startExpirySweep() {
  if (_expiryTimer) clearInterval(_expiryTimer);
  _expiryTimer = setInterval(_runExpirySweep, 5000); // check every 5s for accurate countdowns
}

function _runExpirySweep() {
  if (!_roomTtlMs || !state.roomCode) return;
  const now = Date.now();
  // Includes .msg-system now too — see renderMsg's system-message branch
  // for why (they used to have no data-ts at all and were invisible here).
  document.querySelectorAll('.msg-wrapper[data-ts], .msg-system[data-ts]').forEach(w => {
    const ts    = parseInt(w.dataset.ts  || '0', 10);
    const docId = w.dataset.docId || '';
    if (!ts) return;
    const age     = now - ts;
    const timeLeft = _roomTtlMs - age;

    if (timeLeft <= 0) {
      // ── Expired: remove from DOM and delete from Firestore ─────────────
      w.style.transition = 'opacity .4s, transform .4s';
      w.style.opacity    = '0';
      w.style.transform  = 'scale(.92)';
      setTimeout(() => w.remove(), 420);

      // Delete from Firestore. Logged on failure now — this used to be a
      // truly silent fire-and-forget, so a rejected delete (most likely a
      // Firestore rule that only allows a message's own sender, or an
      // admin, to delete it — which doesn't line up with "anyone's client
      // can trigger automatic TTL expiry") left the message permanently
      // undeletable with zero visible indication why, and it would keep
      // reappearing on every future history load. See the rule note below.
      if (docId && db && state.roomCode) {
        db.collection('rooms').doc(state.roomCode)
          .collection('messages').doc(docId)
          .delete()
          .then(() => _log('debug', '[MIUT ttl] expired message deleted:', docId))
          .catch(e => _log('warn', '[MIUT ttl] expired message delete REJECTED — it will reappear on reload until this succeeds. Check Firestore rules allow TTL-based deletion by any room member, not just the sender/admin:', docId, e));
      }
      return;
    }

    // ── Still alive: update progress bar (replaces text timer) ─────────
    if (timeLeft < 10000) w.dataset.expiring = '1';
    else delete w.dataset.expiring;
    // Progress bar: width = timeLeft / total * 100%
    let bar  = w.querySelector('.msg-ttl-bar');
    if (!bar) {
      bar = document.createElement('div'); bar.className = 'msg-ttl-bar';
      const fill = document.createElement('div'); fill.className = 'msg-ttl-fill';
      bar.appendChild(fill);
      const inner = w.querySelector('.msg-inner');
      if (inner) inner.after(bar);
    }
    const fill = bar.querySelector('.msg-ttl-fill');
    if (fill) {
      const pct = Math.max(0, (timeLeft / _roomTtlMs) * 100);
      fill.style.width = pct + '%';
      fill.style.background = pct < 20 ? 'var(--danger)' : pct < 50 ? '#f7c430' : 'var(--teal)';
    }
    w.querySelector('.msg-ttl-timer')?.remove(); // remove old text timer if present
  });
}

// ─── Message TTL helpers ──────────────────────────────────────────────────────
/** Format a TTL in ms to a human label */
function _fmtTtl(ms) {
  if (!ms) return 'Off';
  if (ms < 60000)       return Math.round(ms / 1000) + 's';
  if (ms < 3600000)     return Math.round(ms / 60000) + 'm';
  if (ms < 86400000)    return Math.round(ms / 3600000) + 'h';
  return Math.round(ms / 86400000) + 'd';
}

/** Admin sets room-level message TTL and writes to Firestore */
async function setRoomTtl(ms) {
  if (!_isAdmin || !state.roomCode) return;
  try {
    await db.collection('rooms').doc(state.roomCode).update({ msgTtlMs: ms });
    _roomTtlMs = ms;
    const ttlEl = $('ttl-display');
    if (ttlEl) ttlEl.textContent = _fmtTtl(ms);
    toast(
      ms ? `Messages expire after ${_fmtTtl(ms)}` : 'Message expiry off',
      ms ? 'Old messages will fade from view automatically.' : 'Messages stay until the room closes.',
      ms ? 'clock' : '∞'
    );
  } catch (e) { toast('Failed to set expiry', e.message, 'err'); }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Room expiry — how long the room persists after it becomes EMPTY (no
// one online), not general inactivity. Admin-configurable. Value scheme:
//   0   = Instant — deleted the moment the last person leaves
//   >0  = milliseconds to wait, once empty, before auto-deleting
//   -1  = Never — the room is never auto-deleted for being empty
// See startPresenceListener for where this is actually acted on.
let _roomExpiryMs = 300000; // 5 min default, matches the room's own baseline at creation

/** Format a room-expiry ms value to a human label. */
function _fmtRoomTtl(ms) {
  if (ms === -1) return 'Never';
  if (ms === 0)  return 'Instant';
  if (ms < 3600000)  return Math.round(ms / 60000) + ' min';
  if (ms < 86400000) return Math.round(ms / 3600000) + ' hour' + (ms === 3600000 ? '' : 's');
  return Math.round(ms / 86400000) + ' day' + (ms === 86400000 ? '' : 's');
}

/** Full sentence version for the settings sublabel — reads correctly for
 * every value instead of just substituting a word into a fixed template. */
function _fmtRoomExpirySentence(ms) {
  if (ms === -1) return 'Never auto-deletes — the room persists indefinitely';
  if (ms === 0)  return 'Auto-deletes instantly once everyone leaves';
  return `Auto-deletes ${_fmtRoomTtl(ms)} after everyone leaves`;
}

/**
 * Admin sets how long the room persists after everyone leaves. This only
 * saves the preference — it does NOT touch autoDeleteAt itself, since the
 * room is presumably occupied right now (the admin is in Settings using
 * it). The actual expiry countdown starts when the room is later detected
 * as empty; see startPresenceListener.
 */
async function setRoomExpiry(ms) {
  if (!_isAdmin || !state.roomCode) return;
  try {
    await db.collection('rooms').doc(state.roomCode).update({ inactivityTtlMs: ms });
    _roomExpiryMs = ms;
    const rTtlEl = $('room-ttl-sublabel');
    if (rTtlEl) rTtlEl.textContent = _fmtRoomExpirySentence(ms);
    toast(
      ms === -1 ? 'Room expiry off' : `Room auto-deletes ${ms === 0 ? 'instantly' : _fmtRoomTtl(ms) + ' after'} everyone leaves`,
      ms === -1 ? 'This room will never auto-delete.' : 'Takes effect next time the room is empty.',
      ms === -1 ? '∞' : 'clock'
    );
  } catch (e) { toast('Failed to set room expiry', e.message, 'err'); }
}
// ─────────────────────────────────────────────────────────────────────────────

// Required Firestore Security Rule for epoch rotation — this repo doesn't
// commit a firestore.rules file (see the /feedback rule comment elsewhere
// in this file for why), so add this in the Firebase Console. It MUST key
// off the room's members subcollection role, not a fixed creatorId,
// because admin can be handed off (see _handoffAdminRole) — a rule that
// only allows request.auth.uid == resource.data.creatorId to write `epoch`
// will silently reject a handed-off admin's rotation attempts:
//
//   match /rooms/{roomCode} {
//     allow update: if request.resource.data.diff(resource.data)
//         .affectedKeys().hasOnly(['epoch'])
//       ? exists(/databases/$(database)/documents/rooms/$(roomCode)/members/$(request.auth.uid))
//         && get(/databases/$(database)/documents/rooms/$(roomCode)/members/$(request.auth.uid)).data.role == 'admin'
//       : true; // other room-doc updates keep whatever rule they already have
//   }
async function _autoRotateEpoch(reason) {
  if (!_isAdmin || !state.roomCode || !db) return;
  try {
    const newEpoch = _roomEpoch + 1;
    await db.collection('rooms').doc(state.roomCode).update({ epoch: newEpoch });
    _roomEpoch = newEpoch;
    _msgsSinceEpoch = 0;
    await sendSys(`Key auto-rotated 🔑 (${reason}) — epoch ${newEpoch} active`);
  } catch (e) {
    // This used to fail completely silently. Auto-rotation on a member
    // leaving is the ONLY mechanism this app has for cutting off a departed
    // member's ability to decrypt future messages — there's no separate
    // kick/block feature. A silent failure here means that protection can
    // quietly stop working with zero indication, which is a real security
    // gap, not just a missed feature. Surface it instead:
    _log('warn', `[MIUT] Epoch auto-rotation failed (${reason}):`, e);
    // Likely cause: Firestore security rules restricting the epoch field
    // update to the room's original creatorId rather than "whoever
    // currently holds the admin role" — a handed-off admin would get
    // silently rejected. If you see this warning, check that your rules
    // allow epoch updates for any member whose role == 'admin', not just
    // request.auth.uid == resource.data.creatorId.
    toast('Key rotation failed', 'Encryption key did not auto-rotate — check console for details.', 'err');
  }
}
// ─────────────────────────────────────────────────────────────────────────────

async function rotateKey() {
  if (!_isAdmin || !state.roomCode) return;
  const ok = await showConfirm(
    'Rotate Encryption Key?',
    'Future messages will use a freshly derived key. Old messages remain readable with their original key. All members will be notified.',
    'ROTATE'
  );
  if (!ok) return;
  const newEpoch = _roomEpoch + 1;
  try {
    await db.collection('rooms').doc(state.roomCode).update({ epoch: newEpoch });
    _roomEpoch = newEpoch;
    await sendSys(`Encryption key rotated — epoch ${newEpoch} is now active`);
    toast('Key rotated', `Epoch ${newEpoch} now active`, 'key');
  } catch(e) { toast('Rotation failed', e.message, 'err'); }
}
async function loadCachedMessages() {
  const code = state.roomCode;
  _historyOldestDoc  = null;
  _historyExhausted  = false;

  // ── Phase 1: render from IDB instantly ──────────
  try {
    const cached = await loadCached(code);
    if (cached.length) {
      $('msg-skeleton')  && ($('msg-skeleton').style.display  = 'none');
      $('room-welcome')  && ($('room-welcome').style.display  = 'none');
      cached.forEach(row => {
        _renderedIds.add(row.id);
        renderMsg(row.data, row.id);
      });
      _lastCachedTs = cached.reduce((m, r) => Math.max(m, r.ts || 0), 0);
      scrollBottom();
    }
  } catch (e) {}

  // ── Phase 2: fetch only messages newer than IDB high-water mark ──
  await fetchHistoryOnce(code);

  // After fetch, skeleton always goes away; welcome shows only if truly empty
  $('msg-skeleton') && ($('msg-skeleton').style.display = 'none');
  if (!_renderedIds.size) {
    $('room-welcome') && ($('room-welcome').style.display = '');
  }
}
const _HISTORY_PAGE = 100;
let _historyOldestDoc = null;   // cursor for "load earlier" pagination
let _historyExhausted = false;  // true once we've fetched back to the beginning

async function fetchHistoryOnce(code) {
  try {
    let q = db.collection('rooms').doc(code)
              .collection('messages')
              .orderBy('createdAt', 'desc')   // newest first so limit(100) gets latest
              .limit(_HISTORY_PAGE);

    if (_lastCachedTs > 0) {
      q = db.collection('rooms').doc(code)
            .collection('messages')
            .orderBy('createdAt', 'asc')
            .where('createdAt', '>', firebase.firestore.Timestamp.fromMillis(_lastCachedTs));
    }

    const snap = await q.get();
    if (snap.empty) { _historyExhausted = true; return; }

    // Re-sort ascending for rendering (query returned desc for new users)
    const docs = _lastCachedTs > 0 ? snap.docs : [...snap.docs].reverse();

    // Track oldest doc for "load earlier" pagination cursor
    if (!_lastCachedTs && docs.length > 0) {
      _historyOldestDoc = docs[0];
      _historyExhausted = docs.length < _HISTORY_PAGE;
    }

    let hasNew = false;
    for (const doc of docs) {
      if (_renderedIds.has(doc.id)) continue;
      const data = doc.data();
      // Message TTL (per-message auto-vanish) can lapse while nobody's in
      // the room to run the periodic sweep (_runExpirySweep only acts on
      // messages already rendered in a live DOM). Without this check, an
      // already-expired message would render anyway on next load — visible
      // for a few seconds until the sweep caught up, or indefinitely if its
      // sweep-triggered delete() ever silently failed (e.g. a Firestore
      // rule rejecting it). Catch it here too: skip rendering AND delete it
      // right away, so history load itself is a second, independent
      // enforcement point, not just the interval sweep.
      if (_roomTtlMs && data.ts && (Date.now() - data.ts) >= _roomTtlMs) {
        _renderedIds.add(doc.id); // prevent any other path from rendering it either
        db.collection('rooms').doc(code).collection('messages').doc(doc.id).delete()
          .then(() => _log('debug', '[MIUT ttl] purged already-expired message found at history load:', doc.id))
          .catch(e => _log('warn', '[MIUT ttl] failed to delete an already-expired message — it will keep reappearing until this succeeds:', doc.id, e));
        continue;
      }
      _renderedIds.add(doc.id);
      $('msg-skeleton') && ($('msg-skeleton').style.display = 'none'); $('room-welcome')?.style && ($('room-welcome').style.display = 'none');
      // Awaited deliberately — renderMsg is async (it awaits decryption
      // before appending to the DOM). Firing these off unawaited inside a
      // loop let each message's decrypt finish in a different order than it
      // was sent, scrambling history order for anyone loading a room fresh.
      await renderMsg(data, doc.id);
      hasNew = true;
      // Defer IDB write to idle time — doesn't block rendering
      (window.requestIdleCallback || setTimeout)(() => cacheMsg(doc.id, code, data).catch(() => {}));
      const docTs = data.createdAt?.toMillis?.() ?? data.ts ?? 0;
      if (docTs > _lastCachedTs) _lastCachedTs = docTs;
    }

    if (hasNew) scrollBottom();

    // Show "load earlier" button if there are more messages
    if (!_lastCachedTs) _updateLoadEarlierBtn();

    // Backfill any image/video whose chunks straddled this page's boundary
    _healIncompleteChunkGroups().catch(() => {});
  } catch (e) {
  }
}

// "Load earlier messages" — fetches the page before the current oldest message
async function loadEarlierMessages() {
  if (_historyExhausted || !_historyOldestDoc || !state.roomCode) return;
  const btn = $('load-earlier-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  try {
    const snap = await db.collection('rooms').doc(state.roomCode)
      .collection('messages')
      .orderBy('createdAt', 'desc')
      .startAfter(_historyOldestDoc)
      .limit(_HISTORY_PAGE)
      .get();

    if (snap.empty) { _historyExhausted = true; _updateLoadEarlierBtn(); return; }

    const docs = [...snap.docs].reverse(); // render in chronological order
    _historyOldestDoc = snap.docs[snap.docs.length - 1]; // new oldest cursor
    _historyExhausted = snap.docs.length < _HISTORY_PAGE;

    const area = $('messages-area');
    const prevScrollHeight = area?.scrollHeight ?? 0;
    // Fixed reference to the current oldest rendered message — every message
    // in this older batch gets inserted right before it, in ascending order,
    // so the batch lands correctly above without needing to re-look-up a
    // moving "first child" target on each iteration.
    const boundaryEl = area?.querySelector('.msg-wrapper, .msg-system') || null;

    for (const doc of docs) {
      if (_renderedIds.has(doc.id)) continue;
      const data = doc.data();
      _renderedIds.add(doc.id);
      await renderMsg(data, doc.id, boundaryEl); // sequential — see fetchHistoryOnce note
      cacheMsg(doc.id, state.roomCode, data).catch(() => {});
    }

    // Preserve scroll position after prepending
    if (area) area.scrollTop += (area.scrollHeight - prevScrollHeight);

    // Backfill any image/video whose chunks straddled this page's boundary
    _healIncompleteChunkGroups().catch(() => {});
  } catch (e) {
  } finally {
    _updateLoadEarlierBtn();
  }
}

function _updateLoadEarlierBtn() {
  let btn = $('load-earlier-btn');
  if (_historyExhausted) {
    btn?.remove(); return;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'load-earlier-btn';
    btn.className = 'load-earlier-btn';
    btn.addEventListener('click', loadEarlierMessages);
    $('messages-area')?.prepend(btn);
  }
  btn.disabled = false;
  btn.textContent = '↑ Load earlier messages';
}

function startPresenceListener() {
  const code = state.roomCode;
  if (_unsubMembers) _unsubMembers();

  _unsubMembers = db.collection('rooms').doc(code)
    .collection('members').where('online', '==', true)
    .onSnapshot(async snap => {
      _onlineCount = snap.size;

      // Notify admin of new pending users
      if (_isAdmin) {
        snap.docChanges().forEach(ch => {
          if (ch.type === 'added') {
            const d = ch.doc.data();
            if (!d.approved && ch.doc.id !== state.me?.id) {
              playSound('receive');
              toast(`${d.name || 'Someone'} wants to join`, 'Open the sidebar to approve them', 'user');
            }
          }
        });
      }

      // Auto-rotate key when an approved member goes offline (forward secrecy).
      // Deliberately NOT nested inside the `if (_isAdmin)` block above — that
      // outer gate meant that when _isAdmin was false for any reason, this
      // whole check (and its diagnostics) never even ran, making a real
      // failure here indistinguishable from "admin status wasn't detected
      // yet." Instrumented with console.debug at every branch — if this
      // stops firing again, check devtools console for exactly which
      // condition failed rather than guessing blind.
      snap.docChanges().forEach(ch => {
        if (ch.type !== 'removed') return;
        const d = ch.doc.data();
        _log('debug', '[MIUT epoch] member went offline:', ch.doc.id, {
          approved: d.approved, isMine: ch.doc.id === state.me?.id,
          _presenceSettled, _isAdmin, blocked: d.blocked,
        });
        if (!_presenceSettled) {
          _log('debug', '[MIUT epoch] skip rotate: _presenceSettled is false (first snapshot after (re)subscribing — see startPresenceListener)');
        } else if (!_isAdmin) {
          _log('debug', '[MIUT epoch] skip rotate: this client is not currently admin');
        } else if (ch.doc.id === state.me?.id) {
          _log('debug', '[MIUT epoch] skip rotate: this is my own doc going offline, not someone else leaving');
        } else if (!d.approved) {
          _log('debug', '[MIUT epoch] skip rotate: departing member was not approved (or was just blocked, which force-rotates separately)');
        } else {
          _log('debug', '[MIUT epoch] rotating now — all conditions met');
          _autoRotateEpoch('member left').catch(() => {});
        }
      });

      updateOnlineUI();   // updateOnlineUI also called inside renderMembers with correct approved count
      renderMembers(snap);

      // Wipe empty room when last member leaves.
      // _presenceSettled guards against the very first snapshot firing before
      // the current user's online:true has propagated — without it, session
      // restore sees count=0 and wipes a perfectly healthy room.
      // Only wipe if NO approved members exist at all (not just online ones)
      // so offline-but-approved members don't lose their room.
      // Count truly-online members: online:true AND heartbeat within 90s
      const _staleMs = Date.now() - 90000;
      let _realOnlineCount = 0;
      snap.docs.forEach(d => {
        const md = d.data();
        if (!md.online) return;
        const hb = md.lastSeen?.toMillis ? md.lastSeen.toMillis() : (md.lastSeen || 0);
        if (hb > _staleMs) _realOnlineCount++;
      });

      if (_presenceSettled && _realOnlineCount === 0 && state.me) {
        await _handleRoomBecameEmpty(code);
      } else if (_realOnlineCount > 0 && _roomWasEmpty) {
        // Someone (re)joined before the empty-room countdown fired — rescue
        // the room by clearing the pending schedule, otherwise it could get
        // deleted out from under whoever just came back.
        _roomWasEmpty = false;
        // Explicit null rather than FieldValue.delete() — keeps the field
        // present for schema consistency across rooms. Firestore's `<=`
        // range queries (like the cleanup cron's) never match null, so
        // this is exactly as safe as deleting the field outright.
        db.collection('rooms').doc(code).update({
          emptyAt: null,
          autoDeleteAt: null,
        }).catch(() => {});
      }
      _presenceSettled = true;
    }, () => {});
}

/**
 * Decides what happens when a room is detected as empty (no one online),
 * per the admin's Room Expiry setting. Called from two places:
 *
 *   1. startPresenceListener, above — reactive: some OTHER still-connected
 *      client notices everyone else went offline.
 *   2. handleLogout, directly — proactive, and this is the one that
 *      actually matters most: if you're the LAST person leaving, your own
 *      client tearing down its listeners (as part of closing instantly —
 *      see handleLogout) means nobody's presence listener is left running
 *      to ever notice the room emptied. Relying solely on (1) meant the
 *      single most common case — the last person leaving normally — never
 *      triggered any expiry at all, which is exactly why "Instant" and
 *      every other Room Expiry setting appeared to silently not work.
 *      Calling this directly from the leaving client, before it tears down,
 *      closes that gap.
 */
async function _handleRoomBecameEmpty(code) {
  if (!code || !db) return;
  try {
    const allApproved = await db.collection('rooms').doc(code)
      .collection('members').where('approved', '==', true).get();
    const roomRef = db.collection('rooms').doc(code);
    if (allApproved.empty) {
      // Room was abandoned before anyone was ever properly approved —
      // wipe immediately regardless of the Room Expiry setting. Guard
      // against two clients/tabs both trying this at once: the first to
      // set emptyAt wins.
      let shouldWipe = false;
      try {
        await db.runTransaction(async tx => {
          const txSnap = await tx.get(roomRef);
          if (!txSnap.exists) return;
          if (txSnap.data()?.emptyAt) return; // another tab already won
          tx.update(roomRef, { emptyAt: ts_now() });
          shouldWipe = true;
        });
      } catch (_txErr) {
        // Transaction denied (non-admin member) — try direct update.
        // Firestore rules allow creatorId to set emptyAt without admin doc.
        try {
          const freshSnap = await roomRef.get();
          if (freshSnap.exists && !freshSnap.data()?.emptyAt) {
            await roomRef.update({ emptyAt: ts_now() });
            shouldWipe = true;
          }
        } catch (_e2) { /* fail open */ }
      }
      if (shouldWipe) {
        await wipeRoom(code, db);
        await clearCacheForRoom(code);
      }
    } else if (!_roomWasEmpty) {
      // There ARE approved members — they've just all gone offline right
      // now. This is the "room emptied out" moment the configured Room
      // Expiry setting counts from (see setRoomExpiry / _roomExpiryMs):
      //   -1 (Never)   → leave the room alone entirely
      //    0 (Instant) → wipe it right now, same as the fully-abandoned case
      //   >0            → schedule autoDeleteAt for that many ms from now;
      //                    the existing cleanup cron (functions/api/cleanup.js)
      //                    picks it up naturally once that time passes
      _roomWasEmpty = true;
      if (_roomExpiryMs === -1) {
        // never — nothing to schedule
      } else if (_roomExpiryMs === 0) {
        let shouldWipe = false;
        try {
          await db.runTransaction(async tx => {
            const txSnap = await tx.get(roomRef);
            if (!txSnap.exists) return;
            if (txSnap.data()?.emptyAt) return;
            tx.update(roomRef, { emptyAt: ts_now() });
            shouldWipe = true;
          });
        } catch { /* another tab likely won, or denied — skip */ }
        if (shouldWipe) {
          await wipeRoom(code, db);
          await clearCacheForRoom(code);
        }
      } else {
        let scheduled = false;
        const newAutoDeleteAt = firebase.firestore.Timestamp.fromMillis(Date.now() + _roomExpiryMs);
        try {
          await db.runTransaction(async tx => {
            const txSnap = await tx.get(roomRef);
            if (!txSnap.exists) return;
            if (txSnap.data()?.emptyAt) return;
            tx.update(roomRef, { emptyAt: ts_now(), autoDeleteAt: newAutoDeleteAt });
            scheduled = true;
          });
        } catch (_txErr) {
          try {
            const freshSnap = await roomRef.get();
            if (freshSnap.exists && !freshSnap.data()?.emptyAt) {
              await roomRef.update({ emptyAt: ts_now(), autoDeleteAt: newAutoDeleteAt });
              scheduled = true;
            }
          } catch (_e2) { /* fail open — worst case the room just doesn't get an expiry set this time */ }
        }
        if (!scheduled) { /* another tab already scheduled it, or write was denied — nothing more to do */ }
      }
    }
  } catch { /* silently skip on error */ }
}

function updateOnlineUI() {
  const oc = $('online-count');
  const ms = $('member-status-text');
  const sh = $('solo-hint');
  if (_onlineCount <= 1) {
    if (oc) oc.textContent = '';
    if (ms) ms.textContent = 'Only you are online';
    if (sh) sh.style.display = 'flex';
  } else {
    if (oc) oc.textContent = _onlineCount;
    if (ms) ms.textContent = `${_onlineCount} members online`;
    if (sh) sh.style.display = 'none';
  }
  // Update header status with live count
  const statusEl = document.querySelector('.chat-status');
  if (statusEl) {
    if (_onlineCount > 1) {
      statusEl.innerHTML = '<span style="display:inline-flex;align-items:center;gap:5px">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:var(--online);display:inline-block;box-shadow:0 0 5px var(--online)"></span>' +
        _onlineCount + ' online</span>';
    } else {
      statusEl.innerHTML = '<span style="display:inline-flex;align-items:center;gap:5px">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:var(--teal);display:inline-block"></span>' +
        'Encrypted · E2E</span>';
    }
  }
}

function startChatListeners() {
  const code = state.roomCode;

  // Messages — only NEW since history fetch set _lastCachedTs
  if (_unsubMsgs) _unsubMsgs();
  let q = db.collection('rooms').doc(code).collection('messages').orderBy('createdAt', 'asc');
  // Always filter by _lastCachedTs — fetchHistoryOnce ensures this is accurate.
  // Fall back to "last 5 minutes" if somehow still 0 to avoid a full re-read.
  const since = _lastCachedTs > 0 ? _lastCachedTs : (Date.now() - 5 * 60 * 1000);
  q = q.where('createdAt', '>', firebase.firestore.Timestamp.fromMillis(since));

  _unsubMsgs = q.onSnapshot(snap => {
    // Processed as a sequential async IIFE (not .forEach(async ...)) so a
    // batch of several messages arriving in one snapshot — e.g. catching up
    // after being briefly offline — renders in the order they were sent
    // instead of whichever order each one's decrypt happens to finish in.
    (async () => {
      let hasNew = false;
      for (const ch of snap.docChanges()) {
        if (ch.type === 'modified') { patchMsg(ch.doc.id, ch.doc.data()); continue; }
        if (ch.type !== 'added') continue;
        const id = ch.doc.id, data = ch.doc.data();
        // Own messages sent via sendMessage() are already rendered optimistically
        // and reconciled into _renderedIds before this snapshot fires (see
        // _reconcileSentMessage) — skip re-rendering them, but still cache and
        // advance _lastCachedTs so history/offline state stays correct.
        let alreadyRendered = _renderedIds.has(id);
        // Race guard: this snapshot can in rare cases arrive before the add()
        // promise above resolves. If so, reconcile against the still-pending
        // optimistic bubble instead of rendering a duplicate.
        if (!alreadyRendered && data.senderId === state.me?.id && data.ts && _pendingByTs.has(data.ts)) {
          const _localId = _pendingByTs.get(data.ts);
          _pendingByTs.delete(data.ts);
          _pendingMsgPayloads.delete(_localId);
          _reconcileSentMessage(_localId, id, data);
          alreadyRendered = true;
        }
        if (!alreadyRendered) {
          // Canary check — detect replay/injection (async, non-blocking)
          _registerCanary(id, data.enc || data.encData || '').catch(() => {});
          _renderedIds.add(id);
          // PART 8: replay protection — reject stale or duplicate messages
          const _msgTs = data.ts || 0;
          if (_msgTs && typeof validateMessageTimestamp === 'function' && !validateMessageTimestamp(_msgTs)) {
            // stale message outside replay window — skip render
          } else {
            if (typeof trackNonce === 'function' && !trackNonce(id)) {
              // exact duplicate nonce — skip render
            } else {
              $('msg-skeleton') && ($('msg-skeleton').style.display = 'none'); $('room-welcome')?.style && ($('room-welcome').style.display = 'none');
              // PART 5: afterReceive hook
              let _rcvPayload = { id, data };
              if (typeof runHooks === 'function') _rcvPayload = await runHooks('afterReceive', _rcvPayload);
              await renderMsg(_rcvPayload.data || data, _rcvPayload.id || id);
            } // end trackNonce
          } // end validateMessageTimestamp
          hasNew = true;
        }
        const docTs = data.ts || 0;
        if (docTs > _lastCachedTs) _lastCachedTs = docTs;
        cacheMsg(id, code, data).catch(() => {});
        // Message-count-based epoch rotation (admin only). This counts
        // every genuine new message in the room — not just ones this
        // client itself sent, which was the previous behavior. That meant
        // an admin who wasn't the most active chatter could go long past
        // the intended 25-message threshold without ever rotating, since
        // the counter only advanced on the admin's own successful sends.
        // Skips system messages and file chunks (a single image/video
        // would otherwise inflate the count by however many pieces it was
        // split into).
        if (_isAdmin && data.type !== 'system' && data.type !== 'chunk') {
          _msgsSinceEpoch++;
          if (_msgsSinceEpoch >= _AUTO_EPOCH_MSG_COUNT) {
            _autoRotateEpoch('message limit').catch(() => {});
          }
        }
        if (!alreadyRendered && data.type === 'text' && data.senderId !== state.me?.id) {
          playSound('receive');
          // Queue read receipt for incoming text messages
          if (!document.hidden) _queueReadAck(id);
          if (document.hidden) {
            _unreadCount++;
            document.title = `(${_unreadCount}) MIUT`;
          }
          showScrollFab();
        }
      }
      if (hasNew) { scrollBottom(); setTimeout(_markVisibleAsRead, 300); }
    })();
  }, () => {});
  // Typing
  if (_unsubTyping) _unsubTyping();
  _unsubTyping = db.collection('rooms').doc(code).collection('typing')
    .onSnapshot(snap => {
      const now = Date.now(), typers = [];
      snap.forEach(doc => {
        if (doc.id === state.me?.id) return;
        const d = doc.data();
        if (now - (d.ts || 0) < CONFIG.TYPING_EXPIRE_MS) typers.push(d.name || 'Someone');
      });
      showTypingUI(typers);
    }, () => {});

  updateOnlineUI();
}

function stopChatListeners() {
  if (_unsubMsgs)    { try { _unsubMsgs();    } catch {} _unsubMsgs    = null; }
  if (_unsubTyping)  { try { _unsubTyping();  } catch {} _unsubTyping  = null; }
  clearMyTyping();
  showTypingUI([]);
}

function startListeners() {
  startPresenceListener();
  startChatListeners();
}

function stopListeners() {
  stopChatListeners();
  if (_unsubMembers) { try { _unsubMembers(); } catch {} _unsubMembers = null; }
  if (_unsubRoom)    { try { _unsubRoom();    } catch {} _unsubRoom    = null; }
}

function showTypingUI(typers) {
  const el = $('typing-indicator'), txt = $('typing-text');
  if (!el) return;
  if (!typers.length) {
    el.classList.remove('visible');
    setTimeout(() => { if (!el.classList.contains('visible')) el.style.display = 'none'; }, 300);
    return;
  }
  txt && (txt.textContent =
    typers.length === 1   ? `${typers[0]} is typing…` :
    typers.length === 2   ? `${typers[0]} and ${typers[1]} are typing…` :
                            `${typers.length} people are typing…`);
  el.style.display = 'flex';
  requestAnimationFrame(() => el.classList.add('visible'));
}

function renderMembers(snap) {
  _memberNames = [];
  const list = $('members-list'); if (!list) return;
  list.innerHTML = '';

  const approved = [], pending = [];

  snap.forEach(doc => {
    const m = doc.data();
    if (m.pubKey) _pubKeyCache.set(doc.id, m.pubKey);

    // D7: Live-update own role if promoted while in the room
    if (doc.id === state.me?.id && m.role === 'admin' && !_isAdmin) {
      _isAdmin = true; state.me.role = 'admin'; saveSession();
      updateAdminBadge();
      toast('You are now an admin ◆', 'You can approve new members.', 'star');
    }

    if (m.approved) approved.push({ uid: doc.id, ...m });
    else            pending.push({ uid: doc.id, ...m });
  });

  // ── Approved members ───────────────────────────
  const approvedCount = approved.filter(m => m.uid !== state.me?.id || true).length;
  const oc = $('online-count'), ms = $('member-status-text');
  if (oc) oc.textContent = approvedCount <= 1 ? '' : approvedCount;
  if (ms) ms.textContent = approvedCount <= 1 ? 'Only you are online' : `${approvedCount} members online`;

  approved.forEach(m => {
    const isMe = m.uid === state.me?.id;
    if (!isMe) _memberNames.push(m.name);

    const div = document.createElement('div');
    div.className = 'member-item';
    div.innerHTML = `
      <div class="avatar-wrap">
        <div class="avatar" style="background:${esc(m.color||avatarColor(m.name))}">${esc(initials(m.name))}</div>
        <div class="status-dot online"></div>
      </div>
      <div class="member-info">
        <div class="member-name">
          ${m.role === 'admin' ? '<span class="admin-crown" title="Admin">◆</span> ' : ''}${esc(m.name)}${isMe ? '<span class="me-tag"> (you)</span>' : ''}
        </div>
        <div class="member-activity">● Online</div>
      </div>
      ${_isAdmin && !isMe && m.role !== 'admin' ? `
        <button class="member-promote-btn" title="Promote to Admin"
                data-uid="${esc(m.uid)}" data-name="${esc(m.name)}">
          <svg viewBox="0 0 20 20" fill="none" width="11" height="11">
            <path d="M10 3l1.8 5.5H17l-4.7 3.4 1.8 5.5L10 14l-4.1 3.4 1.8-5.5L3 8.5h5.2z"
                  stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="member-block-btn" title="Block"
                data-uid="${esc(m.uid)}" data-name="${esc(m.name)}">
          <svg viewBox="0 0 20 20" fill="none" width="11" height="11">
            <circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.4"/>
            <path d="M5 5l10 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </button>` : ''}`;

    div.querySelector('.member-promote-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.currentTarget;
      promoteToAdmin(b.dataset.uid, b.dataset.name);
    });
    div.querySelector('.member-block-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.currentTarget;
      blockMember(b.dataset.uid, b.dataset.name).catch(() => {});
    });
    // Tap the avatar/name to open the full detail panel (role, approval
    // status, key fingerprint, and — for admins — promote/demote/block).
    div.querySelector('.avatar-wrap')?.addEventListener('click', () => openMemberDetail(m.uid, m));
    div.querySelector('.member-info')?.addEventListener('click', () => openMemberDetail(m.uid, m));
    list.appendChild(div);
  });

  // ── Pending section (admins only) ──────────────
  if (_isAdmin && pending.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'section-label pending-section-label';
    sep.innerHTML = `PENDING <span class="count-badge pending-badge">${pending.length}</span>`;
    list.appendChild(sep);

    pending.forEach(m => {
      const div = document.createElement('div');
      div.className = 'member-item pending-item';
      div.innerHTML = `
        <div class="avatar-wrap">
          <div class="avatar" style="background:${esc(m.color||avatarColor(m.name))}">${esc(initials(m.name))}</div>
          <div class="status-dot" style="background:var(--texting);box-shadow:0 0 5px var(--texting)"></div>
        </div>
        <div class="member-info">
          <div class="member-name">${esc(m.name)}</div>
          <div class="member-activity" style="color:var(--texting)">● Waiting</div>
        </div>
        <div class="pending-actions">
          <button class="pending-approve-btn" title="Approve"
                  data-uid="${esc(m.uid)}" data-name="${esc(m.name)}">
            <svg viewBox="0 0 20 20" fill="none" width="13" height="13">
              <path d="M4 10l4 4 8-8" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="pending-decline-btn" title="Decline"
                  data-uid="${esc(m.uid)}" data-name="${esc(m.name)}">
            <svg viewBox="0 0 20 20" fill="none" width="13" height="13">
              <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round"/>
            </svg>
          </button>
        </div>`;

      div.querySelector('.pending-approve-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        const b = e.currentTarget;
        approveUser(b.dataset.uid, b.dataset.name).catch(()=>{});
      });
      div.querySelector('.pending-decline-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        const b = e.currentTarget;
        declineUser(b.dataset.uid, b.dataset.name).catch(()=>{});
      });
      div.querySelector('.avatar-wrap')?.addEventListener('click', () => openMemberDetail(m.uid, m));
      div.querySelector('.member-info')?.addEventListener('click', () => openMemberDetail(m.uid, m));
      list.appendChild(div);
    });

    // Badge on hamburger so mobile admins notice pending users
    $('hamburger-btn')?.classList.add('has-pending');
  } else {
    $('hamburger-btn')?.classList.remove('has-pending');
  }
}
// ── Screenshot / Screen recording protection ────────────────────────────────
// Three-finger tap → immediate blur. visibilitychange also triggers blur.
// On Android, FLAG_SECURE can't be set from a web page, but we can:
//  1. Detect 3-finger taps and blur instantly
//  2. Listen for visibilitychange (screen capture shows hidden tab)
//  3. Blur on window blur (app switcher, notification shade, etc.)
//  4. CSS: user-select:none already set globally

let _screenshotBlurEl   = null;
let _screenshotBlurTimer = null;
const BLUR_DURATION_MS  = 4000; // how long blur stays after gesture

function _initScreenshotProtection() {
  // ── Inject blur overlay ──────────────────────────────────────────
  if (!document.getElementById('__ss_blur')) {
    const el = document.createElement('div');
    el.id = '__ss_blur';
    el.setAttribute('aria-hidden','true');
    document.body.appendChild(el);
    _screenshotBlurEl = el;
  }

  // ── 3-finger tap detection ────────────────────────────────────────
  // Count simultaneous touches; ≥3 = screenshot gesture on most Android/iOS
  let _maxTouches = 0;
  document.addEventListener('touchstart', e => {
    _maxTouches = Math.max(_maxTouches, e.touches.length);
  }, { passive: true, capture: true });
  document.addEventListener('touchend', e => {
    if (_maxTouches >= 3) {
      _triggerScreenBlur('gesture');
    }
    if (e.touches.length === 0) _maxTouches = 0;
  }, { passive: true, capture: true });

  // ── visibilitychange — screen may be being recorded / captured ───
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      _triggerScreenBlur('hidden');
    } else {
      // Brief delay — if user just switched app and back, unblur quickly
      setTimeout(() => _unblurScreen(), 800);
    }
  });

  // ── window blur (notification bar, app switcher) ─────────────────
  window.addEventListener('blur', () => _triggerScreenBlur('blur'));
  window.addEventListener('focus', () => setTimeout(_unblurScreen, 600));

  // ── Media capture detection (Chrome only) ────────────────────────
  // MediaDevices.getDisplayMedia doesn't fire without user gesture,
  // but we can detect it starting via the 'capture' media type.
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    try {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        // May indicate capture started — blur as precaution
        _triggerScreenBlur('device');
      });
    } catch {}
  }
}

function _triggerScreenBlur(reason) {
  const el = _screenshotBlurEl || document.getElementById('__ss_blur');
  if (!el) return;
  el.classList.add('active');
  if (_screenshotBlurTimer) clearTimeout(_screenshotBlurTimer);
  // Auto-unblur after BLUR_DURATION_MS (except on hidden tab)
  if (reason !== 'hidden') {
    _screenshotBlurTimer = setTimeout(_unblurScreen, BLUR_DURATION_MS);
  }
}

function _unblurScreen() {
  const el = _screenshotBlurEl || document.getElementById('__ss_blur');
  if (el) el.classList.remove('active');
  if (_screenshotBlurTimer) { clearTimeout(_screenshotBlurTimer); _screenshotBlurTimer = null; }
}

/** Safety net: clear any pending "room is empty, delete it soon" schedule
 * whenever there's message activity, so an actively-used room never gets
 * wiped out from under people due to a stray countdown (e.g. a brief empty
 * window right before someone reconnects). The real countdown is set by
 * startPresenceListener when the room is actually detected as empty — not
 * here; while people are chatting, nothing should be scheduled at all. */
let _extendTimer = null;
function _extendRoomTtl() {
  if (!state.roomCode || !db) return;
  if (_extendTimer) return;           // already scheduled this second
  _extendTimer = setTimeout(() => {
    _extendTimer = null;
    db.collection('rooms').doc(state.roomCode)
      .update({ autoDeleteAt: null, lastActivity: ts_now() })
      .catch(() => {});
  }, 2000);                          // debounce 2s so rapid typing = 1 write
}

/**
 * _healRoomSchema — brings an older room document up to the full canonical
 * field set (see room creation for the authoritative list) without
 * clobbering anything it already has. Rooms created before a given field
 * existed in the schema (e.g. msgTtlMs, blockedUsers) are simply missing
 * it entirely rather than having a default value — this patches those in
 * the first time anyone loads the room, so every room converges on the
 * same shape over time instead of staying permanently inconsistent.
 * Safe to call on every join; only writes if something's actually missing.
 */
async function _healRoomSchema(code, roomData) {
  if (!code || !roomData || !db) return;
  const CANONICAL_DEFAULTS = {
    autoDeleteAt:     null,
    inactivityTtlMs:  300000,
    approvalRequired: false,
    emptyAt:          null,
    msgTtlMs:         0,
    blockedUsers:     [],
  };
  const patch = {};
  for (const [key, def] of Object.entries(CANONICAL_DEFAULTS)) {
    if (roomData[key] === undefined) patch[key] = def;
  }
  if (Object.keys(patch).length === 0) return; // already complete
  try { await db.collection('rooms').doc(code).update(patch); }
  catch (e) { _log('warn', '[MIUT] Room schema heal failed (non-fatal):', e); }
}

/** Check if room has expired (autoDeleteAt < now) and show expired screen */
async function _checkRoomExpiry(code, db) {
  try {
    const snap = await db.collection('rooms').doc(code).get();
    if (!snap.exists) return false;
    const data = snap.data() || {};
    const expiry = data.autoDeleteAt?.toMillis?.() || 0;
    if (expiry && expiry < Date.now()) {
      // Room expired — wipe and send user back to join screen
      toast('Room expired', 'This room has expired after inactivity.', 'clock');
      await wipeRoom(code, db).catch(() => {});
      clearCacheForRoom(code).catch(() => {});
      localStorage.removeItem(CONFIG.SESSION_KEY);
      localStorage.removeItem(CONFIG.ROOM_KEY);
      state.me = null; state.roomCode = null;
      showScreen('join-screen');
      return true;
    }
    return false;
  } catch { return false; }
}

/** _ping — anonymous event counter, fire-and-forget */
function _ping(event) {
  try {
    fetch('/api/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ e: event }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}


// ════════════════════════════════════════════════════════════════════════════
// VAULT ENGINE — client-side encrypted file/note storage
// Embedded in index.html as vault-screen, only reachable via VAULT_PASSKEY.
// Storage: IndexedDB (persistent across sessions — files stored as encrypted blobs)
// Crypto: PBKDF2(250k) → AES-256-GCM per folder
// ════════════════════════════════════════════════════════════════════════════

let _vaultCurrentFolder = null; // { id, name, password }

// ── Vault Firestore helpers (root /vault collection) ───────────────────────
// Uses the primary Firestore db for the vault owner's UID.
// Each folder doc: /vault/{folderId}
// Each file doc:   /vault/{folderId}/files/{fileId}
// Security: Firestore rules must allow: if request.auth.uid == resource.data.uid

async function _vaultDb() {
  // Use first active DB for vault storage
  const dbs = (window.__MIUT_DB_CONFIGS__ || []).filter(d => d.active);
  if (!dbs.length) throw new Error('No Firestore database available');
  return firebase.firestore(firebase.app(dbs[0].name));
}

async function _vaultGetUID() {
  return getUID(); // reuse app.js getUID
}

async function _vaultDbGetAll(collection) {
  const fs  = await _vaultDb();
  const uid = await _vaultGetUID();
  const snap = await fs.collection('vault').where('uid','==',uid).get();
  if (collection === 'folders') {
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function _vaultGetFolders() {
  const fs  = await _vaultDb();
  const uid = await _vaultGetUID();
  const snap = await fs.collection('vault').where('uid','==',uid).orderBy('ts','asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function _vaultGetFiles(folderId) {
  const fs  = await _vaultDb();
  const snap = await fs.collection('vault').doc(folderId).collection('files').orderBy('ts','asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function _vaultSaveFolder(obj) {
  const fs  = await _vaultDb();
  const uid = await _vaultGetUID();
  const ref = obj.id
    ? fs.collection('vault').doc(obj.id)
    : fs.collection('vault').doc();
  await ref.set({ ...obj, uid, id: ref.id }, { merge: true });
  return ref.id;
}

async function _vaultSaveFile(folderId, obj) {
  const fs  = await _vaultDb();
  const ref = obj.id
    ? fs.collection('vault').doc(folderId).collection('files').doc(obj.id)
    : fs.collection('vault').doc(folderId).collection('files').doc();
  await ref.set({ ...obj, id: ref.id }, { merge: true });
  return ref.id;
}

async function _vaultDeleteFolder(folderId) {
  const fs  = await _vaultDb();
  // Delete all files first
  const filesSnap = await fs.collection('vault').doc(folderId).collection('files').get();
  const batch = fs.batch();
  filesSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(fs.collection('vault').doc(folderId));
  await batch.commit();
}

async function _vaultDeleteFileFs(folderId, fileId) {
  const fs = await _vaultDb();
  await fs.collection('vault').doc(folderId).collection('files').doc(fileId).delete();
}

// ── Crypto ─────────────────────────────────────────────────────────────────
// Hash password for folder auth check (SHA-256 of salt+pw as hex string)
async function _vaultHashPw(pw, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function _vaultDeriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt, iterations:250000, hash:'SHA-256' },
    base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
  );
}

async function _vaultEncryptBuf(buf, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await _vaultDeriveKey(password, salt);
  const ct   = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, buf));
  // pack: salt(16) + iv(12) + ct
  const out  = new Uint8Array(16 + 12 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  return out;
}

async function _vaultDecryptBuf(packed, password) {
  const salt = packed.slice(0, 16), iv = packed.slice(16, 28), ct = packed.slice(28);
  const key  = await _vaultDeriveKey(password, salt);
  return new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ct));
}

function _vaultU8toB64(u8) {
  let s = ''; for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function _vaultB64toU8(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

// ── Render ─────────────────────────────────────────────────────────────────
async function _vaultInit() {
  _vaultCurrentFolder = null;
  await _vaultRenderFolders();
}

async function _vaultRenderFolders() {
  _vaultCurrentFolder = null;
  const content = $('vault-content');
  if (!content) return;
  content.innerHTML = '<div class="vault-loading">Loading…</div>';
  const folders = await _vaultGetFolders().catch(() => []);
  if (!folders.length) {
    content.innerHTML = `<div class="vault-empty">
      <svg viewBox="0 0 48 48" fill="none" width="52" height="52" style="opacity:.25;margin-bottom:14px">
        <rect x="4" y="14" width="40" height="28" rx="4" stroke="currentColor" stroke-width="2"/>
        <circle cx="24" cy="28" r="6" stroke="currentColor" stroke-width="2"/>
        <path d="M16 14v-3a8 8 0 0116 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <circle cx="24" cy="28" r="2" fill="currentColor"/>
      </svg>
      <div style="font-family:var(--fui);font-size:.72rem;letter-spacing:2px;color:var(--text2)">No folders yet</div>
      <div style="font-size:.64rem;color:var(--text2);margin-top:6px">Tap + to create one</div>
    </div>`;
    return;
  }
  content.innerHTML = `<div class="vault-folder-grid">${folders.map(f => `
    <div class="vault-folder-card" data-id="${esc(f.id)}">
      <div class="vault-folder-icon">
        <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
          <path d="M3 7a2 2 0 012-2h4.5l2 2H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" stroke-width="1.5"/>
        </svg>
      </div>
      <div class="vault-folder-info">
        <div class="vault-folder-name">${esc(f.name)}</div>
        <div class="vault-folder-meta">${f.fileCount||0} file${(f.fileCount||0)!==1?'s':''}</div>
      </div>
      <button class="vault-folder-del" data-del="${esc(f.id)}" title="Delete folder">
        <svg viewBox="0 0 16 16" fill="none" width="13" height="13"><path d="M3 5h10M6 5V3h4v2M5 5l.7 8h4.6L11 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
    </div>`).join('')}</div>`;
  content.querySelectorAll('.vault-folder-card').forEach(c => {
    c.addEventListener('click', e => {
      if (e.target.closest('[data-del]')) return;
      const id = c.dataset.id;
      const folder = folders.find(f => f.id === id);
      if (folder) _vaultOpenFolderPrompt(folder);
    });
  });
  content.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', e => { e.stopPropagation(); _vaultDeleteFolderUI(b.dataset.del); });
  });
}

function _vaultFabClick() {
  // This function is called SYNCHRONOUSLY from a click event — no async allowed
  // before .click() on mobile browsers.
  if (_vaultCurrentFolder) {
    const fi = document.getElementById('vault-file-input');
    if (fi) fi.click();  // synchronous — triggers file picker immediately
  } else {
    _vaultNewFolderPrompt();
  }
}

function _vaultNewFolderPrompt() {
  _vaultShowModal('NEW FOLDER', `
    <div class="vault-field"><label>FOLDER NAME</label>
      <div class="vault-input-wrap"><input type="text" id="vf-name" placeholder="e.g. Private Notes" maxlength="60" autocomplete="off" autocapitalize="off"/></div>
    </div>
    <div class="vault-field"><label>PASSWORD <span class="vault-lbl-opt">— encrypts all files in this folder</span></label>
      <div class="vault-input-wrap"><input type="password" id="vf-pw" placeholder="Strong passphrase" maxlength="128"/></div>
    </div>
    <div class="vault-field"><label>CONFIRM PASSWORD</label>
      <div class="vault-input-wrap"><input type="password" id="vf-pw2" placeholder="Repeat passphrase" maxlength="128"/></div>
    </div>
    <div class="vault-err" id="vf-err"></div>
    <button class="vault-btn-primary" id="vf-submit">Create Encrypted Folder</button>`, async () => {
    const name = $('vf-name')?.value?.trim() || '';
    const pw   = $('vf-pw')?.value  || '';
    const pw2  = $('vf-pw2')?.value || '';
    const err  = $('vf-err');
    if (!name) { err.textContent = 'Folder name required'; return false; }
    if (pw.length < 6) { err.textContent = 'Password must be ≥6 characters'; return false; }
    if (pw !== pw2) { err.textContent = 'Passwords do not match'; return false; }
    const salt   = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const pwHash = await _vaultHashPw(pw, salt);
    await _vaultSaveFolder({ name, pwHash, pwSalt: salt, fileCount:0, ts: Date.now() });
    toast('Folder created', name, 'lock');
    await _vaultRenderFolders();
    return true;
  });
  setTimeout(() => $('vf-name')?.focus(), 80);
}

async function _vaultDeleteFolderUI(folderId) {
  await _vaultDeleteFolder(folderId);
  toast('Folder deleted', '', 'trash');
  await _vaultRenderFolders();
}

async function _vaultOpenFolderPrompt(folder) {
  _vaultShowModal('UNLOCK FOLDER', `
    <div style="font-family:var(--fui);font-size:.84rem;font-weight:700;color:var(--text);margin-bottom:16px;letter-spacing:1px">${esc(folder.name)}</div>
    <div class="vault-field"><label>FOLDER PASSWORD</label>
      <div class="vault-input-wrap"><input type="password" id="vu-pw" placeholder="Enter password" maxlength="128" autocomplete="off"/></div>
    </div>
    <div class="vault-err" id="vu-err"></div>
    <button class="vault-btn-primary" id="vu-submit">Unlock</button>`, async () => {
    const pw  = $('vu-pw')?.value || '';
    const err = $('vu-err');
    if (!pw) { err.textContent = 'Enter password'; return false; }
    // Verify password matches stored (attempt decrypt of a test payload)
    // Verify password: check hash stored on folder
    const hash = await _vaultHashPw(pw, folder.pwSalt || folder.id);
    if (hash !== folder.pwHash) { err.textContent = 'Wrong password'; return false; }
    _vaultCurrentFolder = { ...folder, password: pw };
    _vaultCloseModal();
    await _vaultRenderFiles();
    return true;
  });
  setTimeout(() => $('vu-pw')?.focus(), 80);
}

async function _vaultRenderFiles() {
  const content = $('vault-content');
  if (!content || !_vaultCurrentFolder) return;
  const files = await _vaultGetFiles(_vaultCurrentFolder.id).catch(() => []);

  content.innerHTML = `
    <div class="vault-folder-header">
      <button class="vault-back-btn" id="vault-back-btn">← Folders</button>
      <span class="vault-folder-title">${esc(_vaultCurrentFolder.name)}</span>
    </div>
    <div class="vault-drop-zone" id="vault-drop-zone">
      <svg viewBox="0 0 24 24" fill="none" width="28" height="28" style="opacity:.4;margin-bottom:8px">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <span style="font-size:.72rem;color:var(--text2)">Drop files or <strong style="color:var(--teal)">tap to upload</strong></span>
    </div>
    <div class="vault-file-list" id="vault-file-list">${files.length ? files.map(f => _vaultFileItemHtml(f)).join('') : '<div style="text-align:center;padding:24px;font-size:.68rem;color:var(--text2)">No files yet</div>'}</div>`;

  $('vault-back-btn').addEventListener('click', () => { _vaultCurrentFolder = null; _vaultRenderFolders(); });

  // Drop zone
  const dz = $('vault-drop-zone');
  const fi = document.getElementById('vault-file-input'); // permanent element
  if (dz) {
    dz.addEventListener('click', () => fi?.click());
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); _vaultUploadFiles(Array.from(e.dataTransfer.files)); });
  }

  // File actions
  content.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => _vaultDownloadFile(b.dataset.dl)));
  content.querySelectorAll('[data-fdel]').forEach(b => b.addEventListener('click', () => _vaultDeleteFile(b.dataset.fdel)));
}

function _vaultFileItemHtml(f) {
  return `<div class="vault-file-item" id="vfi-${esc(f.id)}">
    <div class="vault-file-icon">${_vaultFileIconSvg(f.mime)}</div>
    <div class="vault-file-info">
      <div class="vault-file-name">${esc(f.name)}</div>
      <div class="vault-file-meta">${_fmtBytes(f.size)}</div>
    </div>
    <button class="vault-file-act" data-dl="${esc(f.id)}" title="Download">
      <svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M8 2v8M5 8l3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
    <button class="vault-file-act danger" data-fdel="${esc(f.id)}" title="Delete">
      <svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M3 5h10M6 5V3h4v2M5 5l.7 8h4.6L11 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
    </button>
  </div>`;
}

function _vaultFileIconSvg(mime) {
  if (!mime) return '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M4 2h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3"/></svg>';
  if (mime.startsWith('image/')) return '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/><path d="M2 11l4-4 3 3 2-2 3 2" stroke="currentColor" stroke-width="1.2"/></svg>';
  if (mime.startsWith('video/')) return '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><rect x="1" y="4" width="10" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M11 7l4-2v6l-4-2V7z" stroke="currentColor" stroke-width="1.3"/></svg>';
  if (mime.includes('pdf'))    return '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M4 2h5l4 4v9H4V2z" stroke="currentColor" stroke-width="1.3"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.3"/></svg>';
  return '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M4 2h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.3"/></svg>';
}

function _fmtBytes(n) {
  if (!n) return ''; if (n<1024) return n+'B'; if (n<1048576) return (n/1024).toFixed(1)+'KB'; return (n/1048576).toFixed(1)+'MB';
}

async function _vaultUploadFiles(files) {
  if (!_vaultCurrentFolder) return;
  for (const file of files) {
    try {
      toast('Encrypting…', file.name, 'dot');
      const buf = await file.arrayBuffer();
      const enc = await _vaultEncryptBuf(new Uint8Array(buf), _vaultCurrentFolder.password);
      await _vaultSaveFile(_vaultCurrentFolder.id, {
        name: file.name, mime: file.type,
        size: file.size, enc: _vaultU8toB64(enc), ts: Date.now(),
      });
      // Update folder file count
      await _vaultSaveFolder({
        id: _vaultCurrentFolder.id,
        fileCount: (_vaultCurrentFolder.fileCount||0)+1,
      });
      _vaultCurrentFolder.fileCount = (_vaultCurrentFolder.fileCount||0)+1;
      toast('Saved', file.name, 'ok');
    } catch(e) { toast('Failed', file.name, 'err'); }
  }
  await _vaultRenderFiles();
}

async function _vaultDownloadFile(fileId) {
  const allFiles = await _vaultDbGetAll('files');
  const f = allFiles.find(x => x.id === fileId);
  if (!f || !_vaultCurrentFolder) return;
  try {
    const plain = await _vaultDecryptBuf(_vaultB64toU8(f.enc), _vaultCurrentFolder.password);
    const blob  = new Blob([plain], { type: f.mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = f.name;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch { toast('Decrypt failed', 'Wrong password or corrupted file', 'err'); }
}

async function _vaultDeleteFile(fileId) {
  if (!_vaultCurrentFolder) return;
  await _vaultDeleteFileFs(_vaultCurrentFolder.id, fileId);
  if (_vaultCurrentFolder.fileCount > 0) {
    _vaultCurrentFolder.fileCount--;
    await _vaultSaveFolder({ id: _vaultCurrentFolder.id, fileCount: _vaultCurrentFolder.fileCount });
  }
  document.getElementById('vfi-' + fileId)?.remove();
  toast('File deleted', '', 'trash');
}

// ── Vault modal helper ─────────────────────────────────────────────────────
let _vaultModalSubmitFn = null;

function _vaultShowModal(title, bodyHtml, onSubmit) {
  // The overlay is a static HTML element INSIDE vault-screen (same stacking context).
  // This is critical — dynamically appending to body puts it in a DIFFERENT stacking
  // context than .screen.active (which has will-change:transform), making it invisible.
  const overlay = document.getElementById('vault-modal-overlay');
  const titleEl = document.getElementById('vault-modal-title');
  const bodyEl  = document.getElementById('vault-modal-body');
  if (!overlay || !titleEl || !bodyEl) {
    console.error('[Vault] Modal elements missing from DOM');
    return;
  }
  titleEl.textContent = title;
  bodyEl.innerHTML    = bodyHtml;
  overlay.style.display = 'flex';
  _vaultModalSubmitFn   = onSubmit;

  // Wire submit — fresh listener each time since innerHTML replaces nodes
  const sub = bodyEl.querySelector('[id$="-submit"]');
  if (sub) {
    sub.addEventListener('click', async () => {
      if (sub.disabled) return;
      sub.disabled = true;
      const errEl = bodyEl.querySelector('.vault-err');
      try {
        const ok = await (_vaultModalSubmitFn?.() ?? false);
        if (ok) _vaultCloseModal();
      } catch(e) {
        if (errEl) errEl.textContent = e.message || 'Error';
      } finally { sub.disabled = false; }
    });
  }

  // Focus first text input
  requestAnimationFrame(() => bodyEl.querySelector('input:not([type=hidden])')?.focus());
}

function _vaultCloseModal() {
  const ov = document.getElementById('vault-modal-overlay');
  if (ov) ov.style.display = 'none';
  _vaultModalSubmitFn = null;
}

// ── Multi-select action bar ─────────────────────────────────────────────────
function _enterSelectMode() {
  if (_selectMode) return;
  _selectMode = true;
  _selectedIds.clear();
  // Show top action bar
  let bar = document.getElementById('msg-select-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'msg-select-bar';
    bar.className = 'msg-select-bar';
    bar.innerHTML = `
      <button class="msa-btn msa-cancel" id="msa-cancel">
        <svg viewBox="0 0 20 20" fill="none" width="18" height="18"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <span class="msa-count" id="msa-count">0 selected</span>
      <div style="flex:1"></div>
      <button class="msa-btn msa-del-me" id="msa-del-me" title="Delete for me" style="display:none">
        <svg viewBox="0 0 20 20" fill="none" width="18" height="18"><path d="M5 6h10M8 6V4h4v2M7 6l.6 9h4.8L13 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>Me</span>
      </button>
      <button class="msa-btn msa-del-all" id="msa-del-all" title="Delete for everyone" style="display:none">
        <svg viewBox="0 0 20 20" fill="none" width="18" height="18"><path d="M5 6h10M8 6V4h4v2M7 6l.6 9h4.8L13 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>Everyone</span>
      </button>`;
    // Insert before chat-header content
    const header = document.getElementById('chat-header');
    if (header) header.parentNode.insertBefore(bar, header);
    document.getElementById('msa-cancel').addEventListener('click', _exitSelectMode);
    document.getElementById('msa-del-me').addEventListener('click', () => _deleteSelected(false));
    document.getElementById('msa-del-all').addEventListener('click', () => _deleteSelected(true));
  }
  bar.classList.add('active');
  document.querySelectorAll('.msg-wrapper').forEach(w => w.classList.add('selectable'));
}

function _exitSelectMode() {
  _selectMode = false;
  _selectedIds.clear();
  document.getElementById('msg-select-bar')?.classList.remove('active');
  document.querySelectorAll('.msg-wrapper.selectable').forEach(w => {
    w.classList.remove('selectable','selected');
  });
}

function _updateSelectBar() {
  const count  = _selectedIds.size;
  const countEl = document.getElementById('msa-count');
  if (countEl) countEl.textContent = `${count} selected`;
  // "Delete for everyone" is allowed for your own messages always, and for
  // ANY message if you're the room admin — moderating other people's
  // messages is a normal admin capability, not just self-deletion. This
  // used to require every selected message be your own regardless of
  // admin status, so an admin selecting someone else's message never saw
  // the option at all.
  const canDeleteAll = [..._selectedIds].every(id => {
    const w = document.querySelector(`.msg-wrapper[data-doc-id="${CSS.escape(id)}"]`);
    return _isAdmin || w?.classList.contains('sent');
  });
  const delMe  = document.getElementById('msa-del-me');
  const delAll = document.getElementById('msa-del-all');
  if (delMe)  delMe.style.display  = count ? '' : 'none';
  if (delAll) delAll.style.display = (count && canDeleteAll) ? '' : 'none';
}

function _toggleSelectMsg(docId, el) {
  if (_selectedIds.has(docId)) {
    _selectedIds.delete(docId);
    el.classList.remove('selected');
  } else {
    _selectedIds.add(docId);
    el.classList.add('selected');
  }
  _updateSelectBar();
}

async function _deleteSelected(forEveryone) {
  if (!_selectedIds.size) return;
  const ids = [..._selectedIds];
  _exitSelectMode();
  let deleted = 0;
  for (const id of ids) {
    const w = document.querySelector(`.msg-wrapper[data-doc-id="${CSS.escape(id)}"]`);
    // Admins can delete-for-everyone on any message, not just their own —
    // matches the "Everyone" button's own visibility rule in _updateSelectBar.
    if (forEveryone && (_isAdmin || w?.classList.contains('sent'))) {
      _softDeleteLocal(w);     // instant
      _softDeleteRemote(id);   // background
      deleted++;
    } else if (!forEveryone) {
      w?.remove(); // "delete for me" — local-only, doesn't touch Firestore
      deleted++;
    }
  }
  if (deleted) toast(`${deleted} message${deleted>1?'s':''} deleted`, '', forEveryone ? 'trash' : 'ok');
}

// ── Wire long-press to enter select mode ─────────────────────────────────────
function _wireLongPress(wrap, docId) {
  let timer = null;
  const START_EVENTS = ['touchstart','mousedown'];
  const END_EVENTS   = ['touchend','touchcancel','mouseup','mouseleave'];
  // Read docId live off the element rather than the closure — an
  // optimistically-rendered message gets its dataset.docId swapped from a
  // temporary local id to the real Firestore id once the server acks it
  // (see _reconcileSentMessage), and this handler must follow that swap
  // instead of acting on the now-stale id it was first wired with.
  const currentId = () => wrap.dataset.docId || docId;

  START_EVENTS.forEach(ev => wrap.addEventListener(ev, () => {
    timer = setTimeout(() => {
      // A long-press directly on the bubble/media/file already opened the
      // quick-react strip (see the shorter 480ms timer wired on those
      // specific elements in renderMsg) — don't also enter multi-select for
      // the same physical press, that's what made selection feel like it
      // was firing on a hair trigger. Long-pressing empty wrap space (e.g.
      // around the sender name/timestamp) still enters multi-select as before.
      if (wrap.querySelector('.msg-action-strip')) return;
      if (navigator.vibrate) navigator.vibrate(28);
      if (!_selectMode) _enterSelectMode();
      _toggleSelectMsg(currentId(), wrap);
    }, 500);
  }, { passive: true }));
  END_EVENTS.forEach(ev => wrap.addEventListener(ev, () => {
    if (timer) { clearTimeout(timer); timer = null; }
  }, { passive: true }));

  wrap.addEventListener('click', e => {
    if (_selectMode) {
      e.stopPropagation();
      _toggleSelectMsg(currentId(), wrap);
    }
  });
}

// ── TTL progress bar (replaces timer text) ───────────────────────────────────
function _updateTtlBars() {
  if (!_roomTtlMs) return;
  const now = Date.now();
  document.querySelectorAll('.msg-wrapper[data-ts]').forEach(w => {
    const ts       = parseInt(w.dataset.ts || '0', 10);
    if (!ts) return;
    const age      = now - ts;
    const timeLeft = _roomTtlMs - age;
    if (timeLeft <= 0) return;
    const pct = Math.max(0, Math.min(100, (timeLeft / _roomTtlMs) * 100));
    let bar = w.querySelector('.msg-ttl-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'msg-ttl-bar';
      const fill = document.createElement('div');
      fill.className = 'msg-ttl-fill';
      bar.appendChild(fill);
      // Insert after .msg-inner
      const inner = w.querySelector('.msg-inner');
      if (inner) inner.after(bar);
    }
    const fill = bar.querySelector('.msg-ttl-fill');
    if (fill) {
      fill.style.width = pct + '%';
      fill.style.background = pct < 20 ? 'var(--danger)' : pct < 50 ? '#f7c430' : 'var(--teal)';
    }
    // Remove the old text timer if present
    w.querySelector('.msg-ttl-timer')?.remove();
  });
}

// ── Stray dot fix — room-code-pill empty state ───────────────────────────────
// The pill shows '····' when no room is active. Fine. But ensure it's not
// briefly showing a real period from the room code validation regex edge case.

// ── Override ._runExpirySweep to also update TTL bars ────────────────────────
const _origRunExpirySweep = typeof _runExpirySweep !== 'undefined' ? _runExpirySweep : null;

// ── Patch the expiry sweep to call bar updater ───────────────────────────────

// ── Override showInlineActions to check select mode ─────────────────────────

// wipeRoom accepts an explicit Firestore instance to avoid using the global `db`
// which may point to a different shard if getDb() was called for another room.
async function wipeRoom(code, fsInstance) {
  const fs = fsInstance || db;
  if (!fs || !code) return;  // silent guard
  try {
    const batchDelete = async col => {
      let snap;
      do {
        snap = await fs.collection('rooms').doc(code)
                       .collection(col).limit(499).get();
        if (snap.empty) break;
        const b = fs.batch();
        snap.forEach(d => b.delete(d.ref));
        await b.commit();
      } while (!snap.empty);
    };
    await batchDelete('messages');
    await batchDelete('typing');
    await batchDelete('members');
    // Firestore rules now require isRoomAdmin() for room doc deletion.
    await fs.collection('rooms').doc(code).delete();
  } catch (e) {
    // This used to fail completely silently. A failed wipe here means the
    // room's messages/members subcollections can be left behind even
    // though the caller believes the room was deleted — and since room
    // creation now refuses to reuse an occupied code (see handleCreate),
    // a silently-failed wipe would otherwise be invisible until someone
    // tries to reuse that exact code and gets a confusing "already in
    // use" error for a room they thought was long gone. Surface it.
    console.warn(`[MIUT] wipeRoom(${code}) failed — subcollections or the room doc itself may still exist:`, e);
  }
}

function startHeartbeat() {
  clearInterval(_heartbeat);
  _heartbeat = setInterval(() => {
    if (!state.roomCode || !state.me) return;
    if (document.hidden) return;
    db.collection('rooms').doc(state.roomCode).collection('members').doc(state.me.id)
      .update({ online: true, lastSeen: ts_now() }).catch(() => {});
  }, CONFIG.HEARTBEAT_MS);
}

document.addEventListener('visibilitychange', () => {
  if (!state.me || !state.roomCode || !db) return;
  const online = !document.hidden;
  db.collection('rooms').doc(state.roomCode).collection('members').doc(state.me.id)
    .update({ online, lastSeen: ts_now() }).catch(() => {});
  if (online) {
    _unreadCount = 0;
    document.title = 'MIUT';
    stopChatListeners(); startChatListeners();
    setTimeout(_markVisibleAsRead, 400); // mark newly visible messages as read
  }
});

// SW update notification: intentionally NOT handled here. sw-bridge.js's
// showUpdateBanner() (triggered via the registration's own updatefound/
// statechange events, a more reliable signal than reacting to the SW's
// own postMessage announcement) is the single owner of this UI. This used
// to ALSO listen here — on window, not navigator.serviceWorker, which per
// spec never actually receives a Client.postMessage() from the SW anyway
// — but even dead/unreachable code duplicating another file's
// responsibility for the same user-facing notification is worth removing
// outright rather than leaving as a latent double-fire risk.

window.addEventListener('beforeunload', () => {
  if (!state.me || !state.roomCode || !db) return;
  clearMyTyping();
  // Synchronous best-effort update — beacon preferred for reliability
  const payload = JSON.stringify({ online: false, lastSeen: Date.now() });
  if (navigator.sendBeacon) {
    // sendBeacon for reliability on page close (ignored if endpoint absent)
    // Primary: direct Firestore REST update via sendBeacon is not feasible,
    // so fall back to synchronous XHR.
  }
  try {
    db.collection('rooms').doc(state.roomCode).collection('members').doc(state.me.id)
      .update({ online: false, lastSeen: ts_now() }).catch(() => {});
  } catch {}
});


async function sendMessage() {
  if (_editingDocId) { submitEdit().catch(() => {}); return; }
  if (!checkSendRateLimit()) return;

  const input = $('msg-input');
  const text  = (input?.value || '').replace(/[​-‍﻿­]/g, '').trim();
  if (!text || !state.roomCode || !db) return;
  input.value = ''; input.style.height = 'auto';
  updateActionBtn();
  clearMyTyping();

  const ts_client = Date.now();

  // PART 5: beforeSend hook — can mutate { text }
  let _sendPayload = { text };
  if (typeof runHooks === 'function') _sendPayload = await runHooks('beforeSend', _sendPayload);
  const _sendText = (_sendPayload && _sendPayload.text !== undefined) ? _sendPayload.text : text;

  // PART 8: replay protection — timestamp validation
  if (typeof validateMessageTimestamp === 'function' && !validateMessageTimestamp(ts_client)) {
    toast('Send error', 'System clock skew detected — please check your device time.', 'warn'); return;
  }

  const encText   = await enc(_sendText, state.roomCode);
  const msgSig    = await signMsg(state.me.id, ts_client, encText);

  const msgData = {
    type:        'text',
    enc:         encText,
    sig:         msgSig,             // D3: ECDSA signature
    senderId:    state.me.id,
    senderName:  state.me.name,
    senderColor: state.me.color,
    createdAt:   ts_now(),
    ts:          ts_client,
  };

  // Attach encrypted reply quote if replying
  if (_replyTo) {
    msgData.replyTo = {
      senderName: _replyTo.senderName,
      enc:        _replyTo.text ? await enc(_replyTo.text, state.roomCode) : '',
      docId:      _replyTo.docId || '',
      mediaType:  _replyTo.mediaType || null,
      fileName:   _replyTo.fileName  || null,
    };
    clearReply();
  }

  // Clear any pending "room is empty" auto-delete schedule — see
  // _extendRoomTtl's own comment for why sending a message should do this.
  _extendRoomTtl();

  // Optimistic render: show the bubble immediately instead of waiting for
  // the Firestore round trip. This matters because createdAt uses
  // serverTimestamp(), which stays unresolved (null) in the local cache
  // until the server acks it — the live listener's `createdAt > since`
  // filter won't surface an unresolved doc, so without this the sender's
  // own message would visibly lag even on a fast connection.
  const _localId = 'local_' + ts_client + '_' + Math.random().toString(36).slice(2, 8);
  _pendingMsgPayloads.set(_localId, msgData); // kept for tap-to-retry on failure
  _pendingByTs.set(ts_client, _localId);
  await renderMsg(msgData, _localId);
  scrollBottom();

  db.collection('rooms').doc(state.roomCode).collection('messages').add(msgData)
    .then(ref => {
      _pendingMsgPayloads.delete(_localId);
      _pendingByTs.delete(ts_client);
      _reconcileSentMessage(_localId, ref.id, msgData);
      _ping('message_sent');
      // Message-count-based epoch rotation is tracked in the live listener
      // (startChatListeners) instead of here — see the comment there for why.
    })
    .catch(e => {
      _markMessageFailed(_localId);
      toast('Send failed', e.message, 'err');
    });
  playSound('send');
}

const _pendingMsgPayloads = new Map(); // localId → full msgData, kept only until reconciled (for tap-to-retry)
// ts_client → localId. Lets the live listener recognize a race where its own
// 'added' event for this doc arrives before the add() promise resolves, so it
// reconciles instead of rendering a duplicate bubble.
const _pendingByTs = new Map();

/**
 * _reconcileSentMessage — once the server acks an optimistically-rendered
 * message, swap its temporary local id for the real Firestore docId (so
 * later edit/delete/reply-by-id actions work) and flip its status badge
 * from "sending" to "sent". Also registers the real id so the live
 * listener's own eventual 'added' event for this doc is recognized as
 * already-rendered and skipped instead of duplicating the bubble.
 */
function _reconcileSentMessage(localId, realId, msgData) {
  _renderedIds.add(realId);
  const wrap = document.querySelector(`.msg-wrapper[data-doc-id="${CSS.escape(localId)}"]`);
  if (!wrap) return;
  wrap.dataset.docId = realId; // _wireLongPress reads this live, no re-wiring needed
  const statusEl = wrap.querySelector('.msg-status');
  if (statusEl) statusEl.outerHTML = _readStatusBadge(msgData, realId);
}

/** _markMessageFailed — flip a still-pending optimistic bubble into a
 * visibly failed state with a tap-to-retry affordance. */
function _markMessageFailed(localId) {
  const wrap = document.querySelector(`.msg-wrapper[data-doc-id="${CSS.escape(localId)}"]`);
  if (!wrap) return;
  wrap.classList.add('send-failed');
  const statusEl = wrap.querySelector('.msg-status');
  if (statusEl) {
    statusEl.outerHTML = '<span class="msg-status msg-status-failed" title="Not sent — tap to retry">!</span>';
  }
  const bubble = wrap.querySelector('.msg-bubble');
  const retry = () => _retrySendFailed(localId);
  bubble?.addEventListener('click', retry, { once: true });
  wrap.querySelector('.msg-status-failed')?.addEventListener('click', retry, { once: true });
}

/** _retrySendFailed — re-attempts sending a failed optimistic message
 * using its original (already-encrypted) payload, no re-encryption needed. */
function _retrySendFailed(localId) {
  const wrap = document.querySelector(`.msg-wrapper[data-doc-id="${CSS.escape(localId)}"]`);
  const msgData = _pendingMsgPayloads.get(localId);
  if (!wrap || !msgData || !state.roomCode || !db) return;

  wrap.classList.remove('send-failed');
  const statusEl = wrap.querySelector('.msg-status');
  if (statusEl) statusEl.outerHTML = '<span class="msg-status msg-status-pending" title="Sending…">Sending…</span>';

  msgData.createdAt = ts_now(); // refresh — the old sentinel already failed once
  db.collection('rooms').doc(state.roomCode).collection('messages').add(msgData)
    .then(ref => {
      _pendingMsgPayloads.delete(localId);
      _pendingByTs.delete(msgData.ts);
      _reconcileSentMessage(localId, ref.id, msgData);
    })
    .catch(e => { _markMessageFailed(localId); toast('Send failed', e.message, 'err'); });
}
async function sendSys(text, roomCodeOverride, meOverride) {
  // Optional overrides let callers running after global `state` has been
  // cleared (e.g. background leave-room cleanup) still send correctly —
  // see handleLogout / _handoffAdminRole.
  const _roomCode = roomCodeOverride || state.roomCode;
  const _me       = meOverride || state.me;
  if (!_roomCode || !_me?.id) return;
  const _sts  = Date.now();
  const _senc = await enc(text, _roomCode);
  // senderId required by Firestore rules (hasAll check on messages create)
  await db.collection('rooms').doc(_roomCode).collection('messages').add({
    type:      'system',
    enc:       _senc,
    senderId:  _me.id,   // ← required by security rules
    createdAt: ts_now(),
    ts:        _sts,
  }).catch(() => {});
}

// ─── Read receipts ────────────────────────────────────────────────────────────
// Architecture: each message doc gets a `readBy` sub-map {uid: timestamp}.
// We batch-write receipts every 1.5s to avoid per-message Firestore writes.
// Senders watch `patchMsg` which detects readBy changes and updates the ✓✓ UI.

function _queueReadAck(docId) {
  if (!docId || !state.me?.id) return;
  _pendingReadAcks.add(docId);
  if (_readReceiptTimer) return; // already scheduled
  _readReceiptTimer = setTimeout(_flushReadAcks, 1500);
}

async function _flushReadAcks() {
  _readReceiptTimer = null;
  if (!_pendingReadAcks.size || !state.roomCode || !state.me) return;
  // Bug fix: this used to .clear() the ENTIRE queue up front but only ever
  // batch-write the first 50 of it — anything beyond 50 pending receipts
  // (easy to hit for a new member catching up on 100 history messages) was
  // silently discarded and those messages would never show as read. Now we
  // only remove the ids we're actually about to write, and re-schedule a
  // follow-up flush for whatever's left over.
  const ids = [..._pendingReadAcks].slice(0, 50);
  ids.forEach(id => _pendingReadAcks.delete(id));

  // Batch write — max 499 ops per Firestore batch, but we cap at 50 receipts/flush
  const batch = db.batch();
  let count = 0;
  for (const docId of ids) {
    const ref = db.collection('rooms').doc(state.roomCode)
                  .collection('messages').doc(docId);
    batch.update(ref, { [`readBy.${state.me.id}`]: Date.now() });
    count++;
  }
  if (count) batch.commit().catch(() => {});

  if (_pendingReadAcks.size && !_readReceiptTimer) {
    _readReceiptTimer = setTimeout(_flushReadAcks, 300);
  }
}

// Mark all visible messages in the viewport as read
function _markVisibleAsRead() {
  if (!state.roomCode || !state.me || document.hidden) return;
  const area = $('messages-area');
  if (!area) return;
  const areaRect = area.getBoundingClientRect();
  document.querySelectorAll('.msg-wrapper[data-doc-id]').forEach(w => {
    if (w.dataset.senderId === state.me.id) return; // don't ack own
    const rect = w.getBoundingClientRect();
    if (rect.top < areaRect.bottom && rect.bottom > areaRect.top) {
      _queueReadAck(w.dataset.docId);
    }
  });
}

// Render read-receipt badge on a sent message
function _renderReadBadge(wrapEl, readBy) {
  if (!wrapEl || !wrapEl.classList.contains('sent')) return;
  const statusEl = wrapEl.querySelector('.msg-status');
  if (!statusEl) return;
  // Filter out own UID and message sender — count other readers
  const senderId = wrapEl.dataset.senderId || '';
  const allReaders = Object.keys(readBy || {}).filter(uid => uid !== senderId);
  if (allReaders.length === 0) {
    statusEl.textContent = '✓';
    statusEl.title = 'Sent';
    statusEl.classList.remove('msg-status-read');
  } else {
    statusEl.textContent = '✓✓';
    statusEl.title = `Read by ${allReaders.length} member${allReaders.length > 1 ? 's' : ''}`;
    statusEl.classList.add('msg-status-read');
  }
}
// ─────────────────────────────────────────────────────────────────────────────


function handleKey(e) {
  // Escape closes mention dropdown or search
  if (e.key === 'Escape') {
    if (_mentionActive) { e.preventDefault(); hideMentionDropdown(); return; }
    if (_searchActive)  { toggleSearch(); return; }
  }
  // Tab selects first mention
  if (e.key === 'Tab' && _mentionActive) {
    e.preventDefault();
    const first = $('mention-dropdown')?.querySelector('.mention-item');
    if (first) first.dispatchEvent(new Event('mousedown'));
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function handleTyping(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  handleMentionInput(el);
  updateActionBtn();
  if (!state.roomCode || !state.me) return;

  const now = Date.now();
  if (!_isTyping || now - _lastTypeWrite >= CONFIG.TYPING_WRITE_MS) {
    _isTyping = true;
    _lastTypeWrite = now;
    db.collection('rooms').doc(state.roomCode).collection('typing').doc(state.me.id)
      .set({ name: state.me.name, ts: now }).catch(() => {});
  }
  clearTimeout(_typingTimer);
  _typingTimer = setTimeout(clearMyTyping, CONFIG.TYPING_IDLE_MS);
}

function clearMyTyping() {
  clearTimeout(_typingTimer);
  if (!_isTyping) return;
  _isTyping = false;
  if (state.roomCode && state.me) {
    db.collection('rooms').doc(state.roomCode).collection('typing').doc(state.me.id)
      .delete().catch(() => {});
  }
}

async function handleFileAttach(e) {
  const file = e.target.files?.[0];
  if (!file || !state.roomCode) return;
  e.target.value = '';
  updateActionBtn();

  if (file.size > CONFIG.MAX_FILE_BYTES) {
    toast('File too large', 'Max 25 MB per file', 'err'); return;
  }

  const isImg   = file.type.startsWith('image/');
  const isVid   = file.type.startsWith('video/');
  const msgType = isImg ? 'image' : isVid ? 'video' : 'file';

  // ── Optimistic UI: show local preview IMMEDIATELY ───────────────────
  // User sees their image at once; upload happens in background.
  let _optimisticEl = null;
  if (isImg) {
    const localUrl  = URL.createObjectURL(file);
    const fakeDocId = 'opt_' + Date.now();
    const fakeData  = {
      type: 'image', senderId: state.me.id, senderName: state.me.name,
      senderColor: state.me.color, ts: Date.now(), enc: '', sig: null,
    };
    // Inject a temporary message wrapper with the local blob URL
    const area = $('messages-area');
    if (area) {
      const wrap = document.createElement('div');
      wrap.className    = 'msg-wrapper sent';
      wrap.dataset.docId = fakeDocId;
      wrap.dataset.ts    = fakeData.ts;
      wrap.style.opacity = '0.75';
      wrap.innerHTML = `<div class="msg-swipe-wrapper"><div class="msg-bubble-wrap">
        <div class="msg-inner">
          <div class="msg-bubble" style="padding:4px;background:transparent">
            <img src="${localUrl}" style="max-width:220px;max-height:220px;border-radius:14px;display:block" loading="eager"/>
            <div class="msg-upload-progress"><div class="msg-upload-bar"></div></div>
          </div>
          <div class="msg-meta"><span class="msg-time-sm">Sending…</span></div>
        </div>
      </div></div>`;
      area.appendChild(wrap);
      scrollBottom();
      _optimisticEl = wrap;
      // Animate progress bar
      const bar = wrap.querySelector('.msg-upload-bar');
      if (bar) { setTimeout(() => { bar.style.width = '60%'; }, 50); }
    }
  } else {
    toast('Encrypting…', file.name, 'dot');
  }

  try {
    const encrypted = await encBytes(file, state.roomCode);
    const totalSize = encrypted.length;

    if (totalSize <= CONFIG.CHUNK_BYTES) {
      const fts  = Date.now();
      const fsig = await signMsg(state.me.id, fts, encrypted.slice(0, 64));
      await db.collection('rooms').doc(state.roomCode).collection('messages').add({
        type: msgType, encData: encrypted, mime: file.type,
        fileName: file.name, fileSize: file.size, chunks: 1, chunkOf: 1,
        senderId: state.me.id, senderName: state.me.name, senderColor: state.me.color,
        sig: fsig, ts: fts, createdAt: ts_now(),
      });
    } else {
      const parts   = [];
      for (let i = 0; i < totalSize; i += CONFIG.CHUNK_BYTES)
        parts.push(encrypted.slice(i, i + CONFIG.CHUNK_BYTES));
      const groupId = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const now     = Date.now();
      const BATCH   = 4;
      for (let b = 0; b < parts.length; b += BATCH) {
        await Promise.all(parts.slice(b, b + BATCH).map((part, li) => {
          const idx = b + li;
          return db.collection('rooms').doc(state.roomCode).collection('messages').add({
            type: idx === 0 ? msgType : 'chunk', encData: part,
            mime: file.type, fileName: file.name, fileSize: file.size,
            groupId, chunkIdx: idx, chunkOf: parts.length,
            senderId: state.me.id, senderName: state.me.name, senderColor: state.me.color,
            createdAt: ts_now(), ts: now + idx,
          });
        }));
      }
    }
    playSound('send');
    if (_optimisticEl) {
      // Fade out the optimistic preview — real message from Firestore will appear
      _optimisticEl.style.transition = 'opacity .3s';
      _optimisticEl.style.opacity = '0';
      setTimeout(() => _optimisticEl?.remove(), 320);
    } else {
      toast('Sent!', file.name, 'ok');
    }
  } catch (err) {
    if (_optimisticEl) { _optimisticEl.remove(); }
    toast('Upload failed', err.message || 'Check your connection', 'err');
  }
}

function triggerAttach() { toggleAttachTabs(); }

function toggleAttachTabs() {
  const tabs = $('attach-tabs'), btn = $('attach-btn');
  if (!tabs) return;
  const opening = !tabs.classList.contains('open');
  tabs.classList.toggle('open', opening);
  btn?.setAttribute('aria-expanded', opening ? 'true' : 'false');
}
function closeAttachTabs() {
  $('attach-tabs')?.classList.remove('open');
  $('attach-btn')?.setAttribute('aria-expanded', 'false');
}

let _replyTo = null;  // { senderName, text, docId }

function setReply(senderName, text, docId, mediaType, fileName) {
  _replyTo = { senderName, text, docId, mediaType, fileName };
  const bar   = $('reply-bar');
  const rname = $('reply-sender');
  const rtext = $('reply-preview');
  if (!bar) return;
  rname.textContent = senderName;

  if (mediaType === 'image') {
    rtext.innerHTML = `<span class="rq-media-inline"><svg viewBox="0 0 20 20" fill="none" width="12" height="12"><path d="M2 7a2 2 0 012-2h.5l1-2h5l1 2H17a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V7z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="11" r="2.5" stroke="currentColor" stroke-width="1.4"/></svg> Photo</span>`;
  } else if (mediaType === 'video') {
    rtext.innerHTML = `<span class="rq-media-inline"><svg viewBox="0 0 20 20" fill="none" width="12" height="12"><rect x="2" y="5" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M14 9l4-2v6l-4-2V9z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg> Video</span>`;
  } else if (mediaType === 'file') {
    const isPdf = (fileName || '').toLowerCase().endsWith('.pdf');
    const label = isPdf ? 'PDF' : 'File';
    const fname = fileName ? ': ' + (fileName.length > 22 ? fileName.slice(0, 22) + '…' : fileName) : '';
    rtext.innerHTML = `<span class="rq-media-inline"><svg viewBox="0 0 20 20" fill="none" width="12" height="12"><path d="M4 4a2 2 0 012-2h5l5 5v9a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" stroke="currentColor" stroke-width="1.4"/><path d="M11 2v5h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg> ${esc(label)}${esc(fname)}</span>`;
  } else {
    rtext.textContent = text.length > 80 ? text.slice(0, 80) + '…' : text;
  }

  bar.style.display = 'flex';
  requestAnimationFrame(() => bar.classList.add('visible'));
  $('msg-input')?.focus();
}

function clearReply() {
  // If editing, cancel the edit
  if (_editingDocId) { cancelEdit(); return; }
  _replyTo = null;
  const bar = $('reply-bar');
  if (!bar) return;
  bar.classList.remove('visible');
  setTimeout(() => { bar.style.display = 'none'; }, 250);
}

let _chunkGroups = {};
let _memberNames  = [];      // tracked for @mention autocomplete
let _editingDocId = null;    // docId of message currently being edited
let _editingWrap  = null;
let _editingTs    = 0;       // original message timestamp (for 2-min window)
let _editTimer    = null;    // setInterval for the countdown display
let _mentionActive = false;
let _mentionStart  = -1;
let _searchActive  = false;

/**
 * _readStatusBadge — builds the ✓ / ✓✓ span for sent messages.
 * Reads readBy map safely; never throws.
 * docId is checked for the 'local_' prefix used by optimistic sends —
 * those get a pending indicator instead of a real read/sent status
 * until the server ack reconciles them (see sendMessage / _reconcileSentMessage).
 */
function _readStatusBadge(data, docId) {
  if (docId && String(docId).startsWith('local_')) {
    return '<span class="msg-status msg-status-pending" title="Sending…">Sending…</span>';
  }
  try {
    const readBy  = data.readBy || {};
    const sender  = data.senderId || '';
    const readers = Object.keys(readBy).filter(uid => uid !== sender && uid !== state.me?.id);
    // Also count if any uid other than sender has read
    const allReaders = Object.keys(readBy).filter(uid => uid !== sender);
    const hasRead = allReaders.length > 0;
    const cls   = hasRead ? ' msg-status-read' : '';
    const title = hasRead ? `Read by ${allReaders.length} member${allReaders.length !== 1 ? 's' : ''}` : 'Sent';
    const tick  = hasRead ? '✓✓' : '✓';
    return `<span class="msg-status${cls}" title="${title}">${tick}</span>`;
  } catch { return '<span class="msg-status">✓</span>'; }
}

async function renderMsg(data, docId, insertBeforeEl) {
  const area = $('messages-area'); if (!area) return;

  if (data.type === 'chunk' || (data.groupId && data.chunkOf > 1)) {
    assembleChunk(data, docId); return;
  }

  const isMine = data.senderId === state.me?.id;

  if (data.type === 'system') {
    const div = document.createElement('div');
    div.className = 'msg-system';
    // data-ts/data-doc-id so _runExpirySweep (message TTL) can find and
    // delete this too — without these, system messages ("X joined",
    // "Key rotated", etc.) were completely invisible to that selector and
    // never got cleaned up even after every regular message had vanished
    // under the same TTL, silently outliving the "vanish" promise.
    div.dataset.docId = docId || '';
    div.dataset.ts    = data.ts || '';
    // Always decrypt — never render the raw enc field as plaintext.
    // This blocks injected system messages via direct Firestore REST writes
    // (Attack 4): an injected message without the room code will fail
    // AES-GCM auth tag verification and render as '[encrypted]'.
    const text = await dec(data.enc, state.roomCode);
    div.innerHTML = `<span>${esc(text)}</span>`;
    (insertBeforeEl && insertBeforeEl.parentNode === area) ? area.insertBefore(div, insertBeforeEl) : area.appendChild(div);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className    = `msg-wrapper ${isMine ? 'sent' : 'received'}`;
  wrap.dataset.docId    = docId || '';
  wrap.dataset.senderId = data.senderId || '';
  wrap.dataset.ts       = data.ts || '';
  wrap.dataset.type     = data.type || 'text';
  wrap.dataset.fileName = data.fileName || '';
  // Long-press to select (runs once per element)
  if (docId && !wrap.dataset.lpWired) { wrap.dataset.lpWired='1'; _wireLongPress(wrap, docId); }

  // Already-deleted message (e.g. a new member loading history that
  // includes a message someone deleted before they joined) — render the
  // tombstone directly. Its enc/encData is stripped server-side by
  // _softDeleteRemote, so there's nothing to decrypt or build a real
  // bubble from; skip straight past all the type-specific branches below.
  if (data.deleted) {
    wrap.classList.add('deleted');
    wrap.innerHTML = `
      <div class="msg-bubble-wrap">
        <div class="msg-bubble"><span class="msg-deleted-text">This message was deleted</span></div>
      </div>`;
    (insertBeforeEl && insertBeforeEl.parentNode === area) ? area.insertBefore(wrap, insertBeforeEl) : area.appendChild(wrap);
    return;
  }

  // Decoded text (used for reply preview)
  const plainText = data.type === 'text' ? await dec(data.enc, state.roomCode) : null;

  let bubble = '';
  let replyQuote = '';

  // Render quoted reply if this message has one
  if (data.replyTo) {
    let rqContent = '';
    const mt = data.replyTo.mediaType;
    if (mt === 'image') {
      rqContent = `<div class="rq-media"><svg viewBox="0 0 20 20" fill="none" width="12" height="12"><path d="M2 7a2 2 0 012-2h.5l1-2h5l1 2H17a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V7z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="11" r="2.5" stroke="currentColor" stroke-width="1.4"/></svg> Photo</div>`;
    } else if (mt === 'video') {
      rqContent = `<div class="rq-media"><svg viewBox="0 0 20 20" fill="none" width="12" height="12"><rect x="2" y="5" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M14 9l4-2v6l-4-2V9z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg> Video</div>`;
    } else if (mt === 'file') {
      const isPdf = (data.replyTo.fileName || '').toLowerCase().endsWith('.pdf');
      const label = isPdf ? 'PDF' : 'File';
      const fname = data.replyTo.fileName ? ': ' + esc(data.replyTo.fileName.length > 20 ? data.replyTo.fileName.slice(0, 20) + '…' : data.replyTo.fileName) : '';
      rqContent = `<div class="rq-media"><svg viewBox="0 0 20 20" fill="none" width="12" height="12"><path d="M4 4a2 2 0 012-2h5l5 5v9a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" stroke="currentColor" stroke-width="1.4"/><path d="M11 2v5h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg> ${label}${fname}</div>`;
    } else {
      const qText = data.replyTo.enc ? await dec(data.replyTo.enc, state.roomCode) : '';
      rqContent = `<div class="rq-text">${esc(qText.length > 60 ? qText.slice(0, 60) + '…' : qText)}</div>`;
    }
    replyQuote = `
      <div class="reply-quote" data-goto="${esc(data.replyTo.docId || '')}">
        <div class="rq-sender">${esc(data.replyTo.senderName || '')}</div>
        ${rqContent}
      </div>`;
  }

  if (data.type === 'text') {
    bubble = renderTextContent(plainText) + (data.edited ? '<span class="msg-edited"> ✎</span>' : '');
  } else if (data.type === 'image' || data.type === 'video' || data.type === 'file') {
    if (data.encData) {
      const uid = 'med_' + (data.ts||Date.now()) + '_' + Math.random().toString(36).slice(2,5);
      bubble = buildMediaPlaceholder(uid, data);
      // Lazy decrypt: only run when placeholder scrolls into view
      _lazyDecrypt(uid, data);
    } else {
      bubble = `<div class="msg-media-err">Media unavailable</div>`;
    }
  }

  const senderLine = !isMine
    ? `<div class="msg-sender" style="color:${esc(data.senderColor||'#4ecdc4')}">${esc(data.senderName||'')}</div>`
    : '';

  // Reply icon (shows on hover/touch)
  const replyBtn = `<button class="msg-reply-btn" aria-label="Reply" tabindex="-1">
    <svg viewBox="0 0 20 20" fill="none" width="14" height="14">
      <path d="M8 5L4 9l4 4M4 9h8a4 4 0 010 8h-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>`;

  // Emoji react button
  const reactBtn = `<button class="msg-reply-btn msg-react-btn" aria-label="React" tabindex="-1">
    <svg viewBox="0 0 20 20" fill="none" width="14" height="14">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.5"/>
      <path d="M7 12c.5 1.5 5.5 1.5 6 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <circle cx="7.8" cy="8.5" r="1" fill="currentColor"/>
      <circle cx="12.2" cy="8.5" r="1" fill="currentColor"/>
    </svg>
  </button>`;

  wrap.innerHTML = `
    <div class="msg-swipe-wrapper">
      <div class="msg-reply-indicator">
        <svg viewBox="0 0 20 20" fill="none" width="18" height="18">
          <path d="M8 5L4 9l4 4M4 9h8a4 4 0 010 8h-2" stroke="var(--teal)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="msg-bubble-wrap">
        ${!isMine ? `<div class="msg-small-avatar" style="background:${esc(data.senderColor||'#4ecdc4')}">${esc(initials(data.senderName||'?'))}</div>` : ''}
        <div class="msg-inner">
          ${senderLine}
          ${replyQuote}
          <div class="msg-bubble">${bubble}</div>
          <div class="msg-meta">
            <span class="msg-time-sm">${fmtTime(data.ts)}</span>
            ${isMine ? _readStatusBadge(data, docId) : ''}
          </div>
          <div class="msg-reactions" data-rid="${esc(docId || '')}"></div>
        </div>
        <div class="msg-actions">
          ${replyBtn}
          ${reactBtn}
        </div>
      </div>
    </div>`;

  // Wire reply button — supports text and media messages
  wrap.querySelector('.msg-reply-btn:not(.msg-react-btn)')?.addEventListener('click', e => {
    e.stopPropagation();
    if (plainText !== null) {
      setReply(data.senderName || 'Someone', plainText, wrap.dataset.docId);
    } else if (data.type === 'image' || data.type === 'video' || data.type === 'file') {
      setReply(data.senderName || 'Someone', '', wrap.dataset.docId, data.type, data.fileName);
    }
  });

  // Wire react button
  wrap.querySelector('.msg-react-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    showInlineActions(wrap, wrap.dataset.docId, plainText, data.ts, isMine);
  });

  // Wire reply-quote click → scroll to original message
  wrap.querySelector('.reply-quote[data-goto]')?.addEventListener('click', e => {
    e.stopPropagation();
    scrollToMsg(e.currentTarget.dataset.goto);
  });

  // Long-press → inline action strip (emoji bar + reply + edit + delete)
  // Works on own AND other messages. Delete only shown for own messages.
  {
    const targets = [
      wrap.querySelector('.msg-bubble'),
      wrap.querySelector('.msg-media'),
      wrap.querySelector('.msg-file'),
      wrap.querySelector('.video-thumb'),
    ].filter(Boolean);

    targets.forEach(el => {
      let pressTimer = null;
      el.addEventListener('touchstart', () => {
        pressTimer = setTimeout(() => {
          pressTimer = null;
          if (wrap.classList.contains('deleted')) return; // no react/reply/edit on a tombstone
          if (navigator.vibrate) navigator.vibrate(18);
          showInlineActions(wrap, docId, plainText, data.ts, isMine);
        }, 480);
      }, { passive: true });
      el.addEventListener('touchend',  () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }, { passive: true });
      el.addEventListener('touchmove', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }, { passive: true });
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (wrap.classList.contains('deleted')) return;
        showInlineActions(wrap, docId, plainText, data.ts, isMine);
      });
    });
  }

  // Render any existing reactions (e.g. loaded from cache)
  if (data.reactions && Object.keys(data.reactions).length > 0) {
    const reactRow = wrap.querySelector('.msg-reactions');
    if (reactRow) renderReactionsInto(reactRow, data.reactions, docId);
  }

  // Swipe-left-to-reply gesture on the bubble
  addSwipeReply(wrap, data, plainText);

  (insertBeforeEl && insertBeforeEl.parentNode === area) ? area.insertBefore(wrap, insertBeforeEl) : area.appendChild(wrap);
  if (data.sig && data.type === 'text') {
    // D3: verify signature after DOM paint (async, non-blocking)
    requestAnimationFrame(() => verifyAndBadge(data, docId));
  }
}

// ── Lazy decrypt via IntersectionObserver ──────────────────────────────────
// Only decrypts media when the placeholder element enters the viewport.
// Falls back to setTimeout on browsers without IntersectionObserver.
// Use Map to store encData — avoids huge DOM dataset attributes that break large files
const _lazyDataMap = new Map(); // uid → {encData,mime,type,fileName}

const _lazyIO = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver((entries, obs) => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        obs.unobserve(en.target);
        const uid  = en.target.dataset.lazyUid;
        const data = uid && _lazyDataMap.get(uid);
        if (data) {
          _lazyDataMap.delete(uid);
          decryptAndShow(data.encData, data.mime, data.type, data.fileName, uid);
        }
      });
    }, { rootMargin: '400px' })  // pre-load 400px ahead
  : null;

function _lazyDecrypt(uid, data) {
  const _do = () => {
    _log('debug', '[MIUT media] decrypting now (poll gave up or no IntersectionObserver):', uid, { type: data.type, hasEncData: !!data.encData });
    decryptAndShow(data.encData, data.mime || 'application/octet-stream', data.type, data.fileName, uid);
  };
  if (!data.encData) {
    _log('warn', '[MIUT media] _lazyDecrypt called with no encData at all — this message will show "Media unavailable":', uid, data);
  }
  if (!_lazyIO) { setTimeout(_do, 60); return; }
  // Store in Map (NOT dataset) to avoid attribute size limits on large base64
  _lazyDataMap.set(uid, {
    encData:  data.encData || '',
    mime:     data.mime    || 'application/octet-stream',
    type:     data.type    || 'file',
    fileName: data.fileName || '',
  });
  // Poll until placeholder DOM element exists, then observe
  let tries = 0;
  const poll = setInterval(() => {
    const el = document.getElementById(uid);
    if (el) {
      clearInterval(poll);
      el.dataset.lazyUid = uid; // tiny marker only
      _lazyIO.observe(el);
      _log('debug', '[MIUT media] placeholder found, now observing for scroll-into-view:', uid);
    }
    if (++tries > 40) {
      clearInterval(poll);
      _lazyDataMap.delete(uid);
      // This used to silently fall back with no trace of WHY the poll gave
      // up — if the placeholder element genuinely never mounted (e.g. its
      // wrap got removed/replaced by something else before this fired), the
      // fallback _do() below still fires but writes into a domId that may
      // no longer exist, meaning decryptAndShow's own `if (!el) return;`
      // silently no-ops and the media never appears at all — exactly the
      // "disappears, doesn't render" symptom with zero clue why. Logging
      // here at least tells you whether THIS was the failure point.
      _log('warn', '[MIUT media] placeholder element never appeared in the DOM after 2s of polling:', uid, '— falling back to immediate decrypt, but if the element truly never mounts this will still fail silently in decryptAndShow');
      setTimeout(_do, 60);
    }
  }, 50);
}

function buildMediaPlaceholder(uid, data) {
  if (data.type === 'file') return `<div class="msg-media loading" id="${uid}"><div class="media-decrypt-spinner"></div><div class="media-decrypt-label">${esc(data.fileName||'File')} · Decrypting…</div></div>`;
  return `<div class="msg-media loading" id="${uid}"><div class="media-decrypt-spinner"></div><div class="media-decrypt-label">Decrypting ${data.type}…</div></div>`;
}

function assembleChunk(data, docId) {
  const gid = data.groupId;
  if (!gid) { _log('warn', '[MIUT media] chunk doc has no groupId, cannot assemble:', docId, data); return; }
  if (!_chunkGroups[gid]) _chunkGroups[gid] = { parts: {}, total: data.chunkOf, meta: data, docId };
  _chunkGroups[gid].parts[data.chunkIdx] = data.encData;
  if (data.chunkIdx === 0) { _chunkGroups[gid].meta = data; _chunkGroups[gid].docId = docId; }
  const g = _chunkGroups[gid];
  const have = Object.keys(g.parts).length;
  _log('debug', `[MIUT media] chunk ${data.chunkIdx}/${g.total - 1} received for group ${gid} (${have}/${g.total} so far)`);
  if (have === g.total) {
    // Sanity-check every part actually has content before assembling —
    // an empty/undefined part here (e.g. a chunk write that partially
    // failed) would silently produce a corrupted encData string that then
    // fails decryption with no obvious reason.
    const missing = [];
    for (let i = 0; i < g.total; i++) if (!g.parts[i]) missing.push(i);
    if (missing.length) {
      _log('error', `[MIUT media] group ${gid} reports complete (${have}/${g.total}) but part(s) are empty:`, missing, '— assembling anyway, but decryption will likely fail');
    }
    const assembled = Array.from({ length: g.total }, (_, i) => g.parts[i]).join('');
    delete _chunkGroups[gid];
    _log('debug', `[MIUT media] group ${gid} complete, assembled ${assembled.length} chars, rendering now`);
    renderMsg({ ...g.meta, encData: assembled, type: g.meta.type === 'chunk' ? 'file' : g.meta.type }, g.docId);
  }
}

/**
 * _healIncompleteChunkGroups — large images/videos are split across many
 * small Firestore documents (one per chunk, see sendFile). History is
 * fetched in pages (see _HISTORY_PAGE) ordered by time, so it's entirely
 * possible for a file's chunk set to straddle a page boundary — e.g. a new
 * member's initial 100-message fetch contains chunks 0–30 of a 43-chunk
 * video but not 31–42. Without this, assembleChunk's part count never
 * reaches g.total and the media silently never renders — exactly the
 * "image/video doesn't work" symptom. This runs after each history fetch
 * and directly queries by groupId (unrestricted by the page window) for
 * any group still missing pieces, so the file completes regardless of
 * where its chunks happen to fall relative to a page cutoff.
 */
async function _healIncompleteChunkGroups() {
  const gids = Object.keys(_chunkGroups);
  if (!gids.length || !state.roomCode) return;
  for (const gid of gids) {
    const g = _chunkGroups[gid];
    if (!g || Object.keys(g.parts).length >= g.total) continue;
    try {
      const snap = await db.collection('rooms').doc(state.roomCode)
        .collection('messages').where('groupId', '==', gid).get();
      snap.forEach(doc => {
        const d = doc.data();
        if (g.parts[d.chunkIdx] === undefined) {
          g.parts[d.chunkIdx] = d.encData;
          if (d.chunkIdx === 0) { g.meta = d; g.docId = doc.id; }
        }
      });
      // Re-check the group is still pending (another path — e.g. the live
      // listener — could have completed and deleted it while we awaited above).
      if (_chunkGroups[gid] && Object.keys(g.parts).length === g.total) {
        const assembled = Array.from({ length: g.total }, (_, i) => g.parts[i]).join('');
        delete _chunkGroups[gid];
        await renderMsg({ ...g.meta, encData: assembled, type: g.meta.type === 'chunk' ? 'file' : g.meta.type }, g.docId);
      }
    } catch (e) { _log('warn', '[MIUT] Could not heal chunk group', gid, e); }
  }
}

function addSwipeReply(wrap, data, plainText) {
  if (data.type !== 'text') return;  // only swipe-reply on text messages

  const bubbleWrap = wrap.querySelector('.msg-swipe-wrapper');
  const indicator  = wrap.querySelector('.msg-reply-indicator');
  if (!bubbleWrap) return;

  let startX = 0, startY = 0, dx = 0, triggered = false, tracking = false;
  const THRESHOLD = 60;

  bubbleWrap.addEventListener('touchstart', e => {
    if (e.target.closest('button')) return;
    if (wrap.classList.contains('deleted')) return; // can't reply to a tombstone
    startX   = e.touches[0].clientX;
    startY   = e.touches[0].clientY;
    dx       = 0;
    triggered = false;
    tracking  = true;
  }, { passive: true });

  bubbleWrap.addEventListener('touchmove', e => {
    if (!tracking) return;
    dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    // Only swipe LEFT (negative dx) and only if horizontal
    if (Math.abs(dy) > Math.abs(dx) * 0.8 || dx > 0) {
      tracking = false;
      bubbleWrap.style.transform = '';
      if (indicator) indicator.style.opacity = '0';
      return;
    }

    const pull = Math.min(Math.abs(dx), THRESHOLD + 20);
    bubbleWrap.style.transform = `translateX(${-pull}px)`;
    bubbleWrap.style.transition = 'none';
    if (indicator) indicator.style.opacity = String(Math.min(1, pull / THRESHOLD));

    if (pull >= THRESHOLD && !triggered) {
      triggered = true;
      if (navigator.vibrate) navigator.vibrate(20);
    }
  }, { passive: true });

  bubbleWrap.addEventListener('touchend', () => {
    if (!tracking) return;
    tracking = false;
    bubbleWrap.style.transition = 'transform 0.25s cubic-bezier(0.4,0,0.2,1)';
    bubbleWrap.style.transform  = '';
    if (indicator) {
      indicator.style.transition = 'opacity 0.2s';
      indicator.style.opacity    = '0';
    }
    if (triggered && plainText !== null) {
      setReply(data.senderName || 'Someone', plainText, wrap.dataset.docId);
    }
    setTimeout(() => { bubbleWrap.style.transition = ''; }, 260);
  }, { passive: true });
}

/**
 * Soft-delete: replaces a message with a "This message was deleted"
 * tombstone that every member sees, instead of a hard Firestore delete —
 * which used to vanish the doc with zero trace, leaving nobody else in the
 * room any indication a message had even been there.
 *
 * The local bubble updates INSTANTLY (no network wait); the actual
 * Firestore write happens in the background via _softDeleteRemote so
 * deleting never feels like it's blocked on a round trip.
 */
function _softDeleteLocal(wrap) {
  if (!wrap || wrap.classList.contains('deleted')) return;
  wrap.classList.add('deleted');
  const bubble = wrap.querySelector('.msg-bubble');
  if (bubble) {
    bubble.innerHTML = '<span class="msg-deleted-text">This message was deleted</span>';
  }
  wrap.querySelector('.msg-reactions')?.remove();
  // A deleted message shouldn't be reactable, replyable, or re-editable —
  // remove the reply/react icon buttons that normally sit beside every
  // bubble (these are separate DOM elements from .msg-bubble itself, so
  // clearing the bubble's content alone left them behind and still
  // clickable on an already-rendered message).
  wrap.querySelector('.msg-actions')?.remove();
}

async function _softDeleteRemote(docId) {
  if (!docId || !state.roomCode || !db) return;
  try {
    await db.collection('rooms').doc(state.roomCode).collection('messages').doc(docId).update({
      deleted: true,
      deletedBy: state.me?.id || null,
      deletedAt: ts_now(),
      enc: null, encData: null, fileName: null, mime: null, groupId: null, reactions: null,
    });
  } catch (e) { _log('warn', '[MIUT] Soft-delete failed:', e); }
  // Local IDB cache no longer needs the (now-stripped) content either
  try {
    const db2 = await openIDB();
    await new Promise(res => {
      const tx = db2.transaction('msgs', 'readwrite');
      tx.objectStore('msgs').delete(docId);
      tx.oncomplete = res;
    });
  } catch {}
}

async function confirmDeleteMsg(docId, wrapEl) {
  if (!docId || !state.roomCode) return;
  const ok = await showConfirm('Delete message?', 'This removes it for everyone — replaced with "This message was deleted".', 'DELETE');
  if (!ok) return;
  _softDeleteLocal(wrapEl);     // instant — no network wait
  _softDeleteRemote(docId);     // background
  _renderedIds.delete(docId);
}

function scrollToMsg(docId) {
  if (!docId) return;
  const el = document.querySelector(`.msg-wrapper[data-doc-id="${CSS.escape(docId)}"]`);
  if (!el) { toast('Message not in view', 'Scroll up to find it.', 'up'); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 2000);
}

async function patchMsg(id, data) {
  const wrapEl = document.querySelector(`.msg-wrapper[data-doc-id="${CSS.escape(id)}"]`);
  if (!wrapEl) return;
  if (data.deleted) { _softDeleteLocal(wrapEl); return; } // tombstone — nothing else to patch
  const reactRow = wrapEl.querySelector('.msg-reactions');
  if (reactRow) renderReactionsInto(reactRow, data.reactions || {}, id);
  if (data.readBy) _renderReadBadge(wrapEl, data.readBy);
  if (data.edited && data.type === 'text') {
    const bubble = wrapEl.querySelector('.msg-bubble');
    if (bubble) bubble.innerHTML = renderTextContent(await dec(data.enc, state.roomCode)) + '<span class="msg-edited"> ✎</span>';
    if (data.sig) requestAnimationFrame(() => verifyAndBadge(data, id));
  }
}
function renderTextContent(text) {
  let html = esc(text).replace(/\n/g, '<br>');

  // Linkify URLs before the @mention pass below, stashing them behind
  // placeholder tokens first. Without this, a URL containing "@" (e.g. a
  // mailto: or user@host link) would get its own text mangled by the
  // mention regex mid-substitution, since both operate on the same string.
  //
  // Matches http(s)/www URLs AND bare domains typed with no prefix at all
  // (e.g. "highwayrush.pages.dev") — the latter needs a curated TLD list to
  // avoid false-positiving on ordinary prose like "e.g." or "Mr. Smith".
  // List favors common gTLDs, a handful of ccTLDs, and popular free-hosting
  // second-level suffixes (pages.dev, vercel.app, etc).
  const _TLDS = '(?:com|org|net|edu|gov|mil|int|io|dev|app|co|me|xyz|info|biz|name|pro|tech|online|site|store|space|club|live|life|world|art|blog|shop|cloud|ai|to|gg|tv|fm|so|sh|it|ly|is|us|uk|ca|in|au|de|fr|jp|cn|nl|se|no|ru|br|es|it|ch|pages\\.dev|vercel\\.app|netlify\\.app|github\\.io|web\\.app|firebaseapp\\.com|workers\\.dev)';
  const urlRe = new RegExp(
    '\\b(?:https?:\\/\\/[^\\s<]+' +                                                    // scheme-prefixed
    '|www\\.[^\\s<]+' +                                                                // www.-prefixed
    '|(?<!@)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+' + _TLDS + '(?:\\/[^\\s<]*)?' + // bare domain, curated TLDs, not an email's domain half
    ')\\b', 'gi'
  );
  const stash = [];
  html = html.replace(urlRe, raw => {
    // Trim common trailing prose punctuation that isn't really part of the URL
    let url = raw, trail = '';
    const m = url.match(/([.,;:!?)\]]+)$/);
    if (m) { trail = m[1]; url = url.slice(0, -trail.length); }
    if (!url) return raw;
    const href = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    const token = `\u0000${stash.length}\u0000`;
    stash.push(`<a href="${href}" target="_blank" rel="noopener noreferrer nofollow" class="msg-link">${url}</a>${trail}`);
    return token;
  });

  html = html.replace(/@([A-Za-z][A-Za-z0-9]+(?: [A-Za-z][A-Za-z0-9]+)*)/gi, '<span class="mention">@$1</span>');

  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}
// Last known reactions per message, keyed by docId — single source of truth
// used both to actually render and as the base state for optimistic toggles
// below (so a reaction toggle doesn't need to wait on a Firestore round trip
// to know what to render immediately).
const _lastReactionsCache = new Map();

/** Shared double-fire guard for tap targets that wire both touchend and click
 * (some mobile browsers don't reliably suppress the synthetic click after
 * touchend's preventDefault(), firing both for one physical tap). */
function _debounceFire(el) {
  const now = Date.now();
  if (now - (el._miutLastFire || 0) < 500) return true; // already handled this tap
  el._miutLastFire = now;
  return false;
}

async function toggleReaction(docId, emoji) {
  if (!docId || !state.roomCode || !state.me) return;

  // Optimistic: show the toggle immediately using the last known reaction
  // state, instead of waiting for the transaction below to round-trip.
  // Runs in the background; the live listener → patchMsg reconciles with
  // the authoritative result once it lands (or this rolls back on failure).
  const wrap     = document.querySelector(`.msg-wrapper[data-doc-id="${CSS.escape(docId)}"]`);
  const reactRow = wrap?.querySelector('.msg-reactions');
  if (reactRow) {
    const optimistic = Object.assign({}, _lastReactionsCache.get(docId) || {});
    const users = Object.assign({}, optimistic[emoji] || {});
    if (users[state.me.id]) delete users[state.me.id];
    else users[state.me.id] = state.me.name;
    if (Object.keys(users).length === 0) delete optimistic[emoji];
    else optimistic[emoji] = users;
    renderReactionsInto(reactRow, optimistic, docId);
  }

  try {
    const ref = db.collection('rooms').doc(state.roomCode).collection('messages').doc(docId);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const reactions = Object.assign({}, snap.data().reactions || {});
      const users     = Object.assign({}, reactions[emoji] || {});
      if (users[state.me.id]) delete users[state.me.id];
      else users[state.me.id] = state.me.name;
      if (Object.keys(users).length === 0) delete reactions[emoji];
      else reactions[emoji] = users;
      tx.update(ref, { reactions });
    });
  } catch (e) {
    // Roll back the optimistic guess to whatever's actually in Firestore
    if (reactRow) {
      db.collection('rooms').doc(state.roomCode).collection('messages').doc(docId).get()
        .then(s => renderReactionsInto(reactRow, s.exists ? (s.data()?.reactions || {}) : {}, docId))
        .catch(() => {});
    }
  }
}

function renderReactionsInto(container, reactions, docId) {
  _lastReactionsCache.set(docId, reactions || {});
  container.innerHTML = '';
  const entries = Object.entries(reactions || {}).filter(([, u]) => Object.keys(u).length > 0);
  if (!entries.length) return;
  entries.forEach(([emoji, users]) => {
    const count  = Object.keys(users).length;
    const hasMe  = !!users[state.me?.id];
    const names  = Object.values(users).filter(Boolean).join(', ');
    const btn    = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'reaction-chip' + (hasMe ? ' mine' : '');
    btn.title     = names || emoji;
    // Emoji span — use system emoji font explicitly
    const espan   = document.createElement('span');
    espan.className   = 'reaction-emoji';
    espan.textContent = emoji;
    // Count span
    const rcnt    = document.createElement('span');
    rcnt.className    = 'reaction-count';
    rcnt.textContent  = count;
    btn.appendChild(espan);
    btn.appendChild(rcnt);
    btn.addEventListener('click',    e => { e.stopPropagation(); if (!_debounceFire(btn)) toggleReaction(docId, emoji); });
    btn.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); if (!_debounceFire(btn)) toggleReaction(docId, emoji); }, { passive: false });
    container.appendChild(btn);
  });
}
function showInlineActions(wrap, docId, plainText, msgTs, isMine) {
  // Remove any existing strip
  document.querySelectorAll('.msg-action-strip').forEach(s => s.remove());
  if (navigator.vibrate) try { navigator.vibrate(18); } catch {}

  const strip = document.createElement('div');
  strip.className = 'msg-action-strip';

  // ── Emoji row — WhatsApp/Telegram style ─────────────────────────
  const emojiRow = document.createElement('div');
  emojiRow.className = 'strip-emojis';

  // Unified reaction handler — works for both click and touch
  function _reactWith(emoji) {
    toggleReaction(docId, emoji);
    strip.remove();
    // Reacting is a single, complete action — leaving multi-select open
    // afterward (if it happened to be active) is confusing, so close it too.
    if (_selectMode) _exitSelectMode();
  }

  // Makes a quick-react OR grid emoji button
  function makeEmojiBtn(emoji, isGrid) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = isGrid ? 'strip-emoji-grid-btn' : 'strip-emoji';
    btn.textContent = emoji;
    btn.setAttribute('aria-label', 'React with ' + emoji);
    let _touched = false;
    // Guard against double-fire: touchend calls preventDefault() specifically
    // to suppress the browser's synthetic click that normally follows a tap,
    // but some mobile browsers (notably some Android WebViews) don't reliably
    // honor that, firing both handlers for one physical tap. Since reacting
    // is a TOGGLE, a double-fire adds the reaction then immediately removes
    // it again — which looked like tapping an emoji "only selected" it
    // instead of reacting, and cost an extra round trip on top (the "slow"
    // report). This timestamp guard makes whichever event fires first win.
    btn.addEventListener('touchstart', () => { _touched = false; }, { passive: true });
    btn.addEventListener('touchmove',  () => { _touched = true;  }, { passive: true });
    btn.addEventListener('touchend',   e => {
      e.preventDefault(); e.stopPropagation();
      if (!_touched && !_debounceFire(btn)) _reactWith(emoji); // only fire if not a scroll
    }, { passive: false });
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (!_debounceFire(btn)) _reactWith(emoji);
    });
    return btn;
  }

  // 8 quick emojis
  REACTION_EMOJIS.forEach(e2 => emojiRow.appendChild(makeEmojiBtn(e2, false)));

  // ➕ More button
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'strip-emoji-more';
  moreBtn.setAttribute('aria-label', 'More reactions');
  moreBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" width="14" height="14"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  let _gridOpen = false;
  let _grid = null;

  function _openGrid() {
    if (_grid && strip.contains(_grid)) return; // already open
    _grid = document.createElement('div');
    // Add 'open' (which adds the extra padding) BEFORE measuring height,
    // not after — measuring without that padding then adding it mid-animation
    // made the animated max-height ceiling too short, clipping the last
    // emoji row via overflow:hidden once the padding kicked in.
    _grid.className = 'strip-emoji-grid open';
    EXTENDED_EMOJIS.forEach(e2 => _grid.appendChild(makeEmojiBtn(e2, true)));
    const divider = strip.querySelector('.strip-divider');
    if (divider) strip.insertBefore(_grid, divider);
    else strip.appendChild(_grid);
    // Animate open — measured height now correctly includes final padding
    const h = _grid.scrollHeight;
    _grid.style.maxHeight = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      _grid.style.maxHeight = h + 'px';
    }));
    moreBtn.classList.add('active');
    _gridOpen = true;
  }

  function _closeGrid() {
    if (!_grid) return;
    _grid.style.maxHeight = '0';
    _grid.classList.remove('open');
    moreBtn.classList.remove('active');
    _gridOpen = false;
    setTimeout(() => { if (_grid && _grid.parentNode) _grid.remove(); _grid = null; }, 240);
  }

  function _toggleGrid() {
    _gridOpen ? _closeGrid() : _openGrid();
  }

  let _moreTouched = false;
  moreBtn.addEventListener('touchstart', () => { _moreTouched = false; }, { passive: true });
  moreBtn.addEventListener('touchmove',  () => { _moreTouched = true;  }, { passive: true });
  moreBtn.addEventListener('touchend', e => {
    e.preventDefault(); e.stopPropagation();
    if (!_moreTouched) _toggleGrid();
  }, { passive: false });
  moreBtn.addEventListener('click', e => { e.stopPropagation(); _toggleGrid(); });

  emojiRow.appendChild(moreBtn);
  strip.appendChild(emojiRow);

  // Divider
  const div = document.createElement('div');
  div.className = 'strip-divider';
  strip.appendChild(div);

  // Action buttons row
  const actRow = document.createElement('div');
  actRow.className = 'strip-actions';

  const replyBtn = document.createElement('button');
  replyBtn.className = 'strip-action';
  replyBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" width="15" height="15"><path d="M8 5L4 9l4 4M4 9h8a4 4 0 010 8h-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Reply</span>`;
  replyBtn.addEventListener('click', e => {
    e.stopPropagation();
    strip.remove();
    const senderName = wrap.querySelector('.msg-sender')?.textContent?.trim() || 'Someone';
    if (plainText !== null) setReply(senderName, plainText, docId);
    else {
      const mediaType = wrap.dataset.type || null;
      const fileName  = wrap.dataset.fileName || null;
      setReply(senderName, '', docId, mediaType, fileName);
    }
  });
  actRow.appendChild(replyBtn);

  if (isMine) {
    const canEdit = plainText !== null && (Date.now() - (msgTs || 0)) < CONFIG.EDIT_WINDOW_MS;
    if (canEdit) {
      const secsLeft = Math.floor((CONFIG.EDIT_WINDOW_MS - (Date.now() - (msgTs || 0))) / 1000);
      const editBtn = document.createElement('button');
      editBtn.className = 'strip-action';
      editBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" width="15" height="15"><path d="M13.5 3.5l3 3L7 16H4v-3L13.5 3.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span>Edit <small>${fmtEditSecs(secsLeft)}</small></span>`;
      editBtn.addEventListener('click', e => {
        e.stopPropagation();
        strip.remove();
        startEdit(docId, plainText, wrap, msgTs);
      });
      actRow.appendChild(editBtn);
    }
  }

  strip.appendChild(actRow);

  // "Delete for me" is always available (local-only, no confirm needed —
  // it never touches Firestore or affects anyone else's view). "Delete for
  // everyone" needs your own message OR admin standing, since admins can
  // moderate others' messages too (see _updateSelectBar for the same rule
  // in the bulk-select toolbar).
  const canDeleteForEveryone = isMine || _isAdmin;
  if (isMine || _isAdmin) {
    const delRow = document.createElement('div');
    delRow.className = 'strip-delete-row';

    const delMeBtn = document.createElement('button');
    delMeBtn.className = 'strip-action danger';
    delMeBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" width="15" height="15"><path d="M4 6h12M8 6V4h4v2M7 6v9a1 1 0 001 1h4a1 1 0 001-1V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Delete for Me</span>`;
    delMeBtn.addEventListener('click', e => {
      e.stopPropagation();
      strip.remove();
      wrap.remove(); // local-only — doesn't touch Firestore, no confirm needed
    });
    delRow.appendChild(delMeBtn);

    if (canDeleteForEveryone) {
      const delAllBtn = document.createElement('button');
      delAllBtn.className = 'strip-action danger';
      delAllBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" width="15" height="15"><path d="M4 6h12M8 6V4h4v2M7 6v9a1 1 0 001 1h4a1 1 0 001-1V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Delete for Everyone</span>`;
      delAllBtn.addEventListener('click', e => {
        e.stopPropagation();
        strip.remove();
        confirmDeleteMsg(docId, wrap);
      });
      delRow.appendChild(delAllBtn);
    }

    strip.appendChild(delRow);
  }

  // Smart positioning: right/left based on sender, above/below based on viewport space
  strip.dataset.side = isMine ? 'sent' : 'received';
  wrap.style.position = 'relative';
  wrap.appendChild(strip);
  requestAnimationFrame(() => {
    strip.classList.add('visible');
    // Measure available space and flip if strip would go off-screen
    const wrapRect  = wrap.getBoundingClientRect();
    const stripH    = strip.offsetHeight || 200;
    const vpH       = window.innerHeight;
    const spaceAbove = wrapRect.top;
    const spaceBelow = vpH - wrapRect.bottom;
    if (spaceAbove < stripH + 20 && spaceBelow > stripH + 20) {
      // Not enough space above — show below the message
      strip.style.bottom = 'auto';
      strip.style.top    = 'calc(100% + 8px)';
      strip.style.transformOrigin = isMine ? 'top right' : 'top left';
    }
    // Horizontal: prevent strip from going off left edge
    const stripRect = strip.getBoundingClientRect();
    if (stripRect.left < 8) {
      strip.style.left  = '0';
      strip.style.right = 'auto';
    } else if (stripRect.right > window.innerWidth - 8) {
      strip.style.right = '0';
      strip.style.left  = 'auto';
    }
  });

  const close = e => {
    if (strip.isConnected && !strip.contains(e.target)) {
      strip.remove();
      document.removeEventListener('click', close);
      document.removeEventListener('touchstart', close);
      document.removeEventListener('keydown', closeKey);
    }
  };
  const closeKey = e => { if (e.key === 'Escape') { strip.remove(); document.removeEventListener('keydown', closeKey); } };
  setTimeout(() => {
    document.addEventListener('click', close);
    document.addEventListener('touchstart', close, { passive: true });
    document.addEventListener('keydown', closeKey);
  }, 60);
}

function showReactionPicker(wrap, docId) {
  const ts    = parseInt(wrap.dataset.ts || '0') || 0;
  const mine  = wrap.classList.contains('sent');
  const bubble = wrap.querySelector('.msg-bubble');
  const plain  = bubble ? (bubble.innerText || null) : null;
  showInlineActions(wrap, docId, plain, ts, mine);
}

function fmtEditSecs(s) {
  if (s <= 0) return '0s';
  return s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;
}

function startEdit(docId, currentText, wrapEl, msgTs) {
  // Clear any existing edit first
  if (_editingDocId) cancelEdit();

  _editingDocId = docId;
  _editingWrap  = wrapEl;
  _editingTs    = msgTs || 0;

  const input = $('msg-input');
  if (input) {
    input.value = currentText;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    input.focus();
  }

  // Show the reply-bar repurposed as edit bar
  const bar = $('reply-bar'), rname = $('reply-sender'), rtext = $('reply-preview');
  if (bar) {
    rname.innerHTML = `✎ Editing message <span id="edit-countdown" class="edit-countdown" title="Edit window closes after 2 minutes"></span>`;
    rtext.textContent = currentText.length > 70 ? currentText.slice(0, 70) + '…' : currentText;
    bar.style.display = 'flex';
    requestAnimationFrame(() => bar.classList.add('visible'));
  }

  wrapEl?.querySelector('.msg-bubble')?.classList.add('editing-highlight');

  // Start the countdown ticker
  clearInterval(_editTimer);
  _editTimer = setInterval(() => {
    const remaining = CONFIG.EDIT_WINDOW_MS - (Date.now() - _editingTs);
    const el = $('edit-countdown');
    if (remaining <= 0) {
      clearInterval(_editTimer); _editTimer = null;
      if (el) el.textContent = '';
      toast('Edit window closed', 'The 2-minute edit window has passed.', 'clock');
      cancelEdit();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    if (el) {
      el.textContent = fmtEditSecs(secs);
      // Turn red below 20 seconds
      el.classList.toggle('urgent', secs <= 20);
    }
  }, 500);
}

function cancelEdit() {
  clearInterval(_editTimer); _editTimer = null;
  _editingWrap?.querySelector('.msg-bubble')?.classList.remove('editing-highlight');
  _editingDocId = null; _editingWrap = null; _editingTs = 0; _replyTo = null;
  const bar = $('reply-bar'); if (!bar) return;
  bar.classList.remove('visible'); setTimeout(() => { bar.style.display = 'none'; }, 250);
  const input = $('msg-input'); if (input) { input.value = ''; input.style.height = 'auto'; }
  updateActionBtn();
}

async function submitEdit() {
  const docId = _editingDocId, input = $('msg-input');
  const text = (input?.value || '').trim();
  if (!text || !docId || !state.roomCode) { cancelEdit(); return; }
  //   request.time < resource.data.createdAt + duration.value(120, 's')
  // The client check below is a UX guard only — it cannot be relied on for security.
  const age = Date.now() - _editingTs;
  if (_editingTs > 0 && age > CONFIG.EDIT_WINDOW_MS + 5000) {
    toast('Edit window closed', 'The 2-minute edit window has passed.', 'clock');
    cancelEdit(); return;
  }

  cancelEdit();
  if (input) { input.value = ''; input.style.height = 'auto'; }
  try {
    const _ets   = Date.now();
    const _eenc  = await enc(text, state.roomCode);
    const _esig  = await signMsg(state.me.id, _ets, _eenc);
    await db.collection('rooms').doc(state.roomCode).collection('messages').doc(docId).update({
      enc: _eenc, edited: true, editedAt: ts_now(), sig: _esig, ts: _ets,
    });
  } catch(e) { toast('Edit failed', e.message, 'err'); }
}

function handleMentionInput(input) {
  const val = input.value, pos = input.selectionStart;
  let atIdx = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (val[i] === '@') { atIdx = i; break; }
    if (val[i] === ' ' || val[i] === '\n') break;
  }
  if (atIdx === -1) { hideMentionDropdown(); return; }
  const query = val.slice(atIdx + 1, pos).toUpperCase();
  const matches = _memberNames.filter(n => n.toUpperCase().startsWith(query));
  if (!matches.length) { hideMentionDropdown(); return; }
  _mentionActive = true; _mentionStart = atIdx;
  showMentionDropdown(matches, input);
}

function showMentionDropdown(names, input) {
  let dd = $('mention-dropdown');
  if (!dd) {
    dd = document.createElement('div'); dd.id = 'mention-dropdown'; dd.className = 'mention-dropdown';
    $('input-area')?.insertAdjacentElement('beforebegin', dd);
  }
  dd.innerHTML = '';
  names.slice(0, 5).forEach(name => {
    const btn = document.createElement('button'); btn.className = 'mention-item';
    btn.innerHTML = `<div class="mention-av" style="background:${avatarColor(name)}">${esc(initials(name))}</div><span>${esc(name)}</span>`;
    btn.addEventListener('mousedown', e => { e.preventDefault(); insertMention(name, input); });
    dd.appendChild(btn);
  });
  dd.style.display = 'flex';
}

function hideMentionDropdown() {
  _mentionActive = false; _mentionStart = -1;
  const dd = $('mention-dropdown'); if (dd) dd.style.display = 'none';
}

function insertMention(name, input) {
  const val = input.value, pos = input.selectionStart;
  const before = val.slice(0, _mentionStart) + '@' + name + ' ';
  input.value = before + val.slice(pos);
  const np = before.length; input.setSelectionRange(np, np);
  hideMentionDropdown(); input.focus();
}

function toggleSearch() {
  _searchActive = !_searchActive;
  const bar = $('search-bar'); if (!bar) return;
  if (_searchActive) {
    bar.style.display = 'flex'; requestAnimationFrame(() => bar.classList.add('visible'));
    bar.querySelector('input')?.focus(); $('search-btn')?.classList.add('active');
  } else {
    bar.classList.remove('visible'); setTimeout(() => { bar.style.display = 'none'; }, 250);
    clearSearch(); $('search-btn')?.classList.remove('active');
  }
}

let _searchDebounceTimer = null;
function doSearch(query) {
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    const q = (query || '').toLowerCase().trim();
    let matchCount = 0;
    document.querySelectorAll('.msg-wrapper').forEach(w => {
      if (!q) { w.style.display = ''; return; }
      const txt = (w.querySelector('.msg-bubble')?.textContent || '').toLowerCase();
      const match = txt.includes(q);
      w.style.display = match ? '' : 'none';
      if (match) matchCount++;
    });
    const c = $('search-count');
    if (c) c.textContent = q ? `${matchCount} result${matchCount !== 1 ? 's' : ''}` : '';
  }, 120);
}

function clearSearch() {
  document.querySelectorAll('.msg-wrapper').forEach(w => w.style.display = '');
  const inp = $('search-bar')?.querySelector('input'); if (inp) inp.value = '';
  const c = $('search-count'); if (c) c.textContent = '';
}
async function decryptAndShow(encData, mime, type, fileName, domId) {
  if (!encData) {
    _log('warn', '[MIUT media] decryptAndShow called with empty/missing encData — nothing to decrypt:', domId, { type, fileName });
    const el0 = $(domId);
    if (el0) el0.innerHTML = `<div style="padding:8px;color:var(--text2);font-size:.7rem">Media unavailable</div>`;
    return;
  }
  const cacheKey = 'blob_' + btoa(encData.slice(0, 32).replace(/[^a-zA-Z0-9]/g,'').padEnd(8,'0')).slice(0,16);

  let url = null;

  // Check IDB for cached bytes first
  const cachedBytes = await idbGetBlob(cacheKey).catch(e => { _log('debug', '[MIUT media] IDB cache miss/error (not fatal, will re-decrypt):', domId, e); return null; });
  if (cachedBytes) {
    try {
      const blob = new Blob([cachedBytes], { type: mime });
      url = URL.createObjectURL(blob);
      _log('debug', '[MIUT media] served from IDB cache:', domId);
    } catch (e) { _log('debug', '[MIUT media] cached blob construction failed, falling through to re-decrypt:', domId, e); }
  }

  if (!url) {
    try {
      const blob  = await decBytes(encData, mime, state.roomCode);
      url = URL.createObjectURL(blob);
      // Store raw bytes (not the blob: URL) so cache survives page reloads
      const arrBuf = await blob.arrayBuffer();
      await idbSetBlob(cacheKey, new Uint8Array(arrBuf));
      _log('debug', '[MIUT media] decrypted fresh and cached:', domId, { bytes: arrBuf.byteLength });
    } catch (e) {
      // This is the single most likely place for "the file is in Firestore
      // but never renders" to actually originate — decBytes throws for
      // several distinct reasons (wrong/rotated epoch key, corrupted/
      // truncated encData from an incompletely-healed chunk group, a
      // malformed base64 payload) that all looked identical from the UI:
      // just a quiet "This message could not be decrypted" with nothing in
      // the console before now. Logging the real error here is the key
      // diagnostic for tracking that bug down for real.
      _log('error', '[MIUT media] decryption FAILED — this is why the media never rendered:', domId, { type, mime, encDataLength: encData?.length }, e);
      const el = $(domId);
      if (el) el.innerHTML = `<div style="padding:8px;color:var(--text2);font-size:.7rem">This message could not be decrypted</div>`;
      return;
    }
  }

  const el = $(domId);
  if (!el) {
    _log('warn', '[MIUT media] decryption succeeded but the placeholder element is gone from the DOM — media decrypted into nothing:', domId, '(the wrap was likely removed/replaced — e.g. re-rendered, deleted, or the room was left — between when decrypt started and finished)');
    return;
  }

  if (type === 'image') {
    // esc() escapes HTML entities, not JS string chars — fragile inside onclick="...".
    const img = document.createElement('img');
    img.src = url; img.alt = 'image'; img.loading = 'lazy'; img.style.cursor = 'pointer';
    img.addEventListener('click', () => openViewer('img', url));
    const hint = document.createElement('div');
    hint.className = 'media-tap-hint'; hint.textContent = 'Tap to expand';
    el.innerHTML = ''; el.appendChild(img); el.appendChild(hint);
    el.classList.remove('loading');

  } else if (type === 'video') {
    const thumb = document.createElement('div');
    thumb.className = 'video-thumb';
    thumb.innerHTML = `<div class="video-play-btn"><svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M8 5v14l11-7z"/></svg></div><div class="video-label">${esc(fileName||'Video')}</div>`;
    thumb.addEventListener('click', () => openViewer('video', url));
    el.innerHTML = ''; el.appendChild(thumb);
    el.classList.remove('loading');

  } else {
    // File — show download link
    const size = esc(fmtBytes(el.dataset?.size || 0));
    el.outerHTML = `<a class="msg-file" href="${esc(url)}" download="${esc(fileName||'file')}" target="_blank" rel="noopener">
      <div class="file-icon"><svg viewBox="0 0 20 20" fill="none" width="22" height="22">
        <path d="M4 4a2 2 0 012-2h5l5 5v9a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" stroke="currentColor" stroke-width="1.5"/>
        <path d="M11 2v5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg></div>
      <div class="file-info">
        <div class="file-name">${esc(fileName||'File')}</div>
      </div>
      <div class="file-dl"><svg viewBox="0 0 20 20" fill="none" width="16" height="16">
        <path d="M10 3v10M6 9l4 4 4-4M4 17h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg></div>
    </a>`;
  }
}

function showScrollFab() {
  const area = $('messages-area');
  const fab   = $('scroll-fab');
  if (!area || !fab) return;
  const fromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
  if (fromBottom > 120) {
    fab.style.display = 'flex';
    requestAnimationFrame(() => fab.classList.add('visible'));
    const badge = $('scroll-fab-badge');
    if (badge) {
      badge.textContent = _unreadCount > 0 ? (_unreadCount > 9 ? '9+' : _unreadCount) : '';
      badge.style.display = _unreadCount > 0 ? 'flex' : 'none';
    }
  }
}

function hideScrollFab() {
  const fab = $('scroll-fab');
  if (!fab) return;
  fab.classList.remove('visible');
  setTimeout(() => { if (!fab.classList.contains('visible')) fab.style.display = 'none'; }, 250);
}

function initScrollFab() {
  const area = $('messages-area');
  const fab  = $('scroll-fab');
  if (!area || !fab) return;
  area.addEventListener('scroll', () => {
    const fromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
    if (fromBottom < 60) { hideScrollFab(); _markVisibleAsRead(); }
  }, { passive: true });
  fab.addEventListener('click', () => { scrollBottom(); hideScrollFab(); });
}


let _scrollDebounce = null;
function scrollBottom() {
  // Debounce: during a batch of message renders only scroll once at the end
  if (_scrollDebounce) return;
  _scrollDebounce = requestAnimationFrame(() => {
    _scrollDebounce = null;
    const a = $('messages-area');
    if (!a) return;
    a.scrollTop = a.scrollHeight;
    hideScrollFab();
    _unreadCount = 0;
    document.title = 'MIUT';
  });
}

function openViewer(type, src) {
  const v = $('media-viewer'), img = $('mv-img'), vid = $('mv-video');
  if (!v) return;
  if (img) { img.src = ''; img.style.display = 'none'; }
  if (vid) { vid.src = ''; vid.style.display = 'none'; }
  if (type === 'img'   && img) { img.src = src; img.style.display = 'block'; }
  if (type === 'video' && vid) { vid.src = src; vid.style.display = 'block'; }
  v.style.display = 'flex';
}
function closeMediaViewer() {
  const v = $('media-viewer'); if (!v) return;
  v.style.display = 'none';
  const vid = $('mv-video'); if (vid) { vid.pause?.(); vid.src = ''; }
  const img = $('mv-img');   if (img) img.src = '';
}

function copyRoomCode() {
  if (!state.roomCode) return;
  const code = state.roomCode, cb = () => toast('Code copied!', code, 'ok');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(code).then(cb).catch(() => fbCopy(code, cb));
  else fbCopy(code, cb);
}

function shareRoomLink() {
  if (!state.roomCode) return;
  // Plain URL encoding — no base64 obfuscation (room code is the key; sharing = sharing)
  const base = window.location.origin + window.location.pathname.replace('index.html', '');
  const url  = `${base}?r=${encodeURIComponent(state.roomCode)}`;

  if (navigator.share) {
    navigator.share({
      title: 'Join my MIUT room',
      text:  "Tap to join — you'll need the room code to get in.",
      url,
    }).catch(() => {});
    return;
  }
  // Desktop: show a mini popup with QR + copy button
  _showSharePopup(url);
}

function _showSharePopup(url) {
  document.querySelectorAll('.share-popup').forEach(e => e.remove());
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&color=4ecdc4&bgcolor=091413&data=${encodeURIComponent(url)}`;
  const pop   = document.createElement('div');
  pop.className = 'share-popup';
  pop.innerHTML = `
    <div class="share-popup-inner">
      <div class="share-popup-title">Share Room</div>
      <img src="${qrUrl}" alt="QR code" width="140" height="140" loading="lazy" style="border-radius:10px;margin:10px auto;display:block"/>
      <div class="share-popup-note">Scan QR or copy link below</div>
      <div class="share-popup-url">${url.slice(0, 52)}…</div>
      <button class="share-popup-copy btn-join" id="share-copy-btn">Copy Invite Link</button>
      <button class="share-popup-close icon-btn" id="share-close-btn" style="position:absolute;top:10px;right:10px">
        <svg viewBox="0 0 20 20" fill="none" width="16" height="16"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>`;
  document.body.appendChild(pop);
  pop.querySelector('#share-copy-btn').addEventListener('click', () => {
    const cb = () => { toast('Invite link copied!', 'Share code privately for security.', 'link'); pop.remove(); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(cb).catch(() => fbCopy(url, cb));
    else fbCopy(url, cb);
  });
  pop.querySelector('#share-close-btn').addEventListener('click', () => pop.remove());
  pop.addEventListener('click', e => { if (e.target === pop) pop.remove(); });
}

function _detectInviteParam() {
  try {
    const p = new URLSearchParams(window.location.search);
    const r = p.get('r');
    if (!r) return null;
    // Support both plain encodeURIComponent (new) and legacy base64 (old links)
    try {
      const decoded = decodeURIComponent(r);
      // If it looks like a valid room code, use it directly
      if (/^[a-zA-Z0-9 _\-@#!?+*=.]{6,64}$/.test(decoded)) return decoded;
    } catch {}
    // Fallback: try base64 decode for old-style invite links
    return decodeURIComponent(escape(atob(r)));
  } catch { return null; }
}

function showInviteScreen() {
  const inp = $('invite-code-input');
  if (inp) { inp.value = ''; inp.type = 'password'; }
  const err = $('invite-error'); if (err) err.textContent = '';
  const btn = $('invite-join-btn'); if (btn) btn.disabled = true;
  showScreen('invite-screen');
}

function cancelInvite() {
  window.history.replaceState({}, '', window.location.pathname);
  showScreen('join-screen');
}

function checkInviteCode(el) {
  const btn = $('invite-join-btn');
  const err = $('invite-error'); if (err) err.textContent = '';
  const code = el.value.trim();
  if (btn) btn.disabled = !_ROOM_CODE_RE.test(code) || code.length < 6;
}

async function joinFromInvite() {
  const inp  = $('invite-code-input');
  const code = (inp?.value || '').trim();
  const err  = $('invite-error');
  if (!validateRoomCode(code)) {
    if (err) err.textContent = 'Room code contains invalid characters.';
    return;
  }
  if (!(await checkRateLimit('enter'))) return;

  const btn = $('invite-join-btn');
  if (btn) { btn.disabled = true; const sp = btn.querySelector('span'); if (sp) sp.textContent = 'Joining…'; }

  try {
    // Auth before read — required by Firestore security rules
    const uid = await getUID();
    db = await getDb(code);
    const roomSnap = await db.collection('rooms').doc(code).get();
    if (!roomSnap.exists) {
      _recordWrongCode();
      if (err) err.textContent = 'Room not found — check the code and try again.';
      if (btn) { btn.disabled = false; const sp = btn.querySelector('span'); if (sp) sp.textContent = 'Join Room'; }
      return;
    }
    _saveWrongState({ wrongCount: 0, lockedUntil: 0 });
    if ((roomSnap.data()?.blockedUsers || []).includes(uid)) {
      if (err) err.textContent = 'You have been blocked from this room by an admin.';
      if (btn) { btn.disabled = false; const sp = btn.querySelector('span'); if (sp) sp.textContent = 'Join Room'; }
      return;
    }
    _roomEpoch = roomSnap.data()?.epoch || 0;
    _roomSalt  = roomSnap.data()?.salt  || null;
    { const _iv = roomSnap.data()?.inactivityTtlMs; _roomExpiryMs = _iv !== undefined ? _iv : 300000; }
    _healRoomSchema(code, roomSnap.data()).catch(() => {});
    const memberSnap = await db.collection('rooms').doc(code).collection('members').doc(uid).get();
    const prevData   = memberSnap.exists ? memberSnap.data() : null;
    const wasApproved = prevData?.approved === true;

    state.me = await buildMe(resolveName()); state.roomCode = code;
    saveSession(); saveRoom(code);

    window.history.replaceState({}, '', window.location.pathname);

    if (wasApproved) {
      await registerPresence(prevData.role || 'member', true);
      await sendSys(`${state.me.name} rejoined the room`);
      bootApp();
    } else {
      const approvalRequired = roomSnap.data()?.approvalRequired === true;
      if (approvalRequired) {
        await registerPresence('member', false);
        showWaitingScreen();
      } else {
        await registerPresence('member', true);
        await sendSys(`${state.me.name} joined the room`);
        bootApp();
      }
    }
  } catch(e) {
    const { title, detail, icon } = _classifyError(e);
    if (err) err.textContent = `${icon} ${title} — ${detail}`;
    if (btn) { btn.disabled = false; btn.querySelector('span').textContent = 'JOIN ROOM'; }
  }
}
function fbCopy(text, cb) {
  const el = Object.assign(document.createElement('textarea'), { value: text });
  el.style.cssText = 'position:fixed;left:-9999px;opacity:0';
  document.body.appendChild(el); el.focus(); el.select();
  try { document.execCommand('copy'); cb(); } catch {}
  document.body.removeChild(el);
}

function toggleVis(inputId, btnId) {
  const inp = $(inputId), btn = $(btnId); if (!inp || !btn) return;
  inp.type = inp.type === 'text' ? 'password' : 'text';
  btn.querySelector('.eye-open').style.display  = inp.type === 'password' ? 'block' : 'none';
  btn.querySelector('.eye-closed').style.display = inp.type === 'password' ? 'none'  : 'block';
}

async function _handoffAdminRole(roomCodeOverride, meOverride) {
  // Optional overrides let this run safely in background cleanup after
  // handleLogout has already cleared the global `state` — every reference
  // below uses these captured values, not `state.*`.
  const _roomCode = roomCodeOverride || state.roomCode;
  const _me       = meOverride || state.me;
  if (!_roomCode || !_me) return;
  try {
    const snap = await db.collection('rooms').doc(_roomCode)
      .collection('members')
      .where('online', '==', true)
      .where('approved', '==', true)
      .get();

    let nextUid = null, nextName = null;

    // First try online members
    snap.forEach(doc => {
      if (doc.id !== _me.id && doc.data().role !== 'admin' && !nextUid) {
        nextUid  = doc.id;
        nextName = doc.data().name;
      }
    });

    // If no online members found, fall back to any approved member (even offline)
    if (!nextUid) {
      const allSnap = await db.collection('rooms').doc(_roomCode)
        .collection('members')
        .where('approved', '==', true)
        .get();
      allSnap.forEach(doc => {
        if (doc.id !== _me.id && doc.data().role !== 'admin' && !nextUid) {
          nextUid  = doc.id;
          nextName = doc.data().name;
        }
      });
    }

    if (nextUid) {
      await db.collection('rooms').doc(_roomCode)
        .collection('members').doc(nextUid)
        .update({ role: 'admin' });
      await sendSys(`${nextName} is now an admin ◆`, _roomCode, _me);
    }
  } catch {}
}

async function handleLogout() {
  // Note: this only warns about expiry if leaving would empty the room —
  // if others are still online, the room stays alive regardless of the
  // expiry setting (expiry only counts once everyone has left).
  const _leavingEmptiesRoom = _onlineCount <= 1;
  let _rejoinNote;
  if (!_leavingEmptiesRoom) {
    _rejoinNote = 'You can rejoin using the room code — others are still in the room, so it stays open.';
  } else if (_roomExpiryMs === -1) {
    _rejoinNote = 'You can rejoin at any time using the room code — this room never auto-expires.';
  } else if (_roomExpiryMs === 0) {
    _rejoinNote = "You'll be the last one out — this room deletes instantly once you leave (Room Expiry: Instant).";
  } else {
    _rejoinNote = `You'll be the last one out — this room auto-deletes ${_fmtRoomTtl(_roomExpiryMs)} after you leave, unless someone rejoins first.`;
  }
  const ok = await showConfirm('Leave Room?', _rejoinNote, 'LEAVE');
  if (!ok) return;

  // Snapshot everything the background cleanup below will need — state.*
  // gets cleared in the next few lines so the UI can close instantly.
  const _leavingRoomCode = state.roomCode;
  const _leavingMe       = state.me;
  const _wasAdmin        = state.me?.role === 'admin';

  clearMyTyping();
  clearInterval(_heartbeat);

  // D7: stop approval listener if pending
  if (_unsubApproval) { try { _unsubApproval(); } catch {} _unsubApproval = null; }
  _isAdmin = false;

  // ── Instant local close ────────────────────────────────────────────────
  // Everything below is local-only (no network waits), so the room view
  // closes and the feedback prompt appears immediately, instead of waiting
  // on the Firestore round trips below.
  try {
    stopListeners();
    localStorage.removeItem(CONFIG.SESSION_KEY);
    localStorage.removeItem(CONFIG.ROOM_KEY);
    state.me = null; state.roomCode = null;
    _renderedIds.clear(); _lastCachedTs = 0;

    // PART 4: tear down screen protection on logout
    if (typeof destroyScreenProtection === 'function') {
      try { destroyScreenProtection(); } catch (_e) {}
    }

    const ma = $('messages-area'); if (ma) ma.innerHTML = '';
    const ml = $('members-list');  if (ml) ml.innerHTML = '';
    const oc = $('online-count');  if (oc) oc.textContent = '0';

    closeSidebar();
    showScreen('join-screen');

    [$('input-create-code'), $('input-room-code')].forEach(el => { if (el) el.value = ''; });
    const je = $('join-error'); if (je) je.textContent = '';
    switchJoinTab('create');
  } catch (e) {
    _log('warn', '[MIUT] Logout teardown hit an error (continuing):', e);
  } finally {
    // Ask how the session went — anonymous, skippable, stored in /feedback
    // (a sibling of /rooms in Firestore). Runs even if a step above failed,
    // so a network hiccup never silently swallows the prompt.
    showFeedbackModal(_leavingRoomCode).catch(() => {});
  }

  // ── Background network cleanup (fire-and-forget) ───────────────────────
  // Runs after the UI has already closed. Each step is independently
  // caught — a failure here never affects what the person already sees.
  if (_leavingRoomCode && _leavingMe) {
    (async () => {
      try {
        if (_wasAdmin) await _handoffAdminRole(_leavingRoomCode, _leavingMe);
      } catch (e) { _log('warn', '[MIUT] Admin handoff failed:', e); }

      try {
        await sendSys(`${_leavingMe.name} left the room`, _leavingRoomCode, _leavingMe);
      } catch (e) { _log('warn', '[MIUT] Leave system message failed:', e); }

      try {
        await db.collection('rooms').doc(_leavingRoomCode).collection('members').doc(_leavingMe.id)
          .update({ online: false });
      } catch (e) { _log('warn', '[MIUT] Marking offline failed:', e); }

      // This is the critical piece that makes Room Expiry (Instant, 5 min,
      // etc.) actually take effect: startPresenceListener's empty-room
      // detection only runs on a client that still has an active presence
      // listener, but stopListeners() above already tore this client's
      // down as part of closing instantly. If you're the last person out,
      // nobody's listener is left running to ever notice the room emptied
      // — so without calling this directly here, Instant (and every other
      // Room Expiry setting) silently never fired, and the room stayed
      // rejoinable indefinitely. Calling it explicitly from the leaving
      // client closes that gap regardless of whether anyone else happens
      // to be watching.
      if (_leavingEmptiesRoom) {
        try { await _handleRoomBecameEmpty(_leavingRoomCode); }
        catch (e) { _log('warn', '[MIUT] Empty-room expiry check failed:', e); }
      }
    })();
  }
}

function openSettings() {
  const st = $('sound-toggle'), at = $('anim-toggle');
  const ap = $('approval-toggle'), approvalRow = $('approval-setting-row');
  if (st) st.checked = state.prefs.sound;
  if (at) at.checked = state.prefs.animations;

  const rotateRow = $('rotate-key-row');
  if (approvalRow) approvalRow.style.display = _isAdmin ? 'flex' : 'none';
  if (rotateRow)   rotateRow.style.display   = _isAdmin ? 'flex' : 'none';
  const ttlRow = $('ttl-row');
  if (ttlRow) {
    ttlRow.style.display = _isAdmin ? 'flex' : 'none';
    const sel = $('ttl-select');
    if (sel) {
      const opts = [...sel.options].map(o => +o.value);
      const best = opts.reduce((a, b) => Math.abs(b - _roomTtlMs) < Math.abs(a - _roomTtlMs) ? b : a, 0);
      sel.value = String(best);
    }
    const ttlEl = $('ttl-display'); if (ttlEl) ttlEl.textContent = _fmtTtl(_roomTtlMs);
  }
  const roomTtlRow = $('room-ttl-row');
  if (roomTtlRow) {
    roomTtlRow.style.display = _isAdmin ? 'flex' : 'none';
    const rSel = $('room-ttl-select');
    if (rSel) rSel.value = String(_roomExpiryMs);
    const rTtlEl = $('room-ttl-sublabel'); if (rTtlEl) rTtlEl.textContent = _fmtRoomExpirySentence(_roomExpiryMs);
  }
  const epochEl = $('epoch-display');
  if (epochEl) epochEl.textContent = String(_roomEpoch);

  if (ap && _isAdmin && state.roomCode) {
    ap.checked = false;
    db.collection('rooms').doc(state.roomCode).get()
      .then(s => { if (ap) ap.checked = s.data()?.approvalRequired === true; })
      .catch(() => {});
  }
  $('settings-modal').style.display = 'flex';
}

function closeSettings() { $('settings-modal').style.display = 'none'; }
function closeModal(e)   { if (e.target.classList.contains('modal-overlay')) closeSettings(); }

function saveSettings() {
  localStorage.setItem(CONFIG.PREFS_KEY, JSON.stringify(state.prefs));
  toast('Settings saved', '', 'ok'); closeSettings();
}

function toggleSoundAlerts()   { state.prefs.sound         = $('sound-toggle').checked; }
function toggleAnimations()    { state.prefs.animations    = $('anim-toggle').checked; }

function toggleApprovalGate() {
  if (!_isAdmin || !state.roomCode) return;
  const on = $('approval-toggle')?.checked ?? false;
  db.collection('rooms').doc(state.roomCode)
    .update({ approvalRequired: on })
    .then(() => toast(
      on ? 'Approval gate ON' : 'Approval gate OFF',
      on ? 'New members must be approved' : 'Anyone with the code can join freely',
      on ? 'lock' : '🔓'
    ))
    .catch(() => {});
}


function showConfirm(title, msg, confirmLabel = 'CONFIRM') {
  return new Promise(resolve => {
    $('nx-confirm')?.remove();
    const ov = document.createElement('div');
    ov.id = 'nx-confirm';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);backdrop-filter:blur(6px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface2);border:1px solid var(--teal-border);border-radius:14px;padding:28px 24px;max-width:320px;width:100%;display:flex;flex-direction:column;gap:18px;box-shadow:0 16px 48px rgba(0,0,0,0.6)';
    const h = document.createElement('div'); h.style.cssText = 'font-family:var(--fui);font-size:.9rem;font-weight:700;color:#fff;letter-spacing:1px'; h.textContent = title;
    const m = document.createElement('div'); m.style.cssText = 'font-size:.75rem;color:var(--text2);line-height:1.7;font-family:var(--fmono)'; m.textContent = msg;
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
    const no  = document.createElement('button'); no.textContent = 'CANCEL'; no.style.cssText = 'padding:10px 20px;border-radius:8px;background:transparent;border:1px solid var(--border);color:var(--text2);font-family:var(--fui);font-size:.68rem;font-weight:700;letter-spacing:2px;cursor:pointer';
    const yes = document.createElement('button'); yes.textContent = confirmLabel;  yes.style.cssText = 'padding:10px 20px;border-radius:8px;background:var(--danger);border:1px solid var(--danger);color:#fff;font-family:var(--fui);font-size:.68rem;font-weight:700;letter-spacing:2px;cursor:pointer';
    const done = v => { ov.remove(); resolve(v); };
    no.addEventListener('click', () => done(false));
    yes.addEventListener('click', () => done(true));
    ov.addEventListener('click', e => { if (e.target === ov) done(false); });
    row.append(no, yes); box.append(h, m, row); ov.appendChild(box); document.body.appendChild(ov);
    setTimeout(() => no.focus(), 40);
  });
}

// ─── Post-leave feedback ───────────────────────────────────────────────────
// Firestore layout: feedback lives in its own TOP-LEVEL collection, a sibling
// of 'rooms' — i.e. /rooms/{roomCode} and /feedback/{feedbackId} — rather than
// a subcollection of the room. This is deliberate: a room (and its
// subcollections) can be wiped/auto-deleted a few minutes after everyone
// leaves (see functions/api/cleanup.js), but feedback should outlive that
// cleanup so it can actually be reviewed later. It only stores which
// roomCode it refers to, never a member id/name, matching Miut's
// "no digital footprint" privacy model.
//
// Required Firestore Security Rule (add in Firebase Console → Firestore →
// Rules — there's no firestore.rules file in this repo, rules are managed
// server-side only):
//
//   match /feedback/{feedbackId} {
//     allow create: if request.auth != null
//       && request.resource.data.keys().hasOnly(['roomCode','rating','tags','comment','appVersion','createdAt'])
//       && request.resource.data.rating is int
//       && request.resource.data.rating >= 1 && request.resource.data.rating <= 5
//       && request.resource.data.comment is string
//       && request.resource.data.comment.size() <= 500
//       && request.resource.data.tags is list && request.resource.data.tags.size() <= 6
//       && request.resource.data.createdAt == request.time;
//     allow read, update, delete: if false; // write-only from the client
//   }

let _fbRating = 0;
const _fbTags = new Set();

function _fbResolveEls() {
  return {
    overlay:  $('feedback-modal'),
    roomLbl:  $('feedback-room-code'),
    stars:    $('feedback-stars'),
    ratingLbl:$('feedback-rating-label'),
    tagsWrap: $('feedback-tags'),
    comment:  $('feedback-comment'),
    charCount:$('feedback-charcount'),
    submitBtn:$('feedback-submit-btn'),
    skipBtn:  $('feedback-skip-btn'),
    closeBtn: $('feedback-close-btn'),
  };
}

const _FB_RATING_LABELS = { 0: 'Tap a star to rate', 1: 'Poor', 2: 'Fair', 3: 'Good', 4: 'Great', 5: 'Excellent' };

function _fbRenderStars() {
  const { stars, ratingLbl, submitBtn } = _fbResolveEls();
  if (!stars) return;
  stars.querySelectorAll('.star-btn').forEach(btn => {
    btn.classList.toggle('filled', +btn.dataset.value <= _fbRating);
  });
  if (ratingLbl) {
    ratingLbl.textContent = _FB_RATING_LABELS[_fbRating] || '';
    ratingLbl.classList.toggle('rated', _fbRating > 0);
  }
  if (submitBtn) submitBtn.disabled = _fbRating === 0;
}

function _fbReset() {
  _fbRating = 0;
  _fbTags.clear();
  const { tagsWrap, comment, charCount } = _fbResolveEls();
  if (tagsWrap) tagsWrap.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));
  if (comment) comment.value = '';
  if (charCount) charCount.textContent = '0';
  _fbRenderStars();
}

/**
 * Shows the post-leave feedback modal. Resolves once the user has either
 * submitted, skipped, or dismissed it — never rejects, so callers can just
 * `await` it without a try/catch.
 */
function showFeedbackModal(roomCode) {
  return new Promise(resolve => {
    const { overlay, roomLbl } = _fbResolveEls();
    if (!overlay) { resolve(); return; }

    _fbReset();
    if (roomLbl) roomLbl.textContent = roomCode ? `“${roomCode}”` : 'the room';
    overlay.style.display = 'flex';

    const done = () => { overlay.style.display = 'none'; resolve(); };
    overlay.dataset.roomCode = roomCode || '';
    overlay.dataset._resolve = '1';
    overlay._fbDone = done;

    setTimeout(() => $('feedback-close-btn')?.focus(), 40);
  });
}

async function _fbSubmit() {
  const { overlay, submitBtn, comment } = _fbResolveEls();
  if (!overlay || _fbRating === 0 || !overlay._fbDone) return;

  const roomCode = overlay.dataset.roomCode || '';
  const commentText = (comment?.value || '').trim().slice(0, 500);

  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'SENDING…'; }

  try {
    const database = (typeof db !== 'undefined' && db) ? db : null;
    if (database) {
      await database.collection('feedback').add({
        roomCode,
        rating:     _fbRating,
        tags:       Array.from(_fbTags),
        comment:    commentText,
        appVersion: typeof APP_VERSION !== 'undefined' ? APP_VERSION : '',
        createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    _fbShowThanks();
    setTimeout(() => overlay._fbDone && overlay._fbDone(), 1400);
  } catch (e) {
    _log('warn', '[MIUT] Feedback submit failed:', e);
    toast('Feedback', "Couldn't send feedback — thanks for trying!", 'alert');
    overlay._fbDone();
  }
}

function _fbShowThanks() {
  const body = document.querySelector('#feedback-modal .modal-body');
  if (!body) return;
  body.innerHTML = `
    <div class="feedback-submitted">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.6"/>
        <path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="feedback-submitted-title">THANKS FOR THE FEEDBACK</div>
      <div class="feedback-submitted-sub">It helps us make MiutChat better for everyone.</div>
    </div>`;
}

function _fbSkip() {
  const { overlay } = _fbResolveEls();
  if (overlay?._fbDone) overlay._fbDone();
}

function _fbWireOnce() {
  const { overlay, stars, tagsWrap, comment, charCount, submitBtn, skipBtn, closeBtn } = _fbResolveEls();
  if (!overlay || overlay.dataset.wired) return;
  overlay.dataset.wired = '1';

  stars?.addEventListener('click', e => {
    const btn = e.target.closest('.star-btn');
    if (!btn) return;
    const firstRating = _fbRating === 0;
    _fbRating = +btn.dataset.value;
    _fbRenderStars();
    // Open the keyboard on the comment box right after a first rating —
    // saves a tap, and the low-contrast placeholder fix above means people
    // can actually read what they're being asked once it's focused.
    if (firstRating) setTimeout(() => comment?.focus(), 200);
  });

  tagsWrap?.addEventListener('click', e => {
    const chip = e.target.closest('.tag-chip');
    if (!chip) return;
    const tag = chip.dataset.tag;
    if (_fbTags.has(tag)) { _fbTags.delete(tag); chip.classList.remove('active'); }
    else if (_fbTags.size < 6) { _fbTags.add(tag); chip.classList.add('active'); }
  });

  comment?.addEventListener('input', () => {
    if (charCount) charCount.textContent = String(comment.value.length);
  });

  submitBtn?.addEventListener('click', () => _fbSubmit());
  skipBtn?.addEventListener('click', () => _fbSkip());
  closeBtn?.addEventListener('click', () => _fbSkip());
  overlay.addEventListener('click', e => { if (e.target === overlay) _fbSkip(); });
}

function showError(msg, type) {
  const el = $('join-error'); if (!el) return;
  el.textContent = msg;
  el.className = 'error-msg' + (type ? ' error-' + type : '');
  if (msg) {
    el.style.animation = 'none';
    requestAnimationFrame(() => { el.style.animation = 'shake .3s ease'; });
  }
}

function showSmartError(e, context) {
  const { title, detail, icon, type } = _classifyError(e);
  // Build error with SVG icon in a span
  const _errSvg = _toastIcon(icon);
  const errEl2 = $('join-error');
  if (errEl2) {
    errEl2.innerHTML = `<span class="err-icon">${_errSvg}</span>${esc(title + ' — ' + detail)}`;
    errEl2.className = 'error-msg' + (type ? ' error-' + type : '');
    errEl2.style.animation = 'none';
    requestAnimationFrame(() => { errEl2.style.animation = 'shake .3s ease'; });
    return;
  }
  showError(title + ' — ' + detail, type);
  // For network errors, inject a Retry button below the error message
  if (type === 'network' || type === 'auth') {
    const errEl = $('join-error');
    if (errEl) {
      const retryFn = context === 'create' ? handleCreate : handleEnter;
      const existing = errEl.parentNode.querySelector('.error-retry-btn');
      if (existing) existing.remove();
      const btn = document.createElement('button');
      btn.className = 'error-retry-btn';
      btn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" width="12" height="12"><path d="M4 4v4h4M16 16v-4h-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.3 12A7 7 0 0015.7 8M15.7 8A7 7 0 004.3 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> RETRY';
      btn.addEventListener('click', () => { btn.remove(); _authReady = null; retryFn(); });
      errEl.insertAdjacentElement('afterend', btn);
    }
  }
}
function setLoading(btn, on, label) {
  if (!btn) return;
  const span = btn.querySelector('span');
  if (on)  { if (span) { btn.dataset.orig = span.textContent; span.textContent = label; } btn.disabled = true; }
  else     { if (span && btn.dataset.orig) span.textContent = btn.dataset.orig; btn.disabled = false; }
}

function setupClipboardPaste() {
  document.addEventListener('paste', async e => {
    if (!state.roomCode || !state.me) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) await handleFileAttach({ target: { files: [file], value: '' } });
        return;
      }
    }
  });
}

function updateActionBtn() {
  const btn = $('send-btn');
  if (!btn) return;
  const hasText = ($('msg-input')?.value || '').trim().length > 0;
  btn.classList.toggle('has-input', hasText);
}

function setupActionBtn() {
  const btn = $('send-btn');
  if (!btn) return;
  btn.addEventListener('click', () => { _animateSend(); sendMessage(); });
  btn.addEventListener('touchstart', e => {
    e.preventDefault();
    _animateSend(); sendMessage();
  }, { passive: false });
}

function _animateSend() {
  const btn = $('send-btn');
  if (!btn || !state.prefs.animations) return;
  btn.style.transition = 'transform .06s ease';
  btn.style.transform = 'scale(.82)';
  requestAnimationFrame(() => {
    setTimeout(() => {
      btn.style.transition = 'transform .28s cubic-bezier(.34,1.56,.64,1)';
      btn.style.transform = '';
      setTimeout(() => { btn.style.transition = ''; }, 300);
    }, 70);
  });
}

function handleRipple(e) {
  if (!state.prefs.animations) return;
  if (!e.target.closest('.ripple-btn,.send-btn')) return;
  const x = e.touches?.[0]?.clientX ?? e.clientX, y = e.touches?.[0]?.clientY ?? e.clientY;
  const r = document.createElement('div');
  r.className = 'ripple-wave'; r.style.cssText = `left:${x-40}px;top:${y-40}px;width:80px;height:80px`;
  $('ripple-container')?.appendChild(r); setTimeout(() => r.remove(), 650);
}
let _audioCtx = null;
function _getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}

function playSound(type) {
  if (!state.prefs.sound) return;
  try {
    const ctx  = _getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    const s = { send:{freq:880,dur:.08,vol:.08}, receive:{freq:660,dur:.12,vol:.1} }[type] || {freq:880,dur:.08,vol:.08};
    osc.type = 'sine'; osc.frequency.value = s.freq;
    gain.gain.setValueAtTime(s.vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + s.dur);
    osc.start(); osc.stop(ctx.currentTime + s.dur);
  } catch {}
}

// SVG icon map for toast notifications
const _TOAST_ICONS = {
  'ok':    '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M3 8l3.5 3.5 6.5-7" stroke="#4ecdc4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  'err':   '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" stroke="#ff5f5f" stroke-width="2" stroke-linecap="round"/></svg>',
  'warn':  '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M8 2L14.5 13.5H1.5L8 2z" stroke="#f7c430" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v4M8 11.5v.5" stroke="#f7c430" stroke-width="1.5" stroke-linecap="round"/></svg>',
  'lock':  '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><rect x="3" y="7" width="10" height="7" rx="1.5" stroke="#4ecdc4" stroke-width="1.5"/><path d="M5 7V5a3 3 0 016 0v2" stroke="#4ecdc4" stroke-width="1.5" stroke-linecap="round"/></svg>',
  'key':   '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><circle cx="6" cy="7" r="3.5" stroke="#f7c430" stroke-width="1.5"/><path d="M9 9l5 5M12 11l1.5 1.5" stroke="#f7c430" stroke-width="1.5" stroke-linecap="round"/></svg>',
  'net':   '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M8 9a2 2 0 100-4 2 2 0 000 4z" fill="#4ecdc4"/><path d="M4.5 12.5a5 5 0 017 0M2 15a8.5 8.5 0 0112 0" stroke="#4ecdc4" stroke-width="1.4" stroke-linecap="round"/></svg>',
  'user':  '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><circle cx="8" cy="5.5" r="2.5" stroke="#4ecdc4" stroke-width="1.5"/><path d="M3 13c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="#4ecdc4" stroke-width="1.5" stroke-linecap="round"/></svg>',
  'link':  '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M7 9a3 3 0 004.24.12l1.42-1.42a3 3 0 00-4.24-4.24L7 4.88M9 7a3 3 0 00-4.24-.12L3.34 8.3a3 3 0 004.24 4.24L9 11.12" stroke="#4ecdc4" stroke-width="1.5" stroke-linecap="round"/></svg>',
  'star':  '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M8 2l1.6 4H14l-3.5 2.8 1.3 4.2L8 10.4l-3.8 2.6 1.3-4.2L2 6h4.4z" stroke="#f7c430" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  'trash': '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M3 5h10M6 5V3h4v2M5 5l.7 8h4.6L11 5" stroke="#ff5f5f" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  'alert': '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><circle cx="8" cy="8" r="6" stroke="#ff5f5f" stroke-width="1.5"/><path d="M8 5v3M8 10v1" stroke="#ff5f5f" stroke-width="1.5" stroke-linecap="round"/></svg>',
  'shield':'<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M8 2l5 2v4c0 2.8-2 5-5 6C5 13 3 10.8 3 8V4l5-2z" stroke="#4ecdc4" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  'clock': '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><circle cx="8" cy="9" r="5.5" stroke="#f7c430" stroke-width="1.5"/><path d="M8 6v3.5l2 1.5" stroke="#f7c430" stroke-width="1.5" stroke-linecap="round"/><path d="M6 2h4" stroke="#f7c430" stroke-width="1.5" stroke-linecap="round"/></svg>',
  'up':    '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M8 12V4M5 7l3-3 3 3" stroke="#4ecdc4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  'dot':   '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><circle cx="8" cy="8" r="3" fill="#4ecdc4"/></svg>',
};
function _toastIcon(i) {
  // Accept shortcode ('ok','err') or raw SVG string (starts with '<')
  if (i && i.startsWith('<')) return i;
  return _TOAST_ICONS[i] || _TOAST_ICONS['dot'];
}
function toast(title, msg, icon='dot') {
  const c = $('toast-container'); if (!c) return null;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="toast-icon">${_toastIcon(icon)}</div>
    <div class="toast-body">
      <div class="toast-title">${esc(title)}</div>
      ${msg ? `<div class="toast-msg">${esc(msg)}</div>` : ''}
    </div><div class="toast-bar"></div>`;
  el.addEventListener('click', () => rmToast(el));
  c.appendChild(el); setTimeout(() => rmToast(el), 4500);
  return el;
}
function rmToast(el) {
  if (!el.parentNode) return;
  el.classList.add('removing'); setTimeout(() => el.remove(), 300);
}

let _deferredInstall = null;

function triggerPWAInstall() {
  if (!_deferredInstall) {
    toast('Already installed', 'MIUT is already installed.', 'ok');
    return;
  }
  _deferredInstall.prompt();
  _deferredInstall.userChoice.then(choice => {
    if (choice.outcome === 'accepted') {
      toast('MIUT installed!', 'Find it on your home screen.', 'ok');
    }
    _deferredInstall = null;
    /* Hide install button in settings */
    const row = $('install-app-row');
    if (row) row.style.display = 'none';
  }).catch(() => {});
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstall = e;
  /* Show install button in settings */
  const row = $('install-app-row');
  if (row) row.style.display = 'flex';
  /* Show tap-to-install toast after 3 seconds */
  setTimeout(() => {
    const t = toast('Install Miut Chat', 'Tap to add it to your home screen.', '📲');
    if (t) {
      t.style.cursor = 'pointer';
      /* Remove default dismiss, replace with install trigger */
      t.replaceWith(t.cloneNode(true));
      const fresh = $('toast-container')?.lastElementChild;
      if (fresh) fresh.addEventListener('click', () => { rmToast(fresh); triggerPWAInstall(); });
    }
  }, 3000);
});

window.addEventListener('appinstalled', () => {
  _deferredInstall = null;
  const row = $('install-app-row');
  if (row) row.style.display = 'none';
  toast('MIUT installed!', 'Find it on your home screen.', 'ok');
});

// ── JSDoc type definitions ────────────────────────────────────────────────────
/**
 * @typedef {{ id:string, name:string, color:string, joinedAt:number, role?:string, approved?:boolean }} UserState
 * @typedef {{ me:UserState|null, roomCode:string|null, prefs:{sound:boolean,animations:boolean,approvalRequired:boolean} }} AppState
 * @typedef {{ type:string, enc?:string, senderId?:string, senderName?:string, senderColor?:string, ts?:number, sig?:string, edited?:boolean, reactions?:Object, replyTo?:Object, encData?:string, mime?:string, fileName?:string, fileSize?:number, groupId?:string, chunkIdx?:number, chunkOf?:number }} MsgData
 * @typedef {{ wrongCount:number, lockedUntil:number }} WrongState
 * @typedef {{ tokens:number, lastRefill:number }} RlState
 * @typedef {{ fwd:Uint8Array, rev:Uint8Array }} SubstTable
 */


// ── Wire all static HTML event handlers (CSP-safe: no inline onclick/oninput) ─
// Called from DOMContentLoaded. All functions are already on window via Object.assign.
function _wireAllHandlers() {
  // ── Helper: safe getElementById ──────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }
  function on(id, evt, fn, opts) {
    const e = el(id); if (e) e.addEventListener(evt, fn, opts);
  }
  function onQ(sel, evt, fn) {
    document.querySelectorAll(sel).forEach(e => e.addEventListener(evt, fn));
  }

  // ── Join screen tabs ──────────────────────────────────────────────────────────
  onQ('[data-tab="create"]', 'click', () => switchJoinTab('create'));
  onQ('[data-tab="enter"]',  'click', () => switchJoinTab('enter'));

  // ── Create room ───────────────────────────────────────────────────────────────
  on('input-create-code', 'input',  e => updateEntropyMeter(e.target.value));
  on('input-create-code', 'keyup',  e => updateEntropyMeter(e.target.value));
  on('input-create-code', 'change', e => updateEntropyMeter(e.target.value));
  on('input-create-code', 'compositionend', e => updateEntropyMeter(e.target.value));
  on('create-eye-btn', 'click', () => toggleVis('input-create-code', 'create-eye-btn'));
  on('btn-create',     'click', () => handleCreate());

  // ── Enter room ────────────────────────────────────────────────────────────────
  on('enter-eye-btn', 'click', () => toggleVis('input-room-code', 'enter-eye-btn'));
  on('btn-enter',     'click', () => handleEnter());

  // ── Enter room: Enter key ─────────────────────────────────────────────────────
  on('input-room-code', 'keydown', e => { if (e.key === 'Enter') handleEnter(); });

  // ── Waiting screen ────────────────────────────────────────────────────────────
  on('btn-waiting-cancel', 'click', () => cancelJoinRequest());

  // ── Invite screen ─────────────────────────────────────────────────────────────
  on('invite-code-input', 'input',   e => checkInviteCode(e.target));
  on('invite-code-input', 'keydown', e => { if (e.key === 'Enter') joinFromInvite(); });
  on('invite-vis-btn',    'click',   () => toggleVis('invite-code-input', 'invite-vis-btn'));
  on('invite-join-btn',   'click',   () => joinFromInvite());

  // ── Invite back / cancel ──────────────────────────────────────────────────────
  const backBtns = document.querySelectorAll('.btn-invite-back');
  backBtns.forEach(b => b.addEventListener('click', () => cancelInvite()));

  // ── Sidebar ───────────────────────────────────────────────────────────────────
  // (room-code-pill's click is wired once, below, via the dataset.wired guard —
  // it used to ALSO be bound here unconditionally, so tapping it fired
  // copyRoomCode() twice and showed two stacked "Code copied!" toasts.)
  // Use data-wired to prevent duplicate listeners from multiple _wireAllHandlers calls
  const wireOnce = (id, evt, fn) => {
    const e = el(id);
    if (!e || e.dataset.wired) return;
    e.dataset.wired = '1';
    e.addEventListener(evt, fn);
  };
  wireOnce('share-room-btn', 'click', () => shareRoomLink());
  wireOnce('settings-btn',   'click', () => openSettings());
  wireOnce('btn-logout',     'click', () => handleLogout());
  // room-code-pill may already be wired above — guard it
  const pillEl = el('room-code-pill');
  if (pillEl && !pillEl.dataset.wired) {
    pillEl.dataset.wired = '1';
    pillEl.addEventListener('click', () => copyRoomCode());
  }
  // sidebar-overlay click is wired in setupSidebar() — not here

  // ── Chat header ───────────────────────────────────────────────────────────────
  on('search-btn', 'click', () => toggleSearch());
  // Copy room code button in header (second copy button, no id)
  document.querySelectorAll('.chat-header .icon-btn').forEach(btn => {
    if (btn.id === 'search-btn' || btn.id === 'hamburger-btn') return;
    btn.addEventListener('click', () => copyRoomCode());
  });

  // ── Search bar ────────────────────────────────────────────────────────────────
  const searchInput = document.querySelector('#search-bar input');
  if (searchInput) {
    searchInput.addEventListener('input',   e => doSearch(e.target.value));
    searchInput.addEventListener('keydown', e => { if (e.key === 'Escape') toggleSearch(); });
  }
  const searchClose = document.querySelector('#search-bar .icon-btn');
  if (searchClose) searchClose.addEventListener('click', () => toggleSearch());

  // ── Reply bar ─────────────────────────────────────────────────────────────────
  on('reply-bar-close', 'click', () => clearReply());
  // reply-bar-close is a button inside reply-bar — also wire by class
  document.querySelectorAll('.reply-bar-close').forEach(b => {
    b.addEventListener('click', () => clearReply());
  });

  // ── Message input ─────────────────────────────────────────────────────────────
  on('msg-input', 'keydown', e => handleKey(e));
  on('msg-input', 'input',   e => handleTyping(e.target));

  // ── Attach button → horizontal Camera/Photo/Video/File tab menu ────────────────
  on('attach-btn', 'click', e => { e.stopPropagation(); toggleAttachTabs(); });
  on('attach-camera', 'click', () => { closeAttachTabs(); $('file-input-camera')?.click(); });
  on('attach-photo',  'click', () => { closeAttachTabs(); $('file-input-photo')?.click(); });
  on('attach-video',  'click', () => { closeAttachTabs(); $('file-input-video')?.click(); });
  on('attach-file',   'click', () => { closeAttachTabs(); $('file-input-file')?.click(); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.attach-wrap')) closeAttachTabs();
  });

  // ── File inputs ───────────────────────────────────────────────────────────────
  on('file-input-camera', 'change', e => handleFileAttach(e));
  on('file-input-photo',  'change', e => handleFileAttach(e));
  on('file-input-video',  'change', e => handleFileAttach(e));
  on('file-input-file',   'change', e => handleFileAttach(e));

  // ── Member detail panel ──────────────────────────────────────────────────────
  on('member-detail-close-btn', 'click', () => closeMemberDetail());
  on('member-detail-modal', 'click', e => { if (e.target.id === 'member-detail-modal') closeMemberDetail(); });

  // ── Settings modal ────────────────────────────────────────────────────────────
  on('settings-modal', 'click', e => closeModal(e));
  const settingsCloseBtn = document.querySelector('#settings-modal .modal-header .icon-btn');
  if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', () => closeSettings());

  // Create room TTL selector
  document.querySelectorAll('#create-ttl-selector .ttl-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#create-ttl-selector .ttl-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Vault
  on('vault-exit-btn',    'click', () => { _vaultToken = null; showScreen('join-screen'); });
  on('vault-fab',         'click', _vaultFabClick);          // sync, no arrow fn wrapper
  on('vault-modal-close', 'click', _vaultCloseModal);
  on('vault-modal-overlay','click', e => { if (e.target.id === 'vault-modal-overlay') _vaultCloseModal(); });
  on('vault-file-input',  'change', e => { _vaultUploadFiles(Array.from(e.target.files)); e.target.value = ''; });

  on('sound-toggle',    'change', () => toggleSoundAlerts());
  on('anim-toggle',     'change', () => toggleAnimations());
  on('approval-toggle', 'change', () => toggleApprovalGate());
  on('ttl-select',      'change', e => setRoomTtl(+e.target.value));
  on('room-ttl-select', 'change', e => setRoomExpiry(+e.target.value));

  const rotateBtn = document.querySelector('#rotate-key-row .btn-rotate-key');
  if (rotateBtn) rotateBtn.addEventListener('click', () => { rotateKey(); closeSettings(); });

  const saveBtn = document.querySelector('#settings-modal .btn-join');
  if (saveBtn) saveBtn.addEventListener('click', () => saveSettings());

  const installBtn = document.querySelector('#install-app-row .btn-rotate-key');
  if (installBtn) installBtn.addEventListener('click', () => triggerPWAInstall());

  // ── Media viewer ──────────────────────────────────────────────────────────────
  on('media-viewer', 'click', () => closeMediaViewer());
  on('mv-close',     'click', e => { e.stopPropagation(); closeMediaViewer(); });

  // ── Post-leave feedback modal ────────────────────────────────────────────────
  _fbWireOnce();

  // ── Version label (Settings) — single unified source, see version.js ─────────
  const _vLabel = $('app-version-label');
  if (_vLabel) _vLabel.textContent = 'MIUT v' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : '?');
}

// ── Public API — only these names escape the IIFE onto window ─────────────────
Object.assign(_W, {
  switchJoinTab, handleCreate, handleEnter, toggleVis, updateEntropyMeter, _wireEntropyListeners,
  _wireAllHandlers,
  cancelJoinRequest, checkInviteCode, joinFromInvite, cancelInvite,
  handleLogout, openSettings, closeSettings, closeModal, saveSettings,
  toggleSoundAlerts, toggleAnimations, toggleApprovalGate, rotateKey,
  triggerPWAInstall, copyRoomCode, shareRoomLink, toggleSearch, doSearch,
  closeMediaViewer, handleFileAttach, triggerAttach, handleKey, handleTyping, clearReply,
  setRoomTtl, toggleSidebar, closeSidebar,
  toast, startChatListeners, stopChatListeners,
  showFeedbackModal,
  get state() { return state; },
  get db()    { return db; },
});

// Expose security module integration helpers for operator use
if (typeof registerHook === 'function') _W.registerHook = registerHook;
if (typeof runHooks     === 'function') _W.runHooks     = runHooks;
if (typeof HOOK_EVENTS  !== 'undefined') _W.HOOK_EVENTS = HOOK_EVENTS;
if (typeof isEnabled    === 'function') _W.isEnabled    = isEnabled;
if (typeof setFlag      === 'function') _W.setFlag      = setFlag;
if (typeof enforceRateLimit === 'function') _W.enforceRateLimit = enforceRateLimit;
})(window);
