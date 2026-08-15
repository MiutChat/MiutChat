/**
 * functions/api/config.js
 *
 * Serves Firebase client config from Cloudflare environment variables.
 * This keeps ALL credentials out of source code / git history.
 *
 * The response is cached at the CDN edge for 5 minutes (safe — these
 * values are public identifiers, not secrets, but keeping them in env
 * vars means you can rotate them without a code deploy).
 *
 * REQUIRED ENV VARS (Cloudflare Pages → Settings → Environment Variables):
 *   FIREBASE_API_KEY            AIzaSy...
 *   FIREBASE_AUTH_DOMAIN        your-project.firebaseapp.com
 *   FIREBASE_PROJECT_ID         your-project-id
 *   FIREBASE_MESSAGING_SENDER   1234567890
 *   FIREBASE_APP_ID             1:123...:web:abc...
 *
 * OPTIONAL (for multi-shard setup):
 *   FIREBASE_DB1_API_KEY        (leave unset to keep db1 inactive)
 *   FIREBASE_DB1_AUTH_DOMAIN
 *   FIREBASE_DB1_PROJECT_ID
 *   FIREBASE_DB1_SENDER
 *   FIREBASE_DB1_APP_ID
 *
 *   FIREBASE_DB2_API_KEY
 *   FIREBASE_DB2_AUTH_DOMAIN
 *   FIREBASE_DB2_PROJECT_ID
 *   FIREBASE_DB2_SENDER
 *   FIREBASE_DB2_APP_ID
 *
 * USAGE: GET /api/config
 * Returns JSON — never call this with Authorization headers (it's public).
 */

'use strict';

export async function onRequest(ctx) {
  const { request, env } = ctx;

  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Primary database (required)
  const db0 = {
    name:   'miut-db0',
    active: !!(env.FIREBASE_API_KEY && env.FIREBASE_PROJECT_ID),
    config: {
      apiKey:            env.FIREBASE_API_KEY            || '',
      authDomain:        env.FIREBASE_AUTH_DOMAIN        || '',
      projectId:         env.FIREBASE_PROJECT_ID         || '',
      storageBucket:     env.FIREBASE_STORAGE_BUCKET     || ((env.FIREBASE_PROJECT_ID||'') + '.firebasestorage.app'),
      messagingSenderId: env.FIREBASE_MESSAGING_SENDER || env.FIREBASE_MESSAGING_SENDER_ID || '',
      appId:             env.FIREBASE_APP_ID             || '',
    },
  };

  // Optional shard 1
  const db1 = {
    name:   'miut-db1',
    active: !!(env.FIREBASE_DB1_API_KEY),
    config: {
      apiKey:            env.FIREBASE_DB1_API_KEY     || '',
      authDomain:        env.FIREBASE_DB1_AUTH_DOMAIN || '',
      projectId:         env.FIREBASE_DB1_PROJECT_ID  || '',
      messagingSenderId: env.FIREBASE_DB1_SENDER      || '',
      appId:             env.FIREBASE_DB1_APP_ID      || '',
    },
  };

  // Optional shard 2
  const db2 = {
    name:   'miut-db2',
    active: !!(env.FIREBASE_DB2_API_KEY),
    config: {
      apiKey:            env.FIREBASE_DB2_API_KEY     || '',
      authDomain:        env.FIREBASE_DB2_AUTH_DOMAIN || '',
      projectId:         env.FIREBASE_DB2_PROJECT_ID  || '',
      messagingSenderId: env.FIREBASE_DB2_SENDER      || '',
      appId:             env.FIREBASE_DB2_APP_ID      || '',
    },
  };

  const payload = JSON.stringify({ databases: [db0, db1, db2] });

  return new Response(payload, {
    status: 200,
    headers: {
      'Content-Type':  'application/json;charset=UTF-8',
      // Cache 5 min at edge — rotate credentials without cache-bust issues
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      // Only this origin can read it — blocks cross-origin hotlinking
      'Access-Control-Allow-Origin': 'same-origin',
    },
  });
}
