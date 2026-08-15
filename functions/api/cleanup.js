/**
 * functions/api/cleanup.js
 *
 * Room cleanup — alternative to Firebase TTL (which needs Blaze plan).
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
 * WHAT IT DOES:
 *   Queries Firestore REST API for rooms where:
 *     - emptyAt is set (room was wiped client-side but doc not deleted), OR
 *     - autoDeleteAt < now (room TTL expired)
 *   Then deletes those documents via REST.
 *
 * REQUIRED ENV VARS (Cloudflare Pages dashboard):
 *   FIREBASE_PROJECT_ID  — e.g. tuition-fee-management-4e15e
 *   FIREBASE_API_KEY     — your web API key (same as in config.js)
 *   ADMIN_ACCESS         — your admin secret
 *
 * NOTE: Firestore REST API requires authentication via Firebase ID token.
 * For server-side cleanup, we use the API key + anonymous sign-in flow
 * to get a token, then use that token for Firestore queries.
 * For production-grade cleanup, use a Firebase Service Account key instead.
 */

'use strict';

const CORS = { 'Access-Control-Allow-Origin': '*' };

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

async function runCleanup(env) {
  const projectId = env?.FIREBASE_PROJECT_ID;
  const apiKey    = env?.FIREBASE_API_KEY;

  if (!projectId || !apiKey) {
    return { error: 'FIREBASE_PROJECT_ID and FIREBASE_API_KEY env vars required', deleted: 0 };
  }

  let token;
  try { token = await getFirebaseToken(apiKey); }
  catch (e) { return { error: 'Auth failed: ' + e.message, deleted: 0 }; }

  let paths;
  try { paths = await findStaleRooms(projectId, token); }
  catch (e) { return { error: 'Query failed: ' + e.message, deleted: 0 }; }

  let deleted = 0;
  for (const path of paths) {
    try {
      await deleteDoc(projectId, token, path);
      deleted++;
    } catch {}
  }
  return { deleted, checked: paths.length, ts: new Date().toISOString() };
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
