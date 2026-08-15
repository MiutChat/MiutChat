/**
 * functions/api/maintenance.js
 *
 * Cloudflare Pages Function — Maintenance Mode Gate
 *
 * HOW TO USE:
 * ──────────────────────────────────────────────────
 * TOGGLE ON  (redirect all traffic to maintenance page):
 *   curl -X POST https://miutchat.pages.dev/api/maintenance \
 *     -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"enabled": true}'
 *
 * TOGGLE OFF (restore normal traffic):
 *   curl -X POST https://miutchat.pages.dev/api/maintenance \
 *     -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"enabled": false}'
 *
 * CHECK STATUS:
 *   curl https://miutchat.pages.dev/api/maintenance
 *
 * ENVIRONMENT VARIABLES (set in Cloudflare Pages dashboard):
 *   ADMIN_SECRET  — a strong random secret string you choose
 *   MIUT_KV       — bind a KV namespace called MIUT_KV in wrangler.toml
 *
 * The _middleware.js at root reads MIUT_KV to gate all page loads.
 * ──────────────────────────────────────────────────────────────────
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequest(ctx) {
  const { request, env } = ctx;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const kv = env?.MIUT_KV;

  // GET — return current maintenance status
  if (request.method === 'GET') {
    let enabled = false;
    if (kv) {
      const val = await kv.get('maintenance_mode');
      enabled = val === 'true';
    }
    return new Response(
      JSON.stringify({ maintenance: enabled, ts: new Date().toISOString() }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  // POST — toggle maintenance mode (requires Authorization header)
  if (request.method === 'POST') {
    const secret = env?.ADMIN_SECRET;
    const auth   = request.headers.get('Authorization') || '';

    if (!secret || auth !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    let body;
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS }); }

    const enable = Boolean(body?.enabled);

    if (!kv) {
      return new Response(JSON.stringify({
        error: 'KV namespace MIUT_KV not bound. Add KV binding in Cloudflare Pages settings.',
      }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    await kv.put('maintenance_mode', enable ? 'true' : 'false');

    return new Response(JSON.stringify({
      maintenance: enable,
      message: enable ? 'Maintenance mode ON — all pages now show maintenance.html' : 'Maintenance mode OFF — site restored',
      ts: new Date().toISOString(),
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405, headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
