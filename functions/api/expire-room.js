/**
 * MIUT — /functions/api/expire-room.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * Entry-time deletion of an expired room.
 *
 * When someone tries to enter a room whose autoDeleteAt has passed, the client
 * can't actually delete it (Firestore rules only let the creator/an admin delete
 * a room, and a non-member can't even list its subcollections). This endpoint
 * does it server-side with a Firebase service account (free on Spark).
 *
 * Safe to expose: it verifies expiry ITSELF and refuses to touch any room that
 * has not passed its autoDeleteAt, so the caller cannot use it to delete a live
 * room. Worst case for a spammer is a few wasted reads.
 *
 * Endpoint: POST /api/expire-room      Body: { "code": string }
 * Returns:  { deleted: true } | { deleted: false, reason: "not_expired" | "not_found" }
 *           501 { error: "not_configured" } when no service account is set up —
 *           the client ignores this and keeps its existing behaviour.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Budget, BudgetExceeded, discoverAdminShards, makeClient, fieldMillis, wipeRoom } from '../_lib/firebase-admin.js';

const ALLOWED_ORIGINS_DEFAULT = ['https://miutchat.pages.dev'];
const CODE_RE = /^[a-zA-Z0-9 _\-@#!?+*=.]{6,64}$/;

function getCorsHeaders(request, env = {}) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.MIUT_ALLOWED_ORIGINS
    ? env.MIUT_ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ALLOWED_ORIGINS_DEFAULT;
  return {
    'Access-Control-Allow-Origin':  allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body, status, CORS) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getCorsHeaders(context.request, context.env || {}) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, env || {});

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, CORS); }
  const code = String(body?.code || '').trim();
  if (!CODE_RE.test(code)) return json({ error: 'bad_code' }, 400, CORS);

  const shards = discoverAdminShards(env || {});
  if (!shards.length) return json({ error: 'not_configured' }, 501, CORS);

  let sawRoom = false;
  try {
    for (const shard of shards) {
      const budget = new Budget(40);
      const client = makeClient(shard, budget);
      const room = await client.getRoom(code);
      if (!room) continue;
      sawRoom = true;
      const expiry = fieldMillis(room.autoDeleteAt);
      if (!expiry || expiry > Date.now()) continue;           // not expired → never delete
      try {
        await wipeRoom(client, code);
      } catch (e) {
        if (e instanceof BudgetExceeded) return json({ deleted: false, partial: true }, 202, CORS); // cron finishes it
        throw e;
      }
      return json({ deleted: true }, 200, CORS);
    }
  } catch {
    return json({ error: 'server_error' }, 500, CORS);
  }
  return json({ deleted: false, reason: sawRoom ? 'not_expired' : 'not_found' }, 200, CORS);
}
