/**
 * MIUT — /functions/api/validate-room.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * Server-side room code validation at the CF edge.
 * Runs BEFORE the client touches Firestore — blocks bad codes early.
 *
 * Endpoint: POST /api/validate-room
 * Body:     { "code": string, "action": "create" | "enter" }
 * Returns:  { "valid": true } | { "valid": false, "error": "..." }
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const ALLOWED_ORIGINS_DEFAULT = ['https://miutchat.pages.dev'];

function getCorsHeaders(request, env = {}) {
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

const CODE_RE = /^[a-zA-Z0-9 _\-@#!?+*=.]{6,64}$/;

// Known trivially-weak patterns to block server-side
const WEAK_PATTERNS = [
  /^(.)\1+$/,          // all same character: aaaaaa
  /^123456/,           // starts with 123456
  /^(abc|qwerty|password)/i,
  /^000000/,
];

function json(body, status = 200, CORS = {}, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

export async function onRequestOptions(context) {
  const CORS = getCorsHeaders(context.request, context.env || {});
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const CORS = getCorsHeaders(request, env || {});

  let body;
  try { body = await request.json(); }
  catch { return json({ valid: false, error: 'bad_request' }, 400, CORS); }

  const code   = (body?.code || '').trim();
  const action = body?.action;

  if (!code) return json({ valid: false, error: 'missing_code' }, 400, CORS);

  // Zero-width / invisible chars
  if (/[\u200B-\u200D\uFEFF\u00AD]/.test(code))
    return json({ valid: false, error: 'invalid_chars' }, 200, CORS);

  // Regex allowlist
  if (!CODE_RE.test(code))
    return json({ valid: false, error: 'invalid_format' }, 200, CORS);

  // Reserved paths
  if (code === '.' || code === '..')
    return json({ valid: false, error: 'reserved_code' }, 200, CORS);

  // Weak pattern check (create only)
  if (action === 'create') {
    for (const pat of WEAK_PATTERNS) {
      if (pat.test(code)) return json({ valid: false, error: 'weak_code' }, 200, CORS);
    }
    // Entropy check: require at least 2 character classes
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(r => r.test(code));
    if (classes.length < 2)
      return json({ valid: false, error: 'low_entropy' }, 200, CORS);
  }

  return json({ valid: true }, 200, CORS);
}
