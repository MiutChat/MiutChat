'use strict';

import { sanitizeReport, recordUsage, readUsage, claimRid, releaseRid, MAX_BODY } from '../_lib/usage-store.js';
import { discoverAdminShards } from '../_lib/firebase-admin.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
});

function authorized(request, env) {
  const secret = env?.ADMIN_ACCESS || '';
  if (!secret) return false;
  const te = new TextEncoder();
  const a = te.encode(request.headers.get('Authorization') || ''), b = te.encode(`Bearer ${secret}`);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (request.method === 'GET') {
    if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
    const shardNames = discoverAdminShards(env).map(s => s.name);
    const out = await readUsage(env, shardNames, fetch, Date.now());
    return json(out, out.error ? 502 : 200);
  }

  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return json({ error: 'too_large' }, 413);
  let body = null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413);
    body = JSON.parse(text);
  } catch { return json({ error: 'bad_json' }, 400); }

  const report = sanitizeReport(body);
  if (!report) return json({ error: 'invalid' }, 400);
  if (!claimRid(report.rid)) return json({ ok: true, duplicate: true });

  const res = await recordUsage(env, report);
  if (res.ok) return json({ ok: true });
  if (res.reason === 'not_configured') return json({ ok: false, reason: 'not_configured' });
  releaseRid(report.rid);
  return json({ ok: false, reason: res.reason }, 502);
}
