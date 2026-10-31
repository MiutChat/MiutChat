/**
 * functions/api/shard-registry.js
 *
 * Authoritative, server-side source of truth for "which database shard is
 * this room on" — replaces pure client-side hash/localStorage guessing.
 *
 * STORAGE: a DEDICATED Firestore project, not Cloudflare KV.
 * ───────────────────────────────────────────────────────────────────────
 * An earlier version of this file used Cloudflare KV (free tier: 1,000
 * writes/day, ACCOUNT-WIDE — shared with rate-limit.js's own KV use). That
 * budget turned out to be too easily exhausted in real usage. Firestore's
 * free (Spark) tier gives 50,000 reads / 20,000 writes / 20,000 deletes
 * PER DAY, PER PROJECT — and a dedicated project used only for this
 * registry means it's never competing with rate-limiting or chat traffic
 * for budget. That's a 20-50x bigger ceiling for exactly the operations
 * this file does, at zero cost, same as everything else in this app.
 *
 * Access is via the Firestore REST API with anonymous sign-in — the same
 * pattern already proven in production by cleanup.js. No Firebase client
 * SDK needed here; this is a server-side-only edge function, so raw REST
 * calls keep it simple and dependency-free.
 *
 * REQUIRED ENV VARS (separate from the FIREBASE_DBn_* chat shards —
 * this is its OWN Firebase project, used for nothing else):
 *   FIREBASE_REGISTRY_API_KEY
 *   FIREBASE_REGISTRY_PROJECT_ID
 * That project needs: Firestore enabled, Anonymous auth enabled, and the
 * rules at the bottom of this file's companion doc applied. See
 * sharding-how-it-works.md for the full setup walkthrough.
 *
 * DATA MODEL (two tiny collections, nothing else):
 *   bindings/{roomCode}     → { db: "miut-db1" }
 *   shardLoad/{shardName}   → { count: 12, degradedUntil: 0|epochMs }
 *
 * `count` is a LIFETIME cumulative total, not a daily one — it never
 * resets. Least-count-wins placement only actually equalizes totals
 * across shards if the counter itself never resets; a daily reset makes
 * each day fair in isolation but lets shards drift apart over time (a
 * shard that had a heavy Monday and a quiet Tuesday still ends up with
 * more total rooms than one that had two quiet days). Room churn (rooms
 * expiring/being deleted) isn't reflected here — this counts placements
 * made, not rooms currently alive — which is fine for its one purpose:
 * deciding where the NEXT room goes.
 *
 * Storage footprint is trivial (well under a kilobyte per room) and this
 * app's own free 1 GiB Firestore storage allowance comfortably holds
 * hundreds of thousands of these before it's a concern. No TTL/cleanup is
 * wired up for these two collections; if you want one, Firestore supports
 * a native TTL policy on a timestamp field, configurable in the console
 * without any code change — not required for correctness at this app's
 * scale, just a nice-to-have.
 */

'use strict';

function discoverShards(env) {
  const shards = [{
    name:   'miut-db0',
    active: !!(env.FIREBASE_API_KEY && env.FIREBASE_PROJECT_ID),
  }];
  const nums = new Set();
  for (const key of Object.keys(env)) {
    const m = /^FIREBASE_DB(\d+)_API_KEY$/.exec(key);
    if (m) nums.add(parseInt(m[1], 10));
  }
  for (const n of [...nums].sort((a, b) => a - b)) {
    shards.push({ name: `miut-db${n}`, active: !!(env[`FIREBASE_DB${n}_API_KEY`] && env[`FIREBASE_DB${n}_PROJECT_ID`]) });
  }
  return shards;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

// ── Firestore REST helpers (registry project only — small, simple values) ──

// In-memory only (module scope) — persists across requests handled by the
// same reused Worker isolate, which Cloudflare does routinely, but is never
// relied upon: a cold isolate just signs up fresh, same as before. This is
// purely a latency/account-proliferation optimization, not a correctness
// dependency — nothing here assumes the cache survives.
const PENDING_PICK_MS = 20000;
const _pendingPicks = new Map();

function pendingCount(name) {
  const now = Date.now();
  const live = (_pendingPicks.get(name) || []).filter(t => t > now);
  _pendingPicks.set(name, live);
  return live.length;
}

function reservePick(name) {
  const token = Date.now() + PENDING_PICK_MS;
  const list = _pendingPicks.get(name) || [];
  list.push(token);
  _pendingPicks.set(name, list);
  return token;
}

function releasePick(name, token) {
  const list = _pendingPicks.get(name) || [];
  const i = list.indexOf(token);
  if (i >= 0) list.splice(i, 1);
}

function settlePick(name) {
  const list = _pendingPicks.get(name) || [];
  list.sort((a, b) => a - b).shift();
}

let _cachedToken = null, _cachedTokenExp = 0;

async function getFirebaseToken(apiKey) {
  if (_cachedToken && Date.now() < _cachedTokenExp) return _cachedToken;
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"returnSecureToken":true}' }
  );
  if (!res.ok) throw new Error('Registry auth failed: ' + res.status);
  const data = await res.json();
  _cachedToken = data.idToken;
  // Firebase ID tokens are valid 1h — refresh a few minutes early to be safe
  _cachedTokenExp = Date.now() + (parseInt(data.expiresIn || '3600', 10) - 300) * 1000;
  return _cachedToken;
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  throw new Error('encodeValue: unsupported type ' + typeof v);
}
function decodeValue(f) {
  if (!f) return null;
  if ('stringValue'  in f) return f.stringValue;
  if ('integerValue' in f) return parseInt(f.integerValue, 10);
  if ('doubleValue'  in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  return null;
}
function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encodeValue(v);
  return fields;
}
function decodeFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) obj[k] = decodeValue(v);
  return obj;
}

async function restGetDoc(projectId, token, path) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`REST GET ${path} → ${res.status}`);
  const doc = await res.json();
  return decodeFields(doc.fields);
}

async function restSetDoc(projectId, token, path, obj) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`,
    {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: encodeFields(obj) }),
    }
  );
  if (!res.ok) throw new Error(`REST PATCH ${path} → ${res.status}: ${await res.text().catch(() => '')}`);
}

async function restCreateDocIfAbsent(projectId, token, path, obj) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?currentDocument.exists=false`,
    {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: encodeFields(obj) }),
    }
  );
  if (res.ok) return true;
  const text = await res.text().catch(() => '');
  if (res.status === 409 || (res.status === 400 && /ALREADY_EXISTS|FAILED_PRECONDITION/.test(text))) return false;
  throw new Error(`REST PATCH ${path} → ${res.status}: ${text}`);
}

async function restIncrement(projectId, token, path, field) {
  const base = `projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(
    `https://firestore.googleapis.com/v1/${base}:commit`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writes: [{
          update: { name: `${base}/${path}`, fields: {} },
          updateMask: { fieldPaths: [] },
          updateTransforms: [{ fieldPath: field, increment: { integerValue: '1' } }],
        }],
      }),
    }
  );
  if (!res.ok) throw new Error(`REST COMMIT ${path} → ${res.status}: ${await res.text().catch(() => '')}`);
}

// ── Placement policy ────────────────────────────────────────────────────
// Degraded status auto-recovers after 8h even if never explicitly cleared —
// unrelated to the (now non-resetting) room count, just a safety valve so a
// shard doesn't stay excluded forever if nothing ever re-checks it.
const DEGRADED_MS = 8 * 3600 * 1000;


// ── Hashed bindings ──────────────────────────────────────────────────────
// Bindings used to live at bindings/<plaintext room code>. The room code is also the key material for the
// room's end-to-end encryption, so the registry (and its logs / any prefix of a half-typed code) must not hold it:
//   client  sends   codeHash = base64url(SHA-256("miut-room-v1\0" + code))        (43 chars, never the code)
//   server  stores  bindings/h_<codeHash>                     (or h_<HMAC-SHA256(REGISTRY_PEPPER, codeHash)> when the
//                                                              pepper secret is set — a leaked database is then useless
//                                                              for guessing codes offline; set it once, never rotate)
// The hash is also a fixed-length, URL-safe id, which closes a path-injection hole: the old code put the raw room code
// into the Firestore REST URL, so a code such as "../shardLoad/miut-db0" read other registry documents, and "?" or "#"
// silently truncated the id so different rooms collided.
// Legacy plaintext bindings are migrated lazily (a lookup that carries the plaintext code and finds an old document
// copies it to the hashed id and deletes the old one) or all at once with the admin `migrate` action. Once migration is
// done set REGISTRY_LEGACY=off and plaintext codes are never accepted again.
const CODE_HASH_RE   = /^[A-Za-z0-9_-]{43}$/;
const LEGACY_CODE_RE = /^[a-zA-Z0-9 _\-@#!?+*=.]{6,64}$/;      // same allowlist as the client
const HASH_DOMAIN    = 'miut-room-v1\u0000';
const _enc = new TextEncoder();
const _b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const _hex    = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function codeHashOf(code) {
  return _b64url(await crypto.subtle.digest('SHA-256', _enc.encode(HASH_DOMAIN + code)));
}
async function bindingIdOf(env, codeHash) {
  const pepper = env?.REGISTRY_PEPPER;
  if (!pepper) return 'h_' + codeHash;
  const key = await crypto.subtle.importKey('raw', _enc.encode(String(pepper)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return 'h_' + _hex(await crypto.subtle.sign('HMAC', key, _enc.encode(codeHash)));
}
const legacyEnabled = env => env?.REGISTRY_LEGACY !== 'off';

// body -> { id, codeHash, legacyCode } | { error }
async function identify(body, env) {
  let codeHash = body?.codeHash, legacyCode = null;
  if (codeHash !== undefined) {
    if (typeof codeHash !== 'string' || !CODE_HASH_RE.test(codeHash)) return { error: 'invalid codeHash' };
  } else {
    const rc = body?.roomCode;
    if (!legacyEnabled(env) || typeof rc !== 'string' || !LEGACY_CODE_RE.test(rc) || rc === '.' || rc === '..') return { error: 'codeHash required' };
    legacyCode = rc;
    codeHash = await codeHashOf(rc);
  }
  return { id: await bindingIdOf(env, codeHash), codeHash, legacyCode };
}

async function restDeleteDoc(projectId, token, path) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`,
    { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok && res.status !== 404) throw new Error(`REST DELETE ${path} -> ${res.status}`);
}

async function restListDocs(projectId, token, collection, pageSize, pageToken) {
  const q = `pageSize=${pageSize}` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}?${q}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`REST LIST ${collection} -> ${res.status}`);
  const j = await res.json();
  return { docs: (j.documents || []).map(d => ({ id: decodeURIComponent(d.name.split('/').pop()), data: decodeFields(d.fields) })), next: j.nextPageToken || null };
}

// Current binding for a room, migrating a legacy plaintext one on the way. -> { db } | null
async function findBinding(projectId, token, ident, env, names) {
  const cur = await restGetDoc(projectId, token, `bindings/${ident.id}`);
  if (cur?.db && names.has(cur.db)) return cur;
  if (ident.legacyCode && legacyEnabled(env)) {
    const oldPath = `bindings/${encodeURIComponent(ident.legacyCode)}`;
    const old = await restGetDoc(projectId, token, oldPath).catch(() => null);
    if (old?.db && names.has(old.db)) {
      try { await restSetDoc(projectId, token, `bindings/${ident.id}`, { db: old.db }); await restDeleteDoc(projectId, token, oldPath); } catch { /* best effort: next lookup retries */ }
      return { db: old.db };
    }
  }
  return null;
}

function ctEq(a, b) {
  const x = _enc.encode(String(a)), y = _enc.encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

// ── Per-action rate limits (per client IP, in-memory token buckets) ─────────────────────────────────────────────
// The API-wide limiter in _middleware.js is coarse; these are tighter per action because the registry endpoints are
// unauthenticated and each call costs a Firestore REST read/write on the registry project. A copy of the bucket maths
// lives here on purpose (importing a helper into Pages Functions is fine, but this file already keeps its
// dependencies inline). KV is not used: 1,000 writes/day account-wide.
const REG_LIMITS = { lookup: [40, 90], resolve: [10, 20], confirm: [10, 20], bind: [6, 10], 'report-error': [3, 6], status: [6, 20], migrate: [10, 30] };
const _regBuckets = new Map();
function regTake(ip, action) {
  const [burst, perMin] = REG_LIMITS[action] || [6, 20];
  const key = action + '|' + ip, now = Date.now(), rate = perMin / 60000;
  let b = _regBuckets.get(key);
  if (b) { b.t = Math.min(burst, b.t + (now - b.at) * rate); b.at = now; _regBuckets.delete(key); } else b = { t: burst, at: now };
  _regBuckets.set(key, b);
  if (_regBuckets.size > 10000) { for (const k of _regBuckets.keys()) { _regBuckets.delete(k); if (_regBuckets.size <= 9000) break; } }
  if (b.t >= 1) { b.t -= 1; return 0; }
  return Math.max(1, Math.ceil((1 - b.t) / rate / 1000));
}
const tooMany = wait => new Response(JSON.stringify({ error: 'rate limited', retryAfter: wait }), {
  status: 429, headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Retry-After': String(wait), 'Cache-Control': 'no-store' },
});

// GET /api/shard-registry?h=<codeHash>[&fresh=1] — the read-only lookup as a cacheable GET. Positive answers are kept at the
// edge for a minute (bindings almost never change; the client verifies the room on the shard anyway), negative answers are
// never cached so a freshly created room is found immediately. `fresh=1` skips the cache.
async function handleGetLookup(request, env, waitUntil) {
  const url = new URL(request.url);
  const h = url.searchParams.get('h') || '';
  if (!CODE_HASH_RE.test(h)) return json({ error: 'invalid codeHash' }, 400);
  const apiKey = env?.FIREBASE_REGISTRY_API_KEY, projectId = env?.FIREBASE_REGISTRY_PROJECT_ID;
  if (!apiKey || !projectId) return json({ error: 'registry not configured' }, 500);
  const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
  const cacheKey = new Request(`${url.origin}/api/shard-registry?h=${h}`, { method: 'GET' });
  const fresh = url.searchParams.get('fresh') === '1';
  if (cache && !fresh) { const hit = await cache.match(cacheKey); if (hit) return hit; }

  const wait = regTake(request.headers.get('CF-Connecting-IP') || 'unknown', 'lookup');
  if (wait) return tooMany(wait);

  const shards = discoverShards(env).filter(s => s.active);
  if (!shards.length) return json({ error: 'no active shards configured' }, 500);
  const names = new Set(shards.map(s => s.name));
  let token;
  try { token = await getFirebaseToken(apiKey); } catch (e) { return json({ error: 'registry auth failed: ' + e.message }, 502); }
  let rec;
  try { rec = await findBinding(projectId, token, { id: await bindingIdOf(env, h), codeHash: h, legacyCode: null }, env, names); }
  catch (e) { return json({ error: 'registry read failed: ' + e.message }, 502); }
  if (!rec) return json({ found: false, legacy: legacyEnabled(env) });
  const res = new Response(JSON.stringify({ db: rec.db, found: true }), {
    status: 200, headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'public, max-age=30, s-maxage=60' },
  });
  if (cache) { const p = cache.put(cacheKey, res.clone()).catch(() => {}); if (typeof waitUntil === 'function') waitUntil(p); else await p; }
  return res;
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const apiKey    = env?.FIREBASE_REGISTRY_API_KEY;
  const projectId = env?.FIREBASE_REGISTRY_PROJECT_ID;
  if (!apiKey || !projectId) return json({ error: 'FIREBASE_REGISTRY_API_KEY / FIREBASE_REGISTRY_PROJECT_ID not configured' }, 500);
  if (request.method === 'GET') return handleGetLookup(request, env, ctx.waitUntil ? ctx.waitUntil.bind(ctx) : null);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (Number(request.headers.get('Content-Length') || 0) > 4096) return json({ error: 'request too large' }, 413);

  let body;
  // Size-check the real body (Content-Length can be absent on chunked requests).
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'request too large' }, 413);
    body = JSON.parse(raw);
  } catch { return json({ error: 'invalid JSON' }, 400); }
  const action = body?.action;
  { const wait = regTake(request.headers.get('CF-Connecting-IP') || 'unknown', String(action)); if (wait) return tooMany(wait); }

  const shards = discoverShards(env).filter(s => s.active);
  if (!shards.length) return json({ error: 'no active shards configured' }, 500);
  const names = new Set(shards.map(s => s.name));

  let token;
  try { token = await getFirebaseToken(apiKey); }
  catch (e) { return json({ error: 'registry auth failed: ' + e.message }, 502); }

  // ── lookup: read-only "which shard is this room on" — never creates a
  //    binding, so joins and typos can't pollute the registry ──
  if (action === 'lookup') {
    const ident = await identify(body, env);
    if (ident.error) return json({ error: ident.error }, 400);
    let existing = null;
    try { existing = await findBinding(projectId, token, ident, env, names); }
    catch (e) { return json({ error: 'registry read failed: ' + e.message }, 502); }
    if (existing?.db) return json({ db: existing.db, found: true });
    // `legacy` tells a hash-only client that retrying with the plaintext code can still find an old binding.
    return json({ found: false, legacy: legacyEnabled(env) && !ident.legacyCode });
  }

  // ── resolve: "which shard is this room on, or should a new one go to?" ──
  if (action === 'resolve') {
    const ident = await identify(body, env);
    if (ident.error) return json({ error: ident.error }, 400);

    const replace = body?.replace === true;

    const [existing, scored] = await Promise.all([
      replace ? null : findBinding(projectId, token, ident, env, names).catch(() => null),
      Promise.all(shards.map(async s => {
        let load = null;
        try { load = await restGetDoc(projectId, token, `shardLoad/${s.name}`); } catch {}
        const count = load?.count || 0;
        const degraded = !!(load && load.degradedUntil && load.degradedUntil > Date.now());
        return { name: s.name, count, degraded, prevLoad: load };
      })),
    ]);
    if (existing?.db && names.has(existing.db)) {
      return json({ db: existing.db, isNew: false });
    }

    const live = scored.map(s => ({ ...s, count: s.count + pendingCount(s.name) }));
    const healthy = live.filter(s => !s.degraded);
    const pool = healthy.length ? healthy : live; // every shard degraded → still answer with the least-bad option
    // Array.sort is stable, so a naive pool[0] after sorting always breaks
    // ties toward whichever shard appears first in `shards` — which is
    // always miut-db0. Since `confirm` (below) is fire-and-forget and not
    // awaited before the next room can be created, back-to-back creates
    // routinely see a tie (the previous room's confirm hasn't landed yet),
    // so that deterministic tie-break meant db0 could win every single
    // time under normal rapid use, not just occasionally. Pick uniformly
    // at random among whichever shards are tied for the lowest count
    // instead, so ties actually spread load rather than piling onto one
    // shard.
    const minCount = Math.min(...pool.map(s => s.count));
    const tied = pool.filter(s => s.count === minCount);
    const chosen = tied[Math.floor(Math.random() * tied.length)];
    const reservation = reservePick(chosen.name);

    try {
      if (replace) {
        await restSetDoc(projectId, token, `bindings/${ident.id}`, { db: chosen.name });
      } else if (!(await restCreateDocIfAbsent(projectId, token, `bindings/${ident.id}`, { db: chosen.name }))) {
        const winner = await restGetDoc(projectId, token, `bindings/${ident.id}`).catch(() => null);
        if (winner?.db && names.has(winner.db)) { releasePick(chosen.name, reservation); return json({ db: winner.db, isNew: false }); }
        await restSetDoc(projectId, token, `bindings/${ident.id}`, { db: chosen.name });
      }
    } catch (e) {
      releasePick(chosen.name, reservation);
      // Do NOT return { db: chosen.name } here — that would tell the client
      // "this room is on shard X" while the registry's own record of that
      // fact doesn't exist. A later resolve() for this same room (this
      // device after a registry hiccup, or any other device) would then
      // find nothing and reassign to a possibly-different shard, while the
      // room's actual data stays on the original one — permanently
      // orphaning it. Failing loudly here instead makes db-manager.js's
      // _resolveViaRegistry() throw, which falls through to ITS hash-based
      // fallback — slightly less optimal placement for this one room, but
      // self-consistent, which correctness-wise is what matters here.
      return json({ error: 'registry binding write failed: ' + e.message }, 502);
    }
    // NOTE: shardLoad.count is deliberately NOT incremented here. This
    // is a PICK, not a confirmed creation — the client still has to
    // actually write the room doc, which can fail (rules, network,
    // the user abandoning the create flow). Counting every pick as
    // load meant a burst of failed attempts permanently inflated a
    // shard's apparent load with nothing to ever correct it, biasing
    // placement away from a shard that was never actually used. The
    // 'confirm' action below increments the real count, once, only
    // after the room doc actually exists.

    return json({ db: chosen.name, isNew: true });
  }

  // ── confirm: the client actually finished writing the room doc on the
  //    shard it was assigned — THIS is what counts toward that shard's
  //    lifetime total, not the pick in 'resolve' above. The increment is
  //    an atomic server-side transform, so concurrent confirms can never
  //    overwrite each other's count. A missed or duplicate confirm just
  //    under/over-counts that shard by one — since the count never
  //    resets, this is a permanent (but harmless) off-by-one. It only
  //    ever affects which shard looks marginally least-loaded for the
  //    next placement, never correctness of an already-bound room. ──
  if (action === 'confirm') {
    const ident = await identify(body, env), db = body?.db;
    if (ident.error) return json({ error: ident.error }, 400);
    if (!db || !names.has(db)) return json({ error: 'invalid db' }, 400);
    settlePick(db);
    try {
      await restIncrement(projectId, token, `shardLoad/${db}`, 'count');
    } catch { /* best-effort — a missed confirm just slightly under-counts that shard, harmless */ }
    return json({ ok: true });
  }

  // ── bind: explicitly (re)point a room at a shard — used by
  //    db-manager.js to make a hash/localStorage fallback resolution
  //    authoritative in the registry for next time ──
  if (action === 'bind') {
    const ident = await identify(body, env), db = body?.db;
    if (ident.error) return json({ error: ident.error }, 400);
    if (!db || !names.has(db)) return json({ error: 'invalid db' }, 400);
    try {
      await restSetDoc(projectId, token, `bindings/${ident.id}`, { db });
    } catch (e) { return json({ error: 'registry write failed: ' + e.message }, 502); }
    return json({ ok: true });
  }

  // ── report-error: a client hit a quota-shaped Firestore error on this
  //    shard — stop routing NEW rooms there. Idempotent within the
  //    degraded window (checks before writing), so a burst of clients
  //    hitting the same exhausted shard costs one write, not N. ──
  if (action === 'report-error') {
    const db = body?.db;
    if (!db || !names.has(db)) return json({ error: 'invalid db' }, 400);
    try {
      const load = await restGetDoc(projectId, token, `shardLoad/${db}`);
      const alreadyDegraded = !!(load && load.degradedUntil && load.degradedUntil > Date.now());
      if (!alreadyDegraded) {
        await restSetDoc(projectId, token, `shardLoad/${db}`, {
          count: load?.count || 0,
          degradedUntil: Date.now() + DEGRADED_MS,
        });
      }
    } catch { /* best-effort */ }
    return json({ ok: true });
  }

  // ── status: current per-shard health, for the admin/debug console ──
  if (action === 'status') {
    const status = await Promise.all(shards.map(async s => {
      let load = null;
      try { load = await restGetDoc(projectId, token, `shardLoad/${s.name}`); } catch {}
      return {
        name: s.name,
        roomsTotal: load?.count || 0,
        degraded: !!(load && load.degradedUntil && load.degradedUntil > Date.now()),
        degradedUntil: (load && load.degradedUntil > Date.now()) ? load.degradedUntil : null,
      };
    }));
    return json({ shards: status });
  }

  // -- migrate: ONE-TIME admin action. Moves legacy plaintext bindings to hashed ids (up to 100 per call).
  //    curl -X POST /api/shard-registry -H "Authorization: Bearer $ADMIN_ACCESS" -d '{"action":"migrate"}'
  //    Repeat with {"action":"migrate","pageToken":"<nextPageToken>"} until nextPageToken is null, then set REGISTRY_LEGACY=off.
  if (action === 'migrate') {
    const secret = env?.ADMIN_ACCESS || '';
    if (!secret || !ctEq(request.headers.get('Authorization') || '', 'Bearer ' + secret)) return json({ error: 'unauthorized' }, 401);
    let page;
    try { page = await restListDocs(projectId, token, 'bindings', 100, typeof body?.pageToken === 'string' ? body.pageToken : null); }
    catch (e) { return json({ error: 'list failed: ' + e.message }, 502); }
    let migrated = 0, skipped = 0, alreadyHashed = 0;
    for (const d of page.docs) {
      if (d.id.startsWith('h_')) { alreadyHashed++; continue; }
      if (!d.data?.db || !names.has(d.data.db) || !LEGACY_CODE_RE.test(d.id)) { skipped++; continue; }
      try {
        const id = await bindingIdOf(env, await codeHashOf(d.id));
        await restCreateDocIfAbsent(projectId, token, `bindings/${id}`, { db: d.data.db });
        await restDeleteDoc(projectId, token, `bindings/${encodeURIComponent(d.id)}`);
        migrated++;
      } catch { skipped++; }
    }
    return json({ migrated, skipped, alreadyHashed, nextPageToken: page.next });
  }

  return json({ error: 'unknown action' }, 400);
}
