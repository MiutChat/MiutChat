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
    // rating.sum is the one additive counter that makes an average rating
    // derivable (sum / count) without ever storing a precomputed "average"
    // field — averages aren't atomically incrementable the way a count is,
    // so a stored one would need a read-modify-write and would drift under
    // concurrent writes. sum is just another increment, same as rating.r4.
    if (it.event === 'feedback') {
      const m = /^r([1-5])$/.exec(DIMS.rating(dims.rating));
      if (m) add('rating.sum', Number(m[1]) * n);
    }
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

// Exported (not just used internally) so feedback-migrate.js can reuse the
// exact same registry-write plumbing instead of a second copy of it.
export function api(reg, fetchImpl) {
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

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

export function incWrite(root, docPath, marker, inc) {
  return {
    update: { name: `${root}/${docPath}`, fields: { [marker[0]]: { stringValue: marker[1] } } },
    updateMask: { fieldPaths: [marker[0]] },
    updateTransforms: [
      ...[...inc].map(([fieldPath, v]) => ({ fieldPath, increment: { integerValue: String(v) } })),
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  };
}

/** Record one or more events in a single atomic commit (daily doc + lifetime totals).
 *  The caller (POST /api/analytics) always answers the browser 200 "ok" regardless
 *  of what this returns — analytics must never affect the app. That means a write
 *  failure here is otherwise invisible from the outside, so on failure this logs
 *  the REAL reason (Firestore's own status + error body, not just a generic
 *  "error") to the Worker's console — visible in the Cloudflare Pages dashboard's
 *  Functions log / `wrangler pages deployment tail` — and callers with a debug
 *  path (see diagnose() below) can surface it directly to an admin instead. */
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
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => '');
    console.error('[MIUT analytics] commit failed', res.status, detail.slice(0, 500));
    return { ok: false, reason: 'commit_' + res.status, detail: detail.slice(0, 500) };
  } catch (e) {
    console.error('[MIUT analytics] commit threw', e && e.message || e);
    return { ok: false, reason: 'error', detail: String(e && e.message || e) };
  }
}

/**
 * End-to-end self-test: checks config, fetches a real OAuth token, performs
 * one real Firestore write + readback, and reports exactly where it failed —
 * the actual status code and error body, not a guess. Built because every
 * other path here deliberately hides write failures from the browser (by
 * design — analytics must never affect the app), which otherwise makes a
 * misconfigured service account or a Firestore-side permission problem
 * completely silent. Never writes anything except a single counter in
 * analytics_meta/totals (ev.diag_ping), same as a real event would.
 */
export async function diagnose(env, fetchImpl = fetch) {
  const steps = [];
  const raw = env && env.FIREBASE_REGISTRY_SA_JSON;
  if (!raw) return { ok: false, step: 'env', detail: 'FIREBASE_REGISTRY_SA_JSON is not set' , steps};
  steps.push('env: FIREBASE_REGISTRY_SA_JSON present');

  let sa;
  try { sa = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (e) { return { ok: false, step: 'parse', detail: 'FIREBASE_REGISTRY_SA_JSON is not valid JSON: ' + (e.message || e), steps }; }
  if (!sa || !sa.client_email || !sa.private_key || !sa.project_id) {
    return { ok: false, step: 'parse', detail: 'parsed JSON is missing client_email, private_key, or project_id', steps };
  }
  steps.push(`parse: service account for ${sa.client_email} (project ${sa.project_id})`);

  const want = env.FIREBASE_REGISTRY_PROJECT_ID;
  if (want && want !== sa.project_id) {
    return { ok: false, step: 'project_match', detail: `FIREBASE_REGISTRY_PROJECT_ID ("${want}") does not match the service account's project_id ("${sa.project_id}") — registryAdmin() silently refuses to use it, so every event has been falling back to the legacy KV counters (room_created/message_sent only).`, steps };
  }
  steps.push('project_match: ok (or FIREBASE_REGISTRY_PROJECT_ID not set, so unchecked)');

  let token;
  try { token = await getAccessTokenCached(sa, fetchImpl); }
  catch (e) { return { ok: false, step: 'oauth', detail: 'Could not get an access token for this service account: ' + (e.message || e) + ' — check that the private_key was copied in full (including the BEGIN/END PRIVATE KEY lines) and that the service account itself still exists in Google Cloud.', steps }; }
  steps.push('oauth: got an access token');

  const root = `projects/${sa.project_id}/databases/(default)/documents`;
  const base = `https://firestore.googleapis.com/v1/${root}`;
  const writeRes = await fetchImpl(base + ':commit', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [incWrite(root, 'analytics_meta/totals', ['kind', 'totals'], new Map([['ev.diag_ping', 1]]))] }),
  });
  if (!writeRes.ok) {
    const detail = await writeRes.text().catch(() => '');
    return { ok: false, step: 'firestore_write', detail: `Firestore rejected the write: HTTP ${writeRes.status} — ${detail.slice(0, 500)}`, steps };
  }
  steps.push('firestore_write: ok (incremented ev.diag_ping by 1 in analytics_meta/totals, same project your real events should be landing in)');

  const readRes = await fetchImpl(base + '/analytics_meta/totals', { headers: { Authorization: `Bearer ${token}` } });
  if (!readRes.ok) {
    const detail = await readRes.text().catch(() => '');
    return { ok: false, step: 'firestore_readback', detail: `Write succeeded but reading it back failed: HTTP ${readRes.status} — ${detail.slice(0, 500)}`, steps };
  }
  const fields = decodeFields((await readRes.json()).fields);
  steps.push(`firestore_readback: ok — ev.diag_ping is now ${fields?.ev?.diag_ping ?? '(missing!)'}`);

  return { ok: true, steps, project: sa.project_id, totals_doc_fields: Object.keys(fields || {}) };
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

/** Derived, never stored: average = sum / count, computed fresh from
 *  whatever rating.* fields a totals-shaped object has (missing ones are 0).
 *  Returns null rather than 0 when there's no feedback yet, so a chart can
 *  tell "no data" apart from "a real average of zero" (which can't happen
 *  anyway — ratings are 1..5 — but null-for-empty is the honest value either way). */
export function avgRating(statsLikeFields) {
  const r = (statsLikeFields && statsLikeFields.rating) || {};
  const count = (r.r1 || 0) + (r.r2 || 0) + (r.r3 || 0) + (r.r4 || 0) + (r.r5 || 0);
  return count ? Math.round((r.sum || 0) / count * 100) / 100 : null;
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
  if (!(tRes.ok || tRes.status === 404) || !dRes.ok) {
    // Capture Firestore's actual error body, not just the two status codes —
    // without this, a failure here is undiagnosable: diagnose() doesn't
    // exercise this :runQuery call at all, so "(200/400)" with no body text
    // is the only signal anyone ever gets, in logs or otherwise.
    const [tDetail, dDetail] = await Promise.all([
      tRes.ok || tRes.status === 404 ? '' : tRes.text().catch(() => ''),
      dRes.ok ? '' : dRes.text().catch(() => ''),
    ]);
    throw new Error(`analytics read failed (${tRes.status}/${dRes.status})` + (dDetail ? ` — days query: ${dDetail.slice(0, 500)}` : '') + (tDetail ? ` — totals read: ${tDetail.slice(0, 500)}` : ''));
  }
  const totals = tRes.ok ? decodeFields((await tRes.json()).fields) : {};
  const rows = (await dRes.json()).filter(r => r.document).map(r => decodeFields(r.document.fields));
  const byDay = {};
  for (const r of rows) if (r.day) byDay[r.day] = r;
  const list = rows.filter(r => r.day);
  return { totals, days: byDay, rollup: { last7: sumEv(list, 7), last30: sumEv(list, 30) }, avgRating: avgRating(totals) };
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
