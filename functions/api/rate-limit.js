/**
 * MIUT — /functions/api/rate-limit.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * Cloudflare Pages Function — runs at the EDGE before any client JS.
 * Provides true server-side IP-based rate limiting backed by CF KV.
 *
 * This fixes the #1 security weakness: client-side-only rate limiting.
 * A fresh incognito tab or a simple curl loop bypasses localStorage counters.
 * This function enforces limits per real IP at the network edge — no client
 * JS is involved and the limits cannot be bypassed by any browser trick.
 *
 * Endpoint: POST /api/rate-limit
 * Body:     { "action": "create" | "enter" | "send" }
 * Returns:  { "allowed": true } or { "allowed": false, "retryAfter": N, "reason": "..." }
 *
 * KV key format: rl:{ipToken}:{action}  (TTL = twice the window, auto-expires)
 * ipToken is a keyed hash of the IP using a random daily salt that is deleted after 36 hours;
 * the raw IP is never written anywhere by this function.
 * KV value:      { count: N, windowStart: unixMs }
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { ipToken, kvOf } from '../_lib/ip-token.js';

const ALLOWED_ORIGINS_DEFAULT = ['https://miutchat.pages.dev'];

function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.MIUT_ALLOWED_ORIGINS
    ? env.MIUT_ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ALLOWED_ORIGINS_DEFAULT;
  const allowedOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin':  allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function isOriginAllowed(origin, env) {
  const allowed = env.MIUT_ALLOWED_ORIGINS
    ? env.MIUT_ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ALLOWED_ORIGINS_DEFAULT;
  return allowed.includes(origin);
}

const LIMITS = {
  create: { max: 5,  windowSec: 30  },
  enter:  { max: 10, windowSec: 60  },
  send:   { max: 30, windowSec: 10  },
};

const BAN_TTL_SEC = 6 * 3600;
const STRIKE_WINDOW_SEC = 600;
const COOLDOWN_STEPS_SEC = [60, 300, 900, 1800];

/**
 * @param {string} ip
 * @param {string} action
 * @param {{ max: number, windowSec: number }} limit
 * @param {KVNamespace} MIUT_RL
 * @param {KVNamespace} MIUT_BAN
 * @returns {Promise<{ allowed: boolean, retryAfter?: number, reason?: string }>}
 */
async function checkLimitViaDO(MIUT_RL_DO, ip, action, maxCount, windowMs) {
  const id = MIUT_RL_DO.idFromName(ip);
  const stub = MIUT_RL_DO.get(id);
  const res = await stub.fetch('https://do/limit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'window', action, maxCount, windowMs }),
  });
  return res.json();
}

async function checkLimitViaKV(MIUT_RL, ip, action, limit) {
  const key = `rl:${ip}:${action}`;
  const now = Date.now();
  const windowMs = limit.windowSec * 1000;
  const raw = await MIUT_RL.get(key);
  let state = raw ? JSON.parse(raw) : { count: 0, windowStart: now };
  if (now - state.windowStart >= windowMs) state = { count: 0, windowStart: now };
  state.count++;
  await MIUT_RL.put(key, JSON.stringify(state), { expirationTtl: limit.windowSec * 2 });
  const allowed = state.count <= limit.max;
  const retryAfter = allowed ? 0 : Math.ceil((state.windowStart + windowMs - now) / 1000);
  return { allowed, count: state.count, retryAfter };
}

async function checkLimit(ip, action, limit, env) {
  const banned = await (env.MIUT_BAN ? env.MIUT_BAN.get(`ban:${ip}`).catch(() => null) : null);
  if (banned) {
    return { allowed: false, retryAfter: BAN_TTL_SEC, reason: 'ip_banned' };
  }

  let verdict;
  try {
    verdict = env.MIUT_RL_DO
      ? await checkLimitViaDO(env.MIUT_RL_DO, ip, action, limit.max, limit.windowSec * 1000)
      : await checkLimitViaKV(env.MIUT_RL, ip, action, limit);
  } catch (e) {
    console.warn('[MIUT rate-limit] primary limiter failed, trying KV:', e && e.message || e);
    try { verdict = kvOf(env) ? await checkLimitViaKV(kvOf(env), ip, action, limit) : { allowed: true, count: 0 }; }
    catch { verdict = { allowed: true, count: 0 }; }
  }
  const { allowed, count, retryAfter } = verdict;

  if (!allowed) {
    if (count > limit.max * 10 && env.MIUT_BAN) {
      await env.MIUT_BAN.put(`ban:${ip}`, JSON.stringify({
        reason: `rate_limit_abuse:${action}`,
        count,
        bannedAt: Date.now(),
      }), { expirationTtl: BAN_TTL_SEC });
    }
    return { allowed: false, retryAfter: Math.max(1, retryAfter), reason: 'rate_limited' };
  }

  return { allowed: true };
}

async function safetyStrike(env, token, add) {
  const kv = kvOf(env);
  if (!kv || token === 'unknown') return { cooldown: 0 };
  const cdKey = `cd:${token}`;
  const active = await kv.get(cdKey);
  if (active) {
    const until = parseInt(active, 10);
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left > 0) return { cooldown: left };
  }
  if (!add) return { cooldown: 0 };
  const stKey = `st:${token}`;
  const count = (parseInt(await kv.get(stKey), 10) || 0) + 1;
  if (count < 3) {
    await kv.put(stKey, String(count), { expirationTtl: STRIKE_WINDOW_SEC });
    return { cooldown: 0, strikes: count };
  }
  const lvKey = `lv:${token}`;
  const level = Math.min(parseInt(await kv.get(lvKey), 10) || 0, COOLDOWN_STEPS_SEC.length - 1);
  const secs = COOLDOWN_STEPS_SEC[level];
  await kv.put(cdKey, String(Date.now() + secs * 1000), { expirationTtl: Math.max(60, secs) });
  await kv.put(lvKey, String(level + 1), { expirationTtl: 3600 });
  await kv.delete(stKey);
  return { cooldown: secs };
}

export async function onRequestOptions(context) {
  const CORS = getCorsHeaders(context.request, context.env || {});
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, env);

  // Validate CORS origin
  const origin = request.headers.get('Origin') || '';
  if (!isOriginAllowed(origin, env) && env.MIUT_ENV === 'production') {
    return new Response(JSON.stringify({ allowed: false, reason: 'forbidden_origin' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ allowed: false, reason: 'bad_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  const action = body?.action;

  if (action === 'strike' || action === 'strike-status') {
    const token = await ipToken(request, env);
    const out = await safetyStrike(env, token, action === 'strike');
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
    });
  }

  if (!action || !LIMITS[action]) {
    return new Response(JSON.stringify({ allowed: false, reason: 'unknown_action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  const ip = await ipToken(request, env);

  // Use env vars for limits if set, fall back to defaults
  const limit = {
    max:       parseInt(env[`RL_${action.toUpperCase()}_MAX`]  || LIMITS[action].max),
    windowSec: parseInt(env[`RL_${action.toUpperCase()}_WIN_S`]|| LIMITS[action].windowSec),
  };

  const result = await checkLimit(ip, action, limit, env);

  const status = result.allowed ? 200 : 429;
  const headers = {
    'Content-Type': 'application/json',
    'X-RateLimit-Limit':     String(limit.max),
    'X-RateLimit-Remaining': result.allowed ? String(limit.max) : '0',
    ...CORS,
  };
  if (!result.allowed && result.retryAfter) {
    headers['Retry-After'] = String(result.retryAfter);
  }

  return new Response(JSON.stringify(result), { status, headers });
}
