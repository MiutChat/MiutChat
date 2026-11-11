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
 * KV key format: rl:{ip}:{action}  (TTL = window size, auto-expires)
 * KV value:      { count: N, windowStart: unixMs }
 * ═══════════════════════════════════════════════════════════════════════════════
 */

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

/**
 * Get the real client IP, preferring CF-Connecting-IP (set by Cloudflare
 * infrastructure — not spoofable by the client via headers).
 * @param {Request} req
 * @returns {string}
 */
function getIp(req) {
  return req.headers.get('CF-Connecting-IP')
      || req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
      || 'unknown';
}

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
  const banned = await env.MIUT_BAN.get(`ban:${ip}`);
  if (banned) {
    return { allowed: false, retryAfter: 86400, reason: 'ip_banned' };
  }

  const { allowed, count, retryAfter } = env.MIUT_RL_DO
    ? await checkLimitViaDO(env.MIUT_RL_DO, ip, action, limit.max, limit.windowSec * 1000)
    : await checkLimitViaKV(env.MIUT_RL, ip, action, limit);

  if (!allowed) {
    if (count > limit.max * 10) {
      await env.MIUT_BAN.put(`ban:${ip}`, JSON.stringify({
        reason: `rate_limit_abuse:${action}`,
        count,
        bannedAt: Date.now(),
      }), { expirationTtl: 86400 });
    }
    return { allowed: false, retryAfter: Math.max(1, retryAfter), reason: 'rate_limited' };
  }

  return { allowed: true };
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
  if (!action || !LIMITS[action]) {
    return new Response(JSON.stringify({ allowed: false, reason: 'unknown_action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  const ip = getIp(request);

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
