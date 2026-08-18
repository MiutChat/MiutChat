/**
 * MIUT — /functions/api/health.js
 * Simple health check endpoint for uptime monitors.
 * Returns version info and CF edge data center.
 */
export async function onRequest(context) {
  const { env, request } = context;
  return new Response(JSON.stringify({
    status:  'ok',
    version: env.MIUT_VERSION || '1.0.0', // build.js stamps this to match package.json's unified version at build time
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
