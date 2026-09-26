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
 * REQUIRED ENV VARS — primary database (Cloudflare Pages → Settings →
 * Environment Variables):
 *   FIREBASE_API_KEY            AIzaSy...
 *   FIREBASE_AUTH_DOMAIN        your-project.firebaseapp.com
 *   FIREBASE_PROJECT_ID         your-project-id
 *   FIREBASE_MESSAGING_SENDER   1234567890
 *   FIREBASE_APP_ID             1:123...:web:abc...
 *
 * ADDING MORE SHARDS — no code change, ever:
 *   For any N = 1, 2, 3, 4, ... add:
 *     FIREBASE_DBN_API_KEY
 *     FIREBASE_DBN_AUTH_DOMAIN
 *     FIREBASE_DBN_PROJECT_ID
 *     FIREBASE_DBN_SENDER
 *     FIREBASE_DBN_APP_ID
 *     FIREBASE_DBN_STORAGE_BUCKET   (optional — derived from PROJECT_ID if omitted)
 *   in Cloudflare Pages → Settings → Environment Variables, then trigger a
 *   redeploy (Deployments → ⋯ → Retry deployment — no commit needed). This
 *   file scans env for every FIREBASE_DB<N>_API_KEY it finds, in any order,
 *   with any gaps (DB1 + DB5 + DB12 all work fine) — there is no fixed slot
 *   count anywhere in this codebase. See db-manager.js and
 *   shard-registry.js for how new shards start getting traffic automatically.
 *
 * USAGE: GET /api/config
 * Returns JSON — never call this with Authorization headers (it's public).
 */

'use strict';

/**
 * Scans env for the primary (FIREBASE_*) database plus any number of
 * numbered shards (FIREBASE_DBN_*). Shared verbatim with
 * shard-registry.js and cleanup.js — each edge function is bundled
 * standalone (see build.js's `--bundle=false`), so this is duplicated
 * rather than imported, deliberately: a handful of lines kept in sync
 * beats an unverified cross-file import resolving correctly at deploy time.
 */
function discoverShards(env) {
  const shards = [{
    name:   'miut-db0',
    active: !!(env.FIREBASE_API_KEY && env.FIREBASE_PROJECT_ID),
    config: {
      apiKey:            env.FIREBASE_API_KEY            || '',
      authDomain:        env.FIREBASE_AUTH_DOMAIN        || '',
      projectId:         env.FIREBASE_PROJECT_ID         || '',
      storageBucket:     env.FIREBASE_STORAGE_BUCKET     || ((env.FIREBASE_PROJECT_ID || '') + '.firebasestorage.app'),
      messagingSenderId: env.FIREBASE_MESSAGING_SENDER   || env.FIREBASE_MESSAGING_SENDER_ID || '',
      appId:             env.FIREBASE_APP_ID             || '',
    },
  }];

  const nums = new Set();
  for (const key of Object.keys(env)) {
    const m = /^FIREBASE_DB(\d+)_API_KEY$/.exec(key);
    if (m) nums.add(parseInt(m[1], 10));
  }
  for (const n of [...nums].sort((a, b) => a - b)) {
    shards.push({
      name:   `miut-db${n}`,
      active: !!(env[`FIREBASE_DB${n}_API_KEY`] && env[`FIREBASE_DB${n}_PROJECT_ID`]),
      config: {
        apiKey:            env[`FIREBASE_DB${n}_API_KEY`]        || '',
        authDomain:        env[`FIREBASE_DB${n}_AUTH_DOMAIN`]    || '',
        projectId:         env[`FIREBASE_DB${n}_PROJECT_ID`]     || '',
        storageBucket:     env[`FIREBASE_DB${n}_STORAGE_BUCKET`] || ((env[`FIREBASE_DB${n}_PROJECT_ID`] || '') + '.firebasestorage.app'),
        messagingSenderId: env[`FIREBASE_DB${n}_SENDER`]         || '',
        appId:             env[`FIREBASE_DB${n}_APP_ID`]         || '',
      },
    });
  }
  return shards;
}

export async function onRequest(ctx) {
  const { request, env } = ctx;

  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const databases = discoverShards(env);

  return new Response(JSON.stringify({ databases }), {
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
