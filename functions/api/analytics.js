/**
 * functions/api/analytics.js
 *
 * Anonymous usage counters — no user data, room codes or IPs stored, ever.
 *
 * STORAGE
 *   Firestore (the REGISTRY project) when FIREBASE_REGISTRY_SA_JSON is set —
 *   atomic increments, 20,000 writes/day free, full event set.
 *   Otherwise the original Cloudflare KV counters (room_created / message_sent
 *   only) so nothing breaks before the service account is configured.
 *   See functions/_lib/analytics-store.js for the schema and privacy notes.
 *
 * WRITE  POST /api/analytics   { e: event, n?: 1..10, d?: { dimension: value } }
 *        The browser batches message_sent (one call per 2 messages, n = 2).
 *        Always answers 200 "ok": analytics must never affect the app.
 * READ   GET  /api/analytics?days=30        (Authorization: Bearer ADMIN_ACCESS)
 *        → { source, room_created, message_sent, totals, days, rollup, ts }
 * DEBUG  GET  /api/analytics?debug=1        (Authorization: Bearer ADMIN_ACCESS)
 *        End-to-end self-test: config → OAuth → a real Firestore write →
 *        readback, reporting exactly which step failed and why. Use this
 *        first if READ looks empty/wrong — it won't tell you WHY, since a
 *        write failure never affects the app and is never exposed there.
 * MIGRATE POST /api/analytics?action=migrate&cursor=…   (Bearer ADMIN_ACCESS)
 *        One-off import of the old KV counters. Repeat with the returned
 *        `cursor` until it reports done:true. Safe to re-run.
 * MIGRATE-FEEDBACK
 *        POST /api/analytics?action=migrate-feedback    (Bearer ADMIN_ACCESS)
 *        Backfills each shard's raw `feedback` collection into the rating.*
 *        counters, bucketed by the day each one was actually submitted (not
 *        today). No cursor param — it's tracked server-side per shard.
 *        Repeat the same call until every shard in the response reports
 *        done:true. Safe to re-run (idempotent). See
 *        functions/_lib/feedback-migrate.js for the full design.
 */

'use strict';

import { CLIENT_EVENTS, recordEvents, readStats, migrateKv, registryAdmin, diagnose } from '../_lib/analytics-store.js';
import { migrateFeedback } from '../_lib/feedback-migrate.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const JSON_HDR = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HDR });

/** Constant-time compare of the Bearer secret. */
function authorized(request, env) {
  const secret = env?.ADMIN_ACCESS || '';
  if (!secret) return false;
  const te = new TextEncoder();
  const a = te.encode(request.headers.get('Authorization') || ''), b = te.encode(`Bearer ${secret}`);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // ── GET — read stats (admin only) ─────────────────────────────────────────
  if (request.method === 'GET') {
    if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);

    // ?debug=1 — end-to-end self-test (config → OAuth → a real Firestore
    // write → readback), reporting exactly which step failed and why.
    // Everything else here either returns cached/aggregate data or
    // deliberately swallows write failures (POST always answers the
    // browser 200 "ok" — see recordEvents' doc comment) so this is the
    // only path that will actually tell you *why* events aren't landing.
    if (url.searchParams.get('debug') === '1') {
      try { return json(await diagnose(env)); }
      catch (e) { return json({ ok: false, step: 'unexpected', detail: String(e && e.message || e) }, 500); }
    }

    if (registryAdmin(env)) {
      try {
        const s = await readStats(env, url.searchParams.get('days'));
        return json({
          source: 'firestore',
          room_created: s.totals?.ev?.room_created || 0,          // same fields the old endpoint returned
          message_sent: s.totals?.ev?.message_sent || 0,
          totals: s.totals, days: s.days, rollup: s.rollup, avgRating: s.avgRating,
          ts: new Date().toISOString(),
        });
      } catch (e) {
        // This endpoint is admin-only (same Bearer check as everything else
        // here), so there's no reason to hide the real cause the way the
        // public-facing POST path has to — surface it instead of a bare
        // "something failed". readStats() already builds a message with
        // both Firestore response statuses in it; this used to be an
        // unbound `catch {}` that threw that detail away entirely.
        console.error('[MIUT analytics] readStats failed', e && e.message || e);
        return json({ error: 'analytics_read_failed', detail: String(e && e.message || e) }, 502);
      }
    }

    const kv = env?.MIUT_KV;
    if (!kv) return json({ error: 'No analytics storage configured (set FIREBASE_REGISTRY_SA_JSON)' }, 500);
    const [rooms, msgs] = await Promise.all([kv.get('analytics:room_created'), kv.get('analytics:message_sent')]);
    return json({ source: 'kv', room_created: parseInt(rooms || '0', 10), message_sent: parseInt(msgs || '0', 10), ts: new Date().toISOString() });
  }

  if (request.method === 'POST') {
    // ── POST ?action=migrate — one-off KV → Firestore import (admin only) ───
    if (url.searchParams.get('action') === 'migrate') {
      if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const r = await migrateKv(env, url.searchParams.get('cursor') || '');
        return json(r.body, r.status);
      } catch { return json({ error: 'migrate_failed' }, 502); }
    }

    // ── POST ?action=migrate-feedback — backfill raw per-shard `feedback`
    //    docs into the registry's rating.* counters, bucketed by the date
    //    each one was actually submitted (admin only). Resumable: re-POST
    //    the same URL (no cursor to pass — it's tracked server-side) until
    //    every shard in the response reports done:true. See
    //    functions/_lib/feedback-migrate.js for the full design/cost notes. ─
    if (url.searchParams.get('action') === 'migrate-feedback') {
      if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const r = await migrateFeedback(env);
        return json(r.body, r.status);
      } catch (e) { return json({ error: 'migrate_feedback_failed', detail: String(e && e.message || e) }, 502); }
    }

    // ── POST — record an event ──────────────────────────────────────────────
    let body;
    try { body = await request.json(); } catch { return new Response('ok', { status: 200, headers: CORS }); }
    const event = body?.e;
    if (!event || !Object.prototype.hasOwnProperty.call(CLIENT_EVENTS, event)) return new Response('ok', { status: 200, headers: CORS });

    // A client may report several events in one request (`n`, 1..10).
    const n = Math.min(10, Math.max(1, Math.floor(Number(body?.n)) || 1));

    if (registryAdmin(env)) {
      const work = recordEvents(env, [{
        event, n, dims: body?.d,
        hour: new Date().getUTCHours(),
        country: env.ANALYTICS_GEO === 'off' ? null : request.cf?.country,
      }]);
      if (ctx.waitUntil) ctx.waitUntil(work); else await work;
      return new Response('ok', { status: 200, headers: CORS });
    }

    // ── Legacy KV fallback (only the two original events) ───────────────────
    const kv = env?.MIUT_KV;
    if (!kv || (event !== 'room_created' && event !== 'message_sent')) return new Response('ok', { status: 200, headers: CORS });
    const totalKey = `analytics:${event}`;
    const cur = parseInt(await kv.get(totalKey) || '0', 10);
    await kv.put(totalKey, String(cur + n));
    const day = new Date().toISOString().slice(0, 10);
    const dayKey = `analytics:day:${day}:${event}`;
    const dayVal = parseInt(await kv.get(dayKey) || '0', 10);
    await kv.put(dayKey, String(dayVal + n), { expirationTtl: 90 * 24 * 3600 }); // keep 90 days
    return new Response('ok', { status: 200, headers: CORS });
  }

  return new Response('Method not allowed', { status: 405, headers: CORS });
}
