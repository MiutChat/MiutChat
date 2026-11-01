/**
 * functions/_lib/analytics-store.js
 *
 * Anonymous, aggregate-only usage counters stored in the REGISTRY Firebase
 * project (the least-used project: free Spark = 20,000 writes/day, versus the
 * 1,000/day Cloudflare KV budget the old implementation lived in).
 *
 * PRIVACY: counters only. No room codes, no user ids, no IPs, no message
 * content — nothing that identifies a person or a room is ever written.
 * Country is a coarse aggregate taken from Cloudflare's own header (switch off
 * with ANALYTICS_GEO=off).
 *
 * ENV
 *   FIREBASE_REGISTRY_SA_JSON       service-account key of the REGISTRY project
 *   FIREBASE_REGISTRY_PROJECT_ID    (already set for shard-registry) — if present
 *                                   it must match the key's project, so analytics
 *                                   can never be written into a chat shard by mistake.
 *
 * DATA MODEL (all counters are atomic server-side increments, one commit per call)
 *   analytics_daily/{YYYY-MM-DD}   { day, updatedAt, ev:{…}, plat:{…}, … }
 *   analytics_meta/totals          same shape, lifetime
 *   analytics_meta/migration       state of the one-off KV → Firestore import
 *
 * Counter groups (every key is [a-z_][a-z0-9_]* — required by Firestore field paths):
 *   ev.<event>     how many times each event happened
 *   ttl.<bucket>   message-timer chosen when rooms are created
 *   kind.<k>       joins: new | rejoin | pending
 *   why.<r>        failed joins: not_found | expired | blocked | declined
 *   ft.<type>      files sent: image | video | file
 *   plat / mode / ver / lang / geo   dimensions, counted on app_open only
 *   rating.<r1..r5>
 *   hr.<hNN>       client events per UTC hour (peak-usage histogram)
 *
 * Every dimension value is validated against a fixed list or a strict pattern
 * and anything else becomes "other", so a client can't blow up the document
 * with unbounded keys.
 */

'use strict';

import { getAccessTokenCached, dropCachedToken } from './firebase-admin.js';

// ── Schema ──────────────────────────────────────────────────────────────────
const ENUMS = {
  ttl:    ['off', 's30', 'm5', 'h1', 'h24', 'd7'],
  kind:   ['new', 'rejoin', 'pending'],
  why:    ['not_found', 'expired', 'blocked', 'declined'],
  ft:     ['image', 'video', 'file'],
  plat:   ['android', 'ios', 'windows', 'mac', 'linux', 'chromeos'],
  mode:   ['pwa', 'browser'],
  rating: ['r1', 'r2', 'r3', 'r4', 'r5'],
};
const enumDim = name => raw => {
  const v = String(raw ?? '').toLowerCase().slice(0, 16);
  return ENUMS[name].includes(v) ? v : 'other';
};
const DIMS = {
  ttl: enumDim('ttl'), kind: enumDim('kind'), why: enumDim('why'), ft: enumDim('ft'),
  plat: enumDim('plat'), mode: enumDim('mode'), rating: enumDim('rating'),
  ver:  raw => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,4})$/.exec(String(raw ?? '')); return m ? `v${m[1]}_${m[2]}_${m[3]}` : 'other'; },
  lang: raw => { const m = /^[a-z]{2,3}/i.exec(String(raw ?? '')); return m ? m[0].toLowerCase() : 'other'; },
};

/** Events a browser may report, and which dimensions each one may carry. */
export const CLIENT_EVENTS = {
  room_created:  ['ttl'],
  room_joined:   ['kind'],
  join_failed:   ['why'],
  message_sent:  [],
  file_sent:     ['ft'],
  app_open:      ['plat', 'mode', 'ver', 'lang'],
  pwa_installed: [],
  push_enabled:  [],
  feedback:      ['rating'],
};
/** Events only the server records (a browser can't send these). */
export const SERVER_EVENTS = new Set(['rooms_wiped', 'messages_expired']);

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_N = 10;

// ── Increment building (pure) ───────────────────────────────────────────────
/**
 * items: [{ event, n?, dims?, hour?, country? }] → Map<fieldPath, amount>
 * Unknown events are dropped; unknown dimension values become "other".
 */
export function buildIncrements(items) {
  const inc = new Map();
  const add = (path, v) => {
    if (!path.split('.').every(seg => SEGMENT.test(seg))) return;   // defence in depth
    inc.set(path, (inc.get(path) || 0) + v);
  };
  for (const it of items) {
    const n = Math.min(MAX_N, Math.max(1, Math.floor(Number(it.n)) || 1));
    if (typeof it.event !== 'string') continue;
    if (SERVER_EVENTS.has(it.event)) { add(`ev.${it.event}`, Math.max(1, Math.floor(Number(it.n)) || 1)); continue; }
    // own-property check: '__proto__', 'constructor', 'toString'… must never resolve to an inherited value
    if (!Object.prototype.hasOwnProperty.call(CLIENT_EVENTS, it.event)) continue;
    const spec = CLIENT_EVENTS[it.event];
    add(`ev.${it.event}`, n);
    const dims = it.dims && typeof it.dims === 'object' ? it.dims : {};
    for (const d of spec) add(`${d}.${DIMS[d](dims[d])}`, n);
    if (it.event === 'app_open' && it.country) {
      const cc = /^[A-Za-z]{2}$/.test(it.country) ? it.country.toLowerCase() : 'xx';
      add(`geo.${cc}`, 1);
    }
    if (Number.isInteger(it.hour) && it.hour >= 0 && it.hour <= 23) add(`hr.h${String(it.hour).padStart(2, '0')}`, n);
  }
  return inc;
}

// ── Firestore REST ──────────────────────────────────────────────────────────
/** The registry project's service account, or null if analytics storage isn't configured. */
export function registryAdmin(env) {
  const raw = env && env.FIREBASE_REGISTRY_SA_JSON;
  if (!raw) return null;
  try {
    const sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!sa || !sa.client_email || !sa.private_key || !sa.project_id) return null;
    const want = env.FIREBASE_REGISTRY_PROJECT_ID;
    if (want && want !== sa.project_id) return null;           // wrong project → refuse, never write
    return { sa, projectId: sa.project_id };
  } catch { return null; }
}

function api(reg, fetchImpl) {
  const root = `projects/${reg.projectId}/databases/(default)/documents`;
  const base = `https://firestore.googleapis.com/v1/${root}`;
  async function call(path, init = {}) {
    const token = await getAccessTokenCached(reg.sa, fetchImpl);
    const res = await fetchImpl(base + path, {
      ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 401) dropCachedToken(reg.sa);
    return res;
  }
  return { root, call };
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

function incWrite(root, docPath, marker, inc) {
  return {
    update: { name: `${root}/${docPath}`, fields: { [marker[0]]: { stringValue: marker[1] } } },
    updateMask: { fieldPaths: [marker[0]] },
    updateTransforms: [
      ...[...inc].map(([fieldPath, v]) => ({ fieldPath, increment: { integerValue: String(v) } })),
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  };
}

/** Record one or more events in a single atomic commit (daily doc + lifetime totals). */
export async function recordEvents(env, items, fetchImpl = fetch) {
  const reg = registryAdmin(env);
  if (!reg) return { ok: false, reason: 'not_configured' };
  const inc = buildIncrements(items);
  if (!inc.size) return { ok: false, reason: 'nothing_to_record' };
  try {
    const { root, call } = api(reg, fetchImpl);
    const day = dayKey();
    const res = await call(':commit', { method: 'POST', body: JSON.stringify({ writes: [
      incWrite(root, `analytics_daily/${day}`, ['day', day], inc),
      incWrite(root, 'analytics_meta/totals',  ['kind', 'totals'], inc),
    ] }) });
    return res.ok ? { ok: true } : { ok: false, reason: 'commit_' + res.status };
  } catch (e) { return { ok: false, reason: 'error' }; }
}

// ── Reading ─────────────────────────────────────────────────────────────────
export function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
export function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}

function sumEv(days, n) {
  const out = {};
  for (const d of days.slice(0, n)) for (const [k, v] of Object.entries(d.ev || {})) out[k] = (out[k] || 0) + v;
  return out;
}

/** Totals + the most recent `days` daily docs (1 + N reads). */
export async function readStats(env, days = 30, fetchImpl = fetch) {
  const reg = registryAdmin(env);
  if (!reg) return null;
  const { call } = api(reg, fetchImpl);
  const N = Math.min(90, Math.max(1, Math.floor(Number(days)) || 30));
  const [tRes, dRes] = await Promise.all([
    call('/analytics_meta/totals'),
    call(':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'analytics_daily' }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'DESCENDING' }],
      limit: N,
    } }) }),
  ]);
  if (!(tRes.ok || tRes.status === 404) || !dRes.ok) throw new Error(`analytics read failed (${tRes.status}/${dRes.status})`);
  const totals = tRes.ok ? decodeFields((await tRes.json()).fields) : {};
  const rows = (await dRes.json()).filter(r => r.document).map(r => decodeFields(r.document.fields));
  const byDay = {};
  for (const r of rows) if (r.day) byDay[r.day] = r;
  const list = rows.filter(r => r.day);
  return { totals, days: byDay, rollup: { last7: sumEv(list, 7), last30: sumEv(list, 30) } };
}

// ── One-off import of the old KV counters ───────────────────────────────────
/**
 * Pages through KV `analytics:*` keys (20 per call to stay under the free
 * plan's per-invocation subrequest limit) and ADDS them into Firestore.
 * Replay-safe: each page's commit carries a precondition on the migration
 * state doc, so applying the same page twice is impossible.
 */
export async function migrateKv(env, cursor = '', fetchImpl = fetch) {
  const reg = registryAdmin(env), kv = env && env.MIUT_KV;
  if (!reg) return { status: 501, body: { error: 'registry_not_configured' } };
  if (!kv) return { status: 400, body: { error: 'no_kv_binding' } };
  const { root, call } = api(reg, fetchImpl);

  const sRes = await call('/analytics_meta/migration');
  let state = null;
  if (sRes.ok) { const d = await sRes.json(); state = { f: decodeFields(d.fields), updateTime: d.updateTime }; }
  else if (sRes.status !== 404) return { status: 502, body: { error: 'state_read_' + sRes.status } };
  if (state && state.f.done) return { status: 200, body: { done: true, already: true } };
  if ((cursor || '') !== ((state && state.f.cursor) || '')) {
    return { status: 409, body: { error: 'cursor_mismatch', expected: (state && state.f.cursor) || '' } };
  }

  const page = await kv.list({ prefix: 'analytics:', limit: 20, ...(cursor ? { cursor } : {}) });
  const totals = new Map(), perDay = new Map();
  let used = 0;
  for (const k of page.keys) {
    const m = /^analytics:(?:day:(\d{4}-\d{2}-\d{2}):)?(room_created|message_sent)$/.exec(k.name);
    if (!m) continue;
    const v = parseInt(await kv.get(k.name) || '0', 10);
    if (!(v > 0)) continue;
    used++;
    const path = `ev.${m[2]}`;
    if (m[1]) { if (!perDay.has(m[1])) perDay.set(m[1], new Map()); perDay.get(m[1]).set(path, v); }
    else totals.set(path, v);
  }

  const done = !!page.list_complete, next = done ? '' : (page.cursor || '');
  const writes = [];
  if (totals.size) writes.push(incWrite(root, 'analytics_meta/totals', ['kind', 'totals'], totals));
  for (const [day, inc] of perDay) writes.push(incWrite(root, `analytics_daily/${day}`, ['day', day], inc));
  writes.push({
    update: { name: `${root}/analytics_meta/migration`, fields: { cursor: { stringValue: next }, done: { booleanValue: done } } },
    updateMask: { fieldPaths: ['cursor', 'done'] },
    currentDocument: state ? { updateTime: state.updateTime } : { exists: false },
  });
  const res = await call(':commit', { method: 'POST', body: JSON.stringify({ writes }) });
  if (res.status === 409 || res.status === 400 && (await res.clone().text()).includes('FAILED_PRECONDITION')) {
    return { status: 409, body: { error: 'page_already_applied' } };
  }
  if (!res.ok) return { status: 502, body: { error: 'commit_' + res.status } };
  return { status: 200, body: { migrated: used, done, cursor: next } };
}
