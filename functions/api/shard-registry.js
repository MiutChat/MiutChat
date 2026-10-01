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

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const apiKey    = env?.FIREBASE_REGISTRY_API_KEY;
  const projectId = env?.FIREBASE_REGISTRY_PROJECT_ID;
  if (!apiKey || !projectId) return json({ error: 'FIREBASE_REGISTRY_API_KEY / FIREBASE_REGISTRY_PROJECT_ID not configured' }, 500);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const action = body?.action;

  const shards = discoverShards(env).filter(s => s.active);
  if (!shards.length) return json({ error: 'no active shards configured' }, 500);
  const names = new Set(shards.map(s => s.name));

  let token;
  try { token = await getFirebaseToken(apiKey); }
  catch (e) { return json({ error: 'registry auth failed: ' + e.message }, 502); }

  // ── lookup: read-only "which shard is this room on" — never creates a
  //    binding, so joins and typos can't pollute the registry ──
  if (action === 'lookup') {
    const roomCode = body?.roomCode;
    if (!roomCode || typeof roomCode !== 'string' || roomCode.length > 128) {
      return json({ error: 'roomCode required' }, 400);
    }
    let existing = null;
    try { existing = await restGetDoc(projectId, token, `bindings/${roomCode}`); }
    catch (e) { return json({ error: 'registry read failed: ' + e.message }, 502); }
    if (existing?.db && names.has(existing.db)) return json({ db: existing.db, found: true });
    return json({ found: false });
  }

  // ── resolve: "which shard is this room on, or should a new one go to?" ──
  if (action === 'resolve') {
    const roomCode = body?.roomCode;
    if (!roomCode || typeof roomCode !== 'string' || roomCode.length > 128) {
      return json({ error: 'roomCode required' }, 400);
    }

    let existing = null;
    try { existing = await restGetDoc(projectId, token, `bindings/${roomCode}`); } catch {}
    if (existing?.db && names.has(existing.db)) {
      return json({ db: existing.db, isNew: false });
    }

    const scored = await Promise.all(shards.map(async s => {
      let load = null;
      try { load = await restGetDoc(projectId, token, `shardLoad/${s.name}`); } catch {}
      const count = load?.count || 0;
      const degraded = !!(load && load.degradedUntil && load.degradedUntil > Date.now());
      return { name: s.name, count, degraded, prevLoad: load };
    }));
    const healthy = scored.filter(s => !s.degraded);
    const pool = healthy.length ? healthy : scored; // every shard degraded → still answer with the least-bad option
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

    try {
      await restSetDoc(projectId, token, `bindings/${roomCode}`, { db: chosen.name });
    } catch (e) {
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
    const roomCode = body?.roomCode, db = body?.db;
    if (!roomCode || typeof roomCode !== 'string' || roomCode.length > 128) {
      return json({ error: 'roomCode required' }, 400);
    }
    if (!db || !names.has(db)) return json({ error: 'invalid db' }, 400);
    try {
      await restIncrement(projectId, token, `shardLoad/${db}`, 'count');
    } catch { /* best-effort — a missed confirm just slightly under-counts that shard, harmless */ }
    return json({ ok: true });
  }

  // ── bind: explicitly (re)point a room at a shard — used by
  //    db-manager.js to make a hash/localStorage fallback resolution
  //    authoritative in the registry for next time ──
  if (action === 'bind') {
    const roomCode = body?.roomCode, db = body?.db;
    if (!roomCode || typeof roomCode !== 'string' || roomCode.length > 128) {
      return json({ error: 'roomCode required' }, 400);
    }
    if (!db || !names.has(db)) return json({ error: 'invalid db' }, 400);
    try {
      await restSetDoc(projectId, token, `bindings/${roomCode}`, { db });
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

  return json({ error: 'unknown action' }, 400);
}
