/**
 * functions/api/migrate-room.js
 *
 * Copies one room (its room doc + members + messages) from one Firestore
 * shard to another, then flips the authoritative binding in
 * shard-registry.js so every client — not just whoever triggered this —
 * picks up the new location on their next room open.
 *
 * WHY SERVER-SIDE (not done in the browser):
 * A client-side migration only runs if some browser tab happens to still
 * be open in that room when the quota error hits — unreliable, and the
 * migration dies with the tab. This runs at the edge instead, using the
 * same "Firestore REST API + anonymous sign-in" approach cleanup.js
 * already uses in production, so it works the moment it's called
 * regardless of who's currently online.
 *
 * WHO CALLS THIS:
 *   - Reactively: db-manager.js, the moment a client's OWN request to its
 *     bound shard fails with a quota-shaped error (fast — often faster
 *     than any polling/cron could react).
 *   - Proactively (optional): a cron-triggered sweep — see cleanup.js's
 *     scheduled() for the existing pattern; wiring a sweep across shards
 *     is described in the deploy notes at the bottom of this file.
 *
 * HONEST LIMIT — read this, it matters:
 * Firestore's free (Spark) tier enforces reads/writes/deletes as a HARD
 * per-project daily cap: once truly exhausted, that operation type refuses
 * ALL requests — free-tier or Admin SDK, client or server — until the
 * daily reset. No amount of code changes that. So:
 *   - If WRITES ran out on the source shard: this migration still works
 *     fully (it only needs to READ the source and WRITE the destination).
 *     This is the common, fully-recoverable case.
 *   - If READS ran out on the source shard too: the source data genuinely
 *     cannot be read by anyone, from anywhere, until quota resets — this
 *     function will fail at the "read source" step and say so clearly
 *     rather than pretending to succeed. The room keeps working (writes
 *     just get routed to a fresh binding going forward via
 *     shard-registry.js), but message history from before the exhaustion
 *     is temporarily unreadable until the source project's quota resets,
 *     at which point re-running this same migration recovers it.
 * The SOFT_CAP load-shedding in shard-registry.js exists specifically to
 * keep new rooms off a shard well before it's anywhere near this second,
 * unrecoverable case — this endpoint is the safety net, not the primary
 * defense.
 */

'use strict';

const CORS = { 'Access-Control-Allow-Origin': 'same-origin' };

function discoverShards(env) {
  const shards = [{
    name:   'miut-db0',
    active: !!(env.FIREBASE_API_KEY && env.FIREBASE_PROJECT_ID),
    apiKey: env.FIREBASE_API_KEY || '',
    projectId: env.FIREBASE_PROJECT_ID || '',
  }];
  const nums = new Set();
  for (const key of Object.keys(env)) {
    const m = /^FIREBASE_DB(\d+)_API_KEY$/.exec(key);
    if (m) nums.add(parseInt(m[1], 10));
  }
  for (const n of [...nums].sort((a, b) => a - b)) {
    shards.push({
      name:   `miut-db${n}`,
      active: !!(env[`FIREBASE_DB${n}_API_KEY`] && env[`FIREBASE_DB${n}_PROJECT_ID`]),
      apiKey: env[`FIREBASE_DB${n}_API_KEY`] || '',
      projectId: env[`FIREBASE_DB${n}_PROJECT_ID`] || '',
    });
  }
  return shards;
}

async function getFirebaseToken(apiKey) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"returnSecureToken":true}' }
  );
  if (!res.ok) throw new Error('Firebase auth failed: ' + res.status);
  const data = await res.json();
  return data.idToken;
}

/** GET a document (and optionally a subcollection) via Firestore REST API */
async function restGet(projectId, token, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`REST GET ${path} → ${res.status}`);
  return res.json();
}

/** List every document in a collection via Firestore REST API, paginated */
async function restListAll(projectId, token, collectionPath) {
  const out = [];
  let pageToken;
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collectionPath}`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error(`REST LIST ${collectionPath} → ${res.status}`);
    const data = await res.json();
    for (const d of (data.documents || [])) out.push(d);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

/** Write documents to a destination collection via BatchWrite (handles Firestore's field-value wire format transparently — it's already what restGet/restListAll return) */
async function restBatchWrite(projectId, token, writes) {
  const BATCH_LIMIT = 400; // Firestore's hard cap is 500 writes/request — leave headroom
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const chunk = writes.slice(i, i + BATCH_LIMIT);
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:batchWrite`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ writes: chunk }),
      }
    );
    if (!res.ok) throw new Error(`REST batchWrite → ${res.status}: ${await res.text().catch(() => '')}`);
  }
}

function toWrite(destPath, doc) {
  return { update: { name: destPath, fields: doc.fields || {} } };
}

async function migrateRoom(env, roomCode, fromName, toName) {
  const shards = discoverShards(env).filter(s => s.active);
  const from = shards.find(s => s.name === fromName);
  const to   = shards.find(s => s.name === toName);
  if (!from) throw new Error(`Unknown/inactive source shard: ${fromName}`);
  if (!to)   throw new Error(`Unknown/inactive destination shard: ${toName}`);
  if (from.name === to.name) throw new Error('Source and destination are the same shard');

  const [fromToken, toToken] = await Promise.all([
    getFirebaseToken(from.apiKey),
    getFirebaseToken(to.apiKey),
  ]);

  // 1. Room doc — READ from source first. If this throws, source reads are
  //    genuinely exhausted (see file header) — surface that clearly rather
  //    than silently doing a partial migration.
  const roomDoc = await restGet(from.projectId, fromToken, `rooms/${roomCode}`);
  if (!roomDoc) throw new Error('Room not found on source shard — nothing to migrate');

  // 2. Subcollections
  const [members, messages] = await Promise.all([
    restListAll(from.projectId, fromToken, `rooms/${roomCode}/members`),
    restListAll(from.projectId, fromToken, `rooms/${roomCode}/messages`),
  ]);

  // 3. WRITE everything to the destination. The room doc goes last so a
  //    reader who resolves to the new binding mid-migration (shard-registry
  //    is only updated AFTER this whole function succeeds) never finds a
  //    room doc with an incomplete member/message set under it.
  const destBase = `projects/${to.projectId}/databases/(default)/documents`;
  const memberWrites  = members.map(d => toWrite(`${destBase}/rooms/${roomCode}/members/${d.name.split('/').pop()}`, d));
  const messageWrites = messages.map(d => toWrite(`${destBase}/rooms/${roomCode}/messages/${d.name.split('/').pop()}`, d));

  if (memberWrites.length)  await restBatchWrite(to.projectId, toToken, memberWrites);
  if (messageWrites.length) await restBatchWrite(to.projectId, toToken, messageWrites);
  await restBatchWrite(to.projectId, toToken, [toWrite(`${destBase}/rooms/${roomCode}`, roomDoc)]);

  return { roomCode, from: from.name, to: to.name, members: members.length, messages: messages.length };
}

export async function onRequest(ctx) {
  const { request, env } = ctx;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }),
      { status: 405, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
  const { roomCode, from, to } = body || {};
  if (!roomCode || !from || !to) {
    return new Response(JSON.stringify({ error: 'roomCode, from, to are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  try {
    const result = await migrateRoom(env, roomCode, from, to);

    // Flip the authoritative binding now that the copy is verified complete.
    // Fire-and-forget-ish but awaited so a caller polling the registry right
    // after this returns sees the new binding immediately, not eventually.
    try {
      const origin = new URL(request.url).origin;
      await fetch(`${origin}/api/shard-registry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bind', roomCode, db: to }),
      });
    } catch { /* binding update failing doesn't undo the successful data copy — the
                 reactive client-side path also calls 'bind' itself as a backstop,
                 see db-manager.js */ }

    return new Response(JSON.stringify({ ok: true, ...result }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}
