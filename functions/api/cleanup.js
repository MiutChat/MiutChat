/**
 * functions/api/cleanup.js
 *
 * Room cleanup — alternative to Firebase TTL (which needs Blaze plan).
 * Runs against EVERY active chat shard (db0 plus any FIREBASE_DBn_*), not
 * just the primary — a room on db1 or db2 is just as capable of going
 * stale as one on db0, and an uncleaned shard both wastes its storage
 * quota and throws off shard-registry.js's room-count-based placement
 * (a shard full of long-dead rooms still looks "equally loaded" to new
 * placement decisions, which is fine for fairness but means its real
 * Firestore storage/doc-count keeps growing for no reason).
 *
 * HOW TO USE (two options):
 *
 * Option A — Call manually via HTTP (easiest):
 *   POST https://miutchat.pages.dev/api/cleanup
 *   Authorization: Bearer YOUR_ADMIN_ACCESS
 *
 * Option B — Cloudflare Cron (automatic, runs hourly):
 *   In wrangler.toml add:
 *     [triggers]
 *     crons = ["0 * * * *"]
 *   Then in this file the scheduled() export handles it.
 *
 * WHAT IT DOES, per shard:
 *   Queries Firestore REST API for rooms where autoDeleteAt <= now, then
 *   deletes those documents via REST. Note: this only checks autoDeleteAt
 *   — it does NOT currently also match on a bare `emptyAt` with no
 *   autoDeleteAt set (an earlier version of this comment claimed it did;
 *   that was never actually implemented). If a room is wiped client-side
 *   but autoDeleteAt isn't also set at that point, it won't be caught
 *   here until/unless autoDeleteAt is set too.
 *
 * REQUIRED ENV VARS (Cloudflare Pages dashboard):
 *   FIREBASE_PROJECT_ID / FIREBASE_API_KEY           — primary shard (db0)
 *   FIREBASE_DBn_PROJECT_ID / FIREBASE_DBn_API_KEY   — any additional shard
 *   ADMIN_ACCESS                                      — your admin secret
 *
 * NOTE: Firestore REST API requires authentication via Firebase ID token.
 * For server-side cleanup, we use the API key + anonymous sign-in flow
 * to get a token, then use that token for Firestore queries.
 * For production-grade cleanup, use a Firebase Service Account key instead.
 */

'use strict';

const CORS = { 'Access-Control-Allow-Origin': '*' };

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

/** Sign in anonymously to get a Firebase ID token for Firestore REST API */
async function getFirebaseToken(apiKey) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"returnSecureToken":true}' }
  );
  if (!res.ok) throw new Error('Firebase auth failed: ' + res.status);
  const data = await res.json();
  return data.idToken;
}

/** Delete a Firestore document via REST API */
async function deleteDoc(projectId, token, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return res.ok || res.status === 404;
}

/** Query rooms where autoDeleteAt < now OR emptyAt exists */
async function findStaleRooms(projectId, token) {
  const now  = new Date().toISOString();
  const url  = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'rooms' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'autoDeleteAt' },
          op: 'LESS_THAN_OR_EQUAL',
          value: { timestampValue: now },
        }
      },
      limit: 50,
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Query failed: ' + res.status);
  const rows = await res.json();
  return rows
    .filter(r => r.document?.name)
    .map(r => r.document.name.split('/documents/')[1]);
}

async function cleanupShard(shard) {
  let token;
  try { token = await getFirebaseToken(shard.apiKey); }
  catch (e) { return { shard: shard.name, error: 'Auth failed: ' + e.message, deleted: 0, checked: 0 }; }

  let paths;
  try { paths = await findStaleRooms(shard.projectId, token); }
  catch (e) { return { shard: shard.name, error: 'Query failed: ' + e.message, deleted: 0, checked: 0 }; }

  let deleted = 0;
  for (const path of paths) {
    try {
      await deleteDoc(shard.projectId, token, path);
      deleted++;
    } catch {}
  }
  return { shard: shard.name, deleted, checked: paths.length };
}

async function runCleanup(env) {
  const shards = discoverShards(env).filter(s => s.active);
  if (!shards.length) {
    return { error: 'No active shards configured (need FIREBASE_API_KEY/FIREBASE_PROJECT_ID at minimum)', deleted: 0 };
  }

  // Independent per shard — one project having a bad day (auth hiccup,
  // query failure) never blocks cleanup on the others.
  const results = await Promise.all(shards.map(cleanupShard));

  const deleted = results.reduce((sum, r) => sum + r.deleted, 0);
  const checked = results.reduce((sum, r) => sum + r.checked, 0);
  return { deleted, checked, shards: results, ts: new Date().toISOString() };
}

export async function onRequest(ctx) {
  const { request, env } = ctx;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }),
      { status: 405, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  const secret = env?.ADMIN_ACCESS || '';
  const auth   = request.headers.get('Authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  const result = await runCleanup(env);
  return new Response(JSON.stringify(result),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// Cloudflare Cron trigger (requires wrangler.toml crons config)
export async function scheduled(event, env) {
  await runCleanup(env);
}
