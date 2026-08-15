/**
 * MIUT — /functions/api/canary.js  (also serves /canary-trap)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Any request to /canary-trap means the client followed a redirect that was
 * only placed for automated scanners (/.env, /wp-admin, /.git, etc.).
 * Real users never visit these paths. Any IP that lands here is a scanner.
 *
 * Action taken:
 *   1. Log the IP + path + User-Agent to console (visible in CF Logpush)
 *   2. Write IP to MIUT_BAN KV with 24h TTL
 *   3. Optionally fire a webhook alert
 *   4. Return a convincing 200 response (tarpit — wastes scanner time)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Convincing fake response to waste scanner time
const FAKE_BODY = `{"status":"ok","version":"1.0","build":"${Math.random().toString(36).slice(2)}"}`;

export async function onRequest(context) {
  const { request, env } = context;

  const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
  const path    = new URL(request.url).pathname;
  const ua      = request.headers.get('User-Agent') || '';
  const country = request.cf?.country || 'unknown';
  const now     = Date.now();

  const entry = { ip, path, ua, country, ts: new Date(now).toISOString() };
  console.log('[CANARY-TRAP]', JSON.stringify(entry));

  // Ban the IP for 24 hours via KV
  if (env.MIUT_BAN) {
    await env.MIUT_BAN.put(`ban:${ip}`, JSON.stringify({
      reason: `canary_trap:${path}`,
      ua,
      bannedAt: now,
    }), { expirationTtl: 86400 }).catch(() => {});
  }

  // Webhook alert for known-bad paths
  if (env.CANARY_ALERT_URL) {
    fetch(env.CANARY_ALERT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🪤 Canary triggered on MIUT\nIP: ${ip} (${country})\nPath: ${path}\nUA: ${ua}`,
      }),
    }).catch(() => {});
  }

  // Tarpit: slow fake response (waste the scanner's connection slot)
  await new Promise(r => setTimeout(r, 2000));

  return new Response(FAKE_BODY, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Powered-By':  'PHP/7.4.33',   // fake — confuses fingerprinting
      'Server':        'Apache/2.4.54',
    },
  });
}
