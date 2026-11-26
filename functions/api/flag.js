'use strict';

import { ipToken } from '../_lib/ip-token.js';

const CATEGORIES = ['child-safety', 'threat', 'hate', 'illegal'];
const SENSITIVE = new Set(['child-safety', 'threat']);
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const TTL_SEC = 7 * 24 * 3600;
const MAX_HIDDEN = 300;
const MAX_ENTRIES = 20;
const enc = new TextEncoder();

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: HEADERS });

async function short(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  let bin = '';
  for (const b of d.slice(0, 9)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

async function readJson(kv, key, fallback) {
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env && env.MIUT_RL;
  if (!kv) return json({ error: 'not_configured' }, 501);

  if (request.method === 'GET') {
    const room = new URL(request.url).searchParams.get('room') || '';
    if (!ID_RE.test(room)) return json({ error: 'bad_room' }, 400);
    return json({ hidden: await readJson(kv, `rh:${room}`, []) });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const roomId = String(body?.roomId || '');
  const docId = String(body?.docId || '');
  const category = String(body?.category || '');
  const from = String(body?.from || '');
  if (!ID_RE.test(roomId) || !ID_RE.test(docId) || !CATEGORIES.includes(category) || !from || from.length > 128) {
    return json({ error: 'bad_request' }, 400);
  }

  const key = `rc:${roomId}:${docId}`;
  const rec = await readJson(kv, key, { u: [], i: [] });
  const uh = await short('u|' + from);
  // 14-day rotation, not the default daily one: this record's TTL is 7 days
  // (TTL_SEC above), and a daily-rotating token would make the SAME reporter
  // look like a new, distinct IP every time the UTC day rolls over during
  // that window -- artificially inflating the unique-IP count this dedup
  // check exists to measure, and making the auto-hide threshold easier to
  // trigger than intended. Same bug as report.js had; fixing it here before
  // this file ships. See ip-token.js's ipToken() doc.
  const ih = await ipToken(request, env, 14);
  if (!rec.u.includes(uh) && rec.u.length < MAX_ENTRIES) rec.u.push(uh);
  if (!rec.i.includes(ih) && rec.i.length < MAX_ENTRIES) rec.i.push(ih);
  if (SENSITIVE.has(category)) rec.s = true;

  const needUsers = rec.s ? 2 : 3;
  const needIps = rec.s ? 1 : 2;
  const hidden = rec.u.length >= needUsers && rec.i.length >= needIps;

  await kv.put(key, JSON.stringify(rec), { expirationTtl: TTL_SEC });
  if (hidden) {
    const list = await readJson(kv, `rh:${roomId}`, []);
    if (!list.includes(docId)) {
      list.push(docId);
      await kv.put(`rh:${roomId}`, JSON.stringify(list.slice(-MAX_HIDDEN)), { expirationTtl: TTL_SEC });
    }
  }
  return json({ ok: true, hidden });
}
