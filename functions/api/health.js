/**
 * MIUT — /functions/api/health.js
 * Simple health check endpoint for uptime monitors.
 * Returns version info and CF edge data center.
 */
const BUILD_VERSION = '0.0.0';
export async function onRequest(context) {
  const { request } = context;
  return new Response(JSON.stringify({
    status:  'ok',
    version: BUILD_VERSION,
    colo:    request.cf?.colo || 'unknown',
    ts:      new Date().toISOString(),
  }), {
    status: 200,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
