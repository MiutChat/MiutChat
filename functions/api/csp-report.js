/**
 * MIUT — /functions/api/csp-report.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * Receives Content-Security-Policy violation reports from browsers.
 * The CSP `report-uri /api/csp-report` header sends here automatically.
 * Logs to Cloudflare Logpush / console for monitoring.
 *
 * Browser sends: POST /api/csp-report  (Content-Type: application/csp-report)
 * Body:          { "csp-report": { ... } }
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.text();
    const report = JSON.parse(body);
    const csp = report['csp-report'] || report;

    const entry = {
      ts:             new Date().toISOString(),
      ip:             request.headers.get('CF-Connecting-IP') || 'unknown',
      country:        request.cf?.country || 'unknown',
      blocked_uri:    csp['blocked-uri']     || csp.blockedURL || '',
      violated:       csp['violated-directive'] || csp.effectiveDirective || '',
      document:       csp['document-uri']    || csp.documentURL || '',
      referrer:       csp['referrer']        || '',
      original_policy:csp['original-policy'] || '',
      disposition:    csp['disposition']     || 'enforce',
    };

    // Filter noise: browser extensions and browser internals
    const blocked = entry.blocked_uri;
    const NOISE = ['chrome-extension://', 'moz-extension://', 'safari-extension://', 'about:', 'blob:', 'inline'];
    if (NOISE.some(n => blocked.startsWith(n))) {
      return new Response(null, { status: 204 });
    }

    // Log for Cloudflare Logpush visibility
    console.log('[CSP-REPORT]', JSON.stringify(entry));

    // Optionally forward to webhook (e.g. Slack / Discord alert)
    if (env.CANARY_ALERT_URL && entry.blocked_uri && !NOISE.some(n => blocked.startsWith(n))) {
      fetch(env.CANARY_ALERT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `🚨 CSP violation on MIUT:\n${JSON.stringify(entry, null, 2)}` }),
      }).catch(() => {});
    }
  } catch {
    // Malformed report — ignore
  }

  return new Response(null, { status: 204 });
}
