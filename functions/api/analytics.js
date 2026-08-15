/**
 * functions/api/analytics.js
 *
 * Anonymous event counter — no user data stored, ever.
 *
 * Events: room_created | message_sent
 * Storage: Cloudflare KV  (MIUT_KV)
 * Reads:   GET /api/analytics  (requires Authorization: Bearer ADMIN_ACCESS)
 *
 * KV keys:
 *   analytics:room_created   → integer string
 *   analytics:message_sent   → integer string
 *   analytics:day:YYYY-MM-DD:room_created  → integer (daily breakdown)
 *   analytics:day:YYYY-MM-DD:message_sent  → integer
 */

'use strict';

const ALLOWED_EVENTS = new Set(['room_created', 'message_sent']);
const CORS = { 'Access-Control-Allow-Origin': '*' };

export async function onRequest(ctx) {
  const { request, env } = ctx;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const kv = env?.MIUT_KV;

  // ── GET — read totals (admin only) ────────────────────────────────────────
  if (request.method === 'GET') {
    const secret = env?.ADMIN_ACCESS || '';
    const auth   = request.headers.get('Authorization') || '';
    if (!secret || auth !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    if (!kv) return new Response(JSON.stringify({ error: 'KV not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });

    const [rooms, msgs] = await Promise.all([
      kv.get('analytics:room_created'),
      kv.get('analytics:message_sent'),
    ]);

    return new Response(JSON.stringify({
      room_created:  parseInt(rooms  || '0', 10),
      message_sent:  parseInt(msgs   || '0', 10),
      ts: new Date().toISOString(),
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  // ── POST — record event ───────────────────────────────────────────────────
  if (request.method === 'POST') {
    if (!kv) return new Response('ok', { status: 200, headers: CORS });

    let body;
    try { body = await request.json(); } catch { return new Response('ok', { status: 200, headers: CORS }); }

    const event = body?.e;
    if (!event || !ALLOWED_EVENTS.has(event)) {
      return new Response('ok', { status: 200, headers: CORS });
    }

    // Increment total counter
    const totalKey = `analytics:${event}`;
    const cur = parseInt(await kv.get(totalKey) || '0', 10);
    await kv.put(totalKey, String(cur + 1));

    // Increment daily counter
    const day = new Date().toISOString().slice(0, 10);
    const dayKey = `analytics:day:${day}:${event}`;
    const dayVal = parseInt(await kv.get(dayKey) || '0', 10);
    await kv.put(dayKey, String(dayVal + 1), { expirationTtl: 90 * 24 * 3600 }); // keep 90 days

    return new Response('ok', { status: 200, headers: CORS });
  }

  return new Response('Method not allowed', { status: 405, headers: CORS });
}
