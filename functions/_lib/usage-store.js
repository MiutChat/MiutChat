'use strict';

import { registryAdmin, api, incWrite, decodeFields } from './analytics-store.js';
import { ledgerAdd, ledgerTake, ledgerRestore, ledgerSize, pacificDay, shiftDay } from './usage-ledger.js';

export { pacificDay };

export const CLIENT_CATS = ['room', 'messages', 'send', 'readack', 'react', 'members', 'heartbeat', 'presence', 'typing', 'config', 'feedback', 'polls', 'other'];
export const LIMITS = { reads: 50000, writes: 20000, deletes: 20000 };
export const MAX_BODY = 16384;

const METRICS = ['r', 'w', 'd', 'x'];
const SHARD_RE = /^miut-db\d{1,3}$/;
const RID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FIELD = 200000;
const MIN_GAP_MS = 25000;

const bump = (map, key, n) => map.set(key, (map.get(key) || 0) + n);
const fieldKey = shard => shard.replace('-', '_');

export function sanitizeReport(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || body.v !== 1) return null;
  if (typeof body.rid !== 'string' || !RID_RE.test(body.rid)) return null;
  if (!body.d || typeof body.d !== 'object') return null;
  const today = pacificDay(now);
  const oldest = shiftDay(today, -3);
  const days = new Map();
  let total = 0;
  for (const [rawDay, shards] of Object.entries(body.d).slice(0, 8)) {
    if (!DAY_RE.test(rawDay) || !shards || typeof shards !== 'object') continue;
    const day = rawDay > today ? today : rawDay < oldest ? oldest : rawDay;
    for (const [shard, cats] of Object.entries(shards).slice(0, 16)) {
      if (!SHARD_RE.test(shard) || !cats || typeof cats !== 'object') continue;
      for (const cat of CLIENT_CATS) {
        const v = cats[cat];
        if (!Array.isArray(v) || v.length !== 4) continue;
        for (let i = 0; i < 4; i++) {
          const n = Math.min(MAX_FIELD, Math.floor(Number(v[i])));
          if (!(n > 0)) continue;
          if (!days.has(day)) days.set(day, new Map());
          bump(days.get(day), `s.${fieldKey(shard)}.${cat}.${METRICS[i]}`, n);
          total += n;
        }
      }
    }
  }
  return total ? { rid: body.rid, days } : null;
}

async function commitDays(env, days, fetchImpl) {
  const reg = registryAdmin(env);
  if (!reg) return { ok: false, reason: 'not_configured' };
  try {
    const { root, call } = api(reg, fetchImpl);
    const writes = [];
    for (const [day, inc] of days) {
      const merged = new Map(inc);
      bump(merged, 's.registry.usage.w', 1);
      writes.push(incWrite(root, `usage_daily/${day}`, ['day', day], merged));
    }
    const res = await call(':commit', { method: 'POST', body: JSON.stringify({ writes }) });
    if (res.ok) return { ok: true };
    return { ok: false, reason: 'commit_' + res.status, detail: (await res.text().catch(() => '')).slice(0, 300) };
  } catch (e) {
    return { ok: false, reason: 'error', detail: String(e && e.message || e).slice(0, 300) };
  }
}

export const recordUsage = (env, report, fetchImpl = fetch) => commitDays(env, report.days, fetchImpl);

export function shardQuotaPct(dayFields, shard) {
  const cats = (dayFields && dayFields.s && dayFields.s[fieldKey(shard)]) || {};
  let r = 0, w = 0, d = 0, x = 0;
  for (const c of Object.values(cats)) { r += c.r || 0; w += c.w || 0; d += c.d || 0; x += c.x || 0; }
  return {
    reads: 100 * (r + x) / LIMITS.reads,
    writes: 100 * w / LIMITS.writes,
    deletes: 100 * d / LIMITS.deletes,
  };
}

export async function readTodayUsage(env, fetchImpl = fetch, now = Date.now()) {
  const reg = registryAdmin(env);
  if (!reg) return null;
  const { call } = api(reg, fetchImpl);
  const res = await call('/usage_daily/' + pacificDay(now));
  if (res.status === 404) return {};
  if (!res.ok) return null;
  return decodeFields((await res.json()).fields);
}

const seen = new Map();
export function claimRid(rid, now = Date.now()) {
  for (const [k, t] of seen) {
    if (now - t > 600000 || seen.size > 1000) seen.delete(k);
    else break;
  }
  if (seen.has(rid)) return false;
  seen.set(rid, now);
  return true;
}

export const releaseRid = rid => { seen.delete(rid); };

let lastFlush = 0;
let trailing = false;

export async function flushLedger(env, { force = false, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!ledgerSize()) return { ok: true, empty: true };
  if (!force && now - lastFlush < MIN_GAP_MS) return { ok: true, deferred: true, waitMs: MIN_GAP_MS - (now - lastFlush) };
  if (!registryAdmin(env)) { ledgerTake(); return { ok: false, reason: 'not_configured' }; }
  lastFlush = now;
  const items = ledgerTake();
  const days = new Map();
  for (const it of items) {
    if (!days.has(it.day)) days.set(it.day, new Map());
    const base = `s.${fieldKey(it.shard)}.${it.cat}`;
    METRICS.forEach((m, i) => { if (it.c[i]) bump(days.get(it.day), `${base}.${m}`, it.c[i]); });
  }
  const res = await commitDays(env, days, fetchImpl);
  if (!res.ok && ledgerSize() < 200) ledgerRestore(items);
  return res;
}

export function flushSoon(env, waitUntil) {
  waitUntil(flushLedger(env).then(res => {
    if (!res.deferred || trailing) return;
    trailing = true;
    return new Promise(r => setTimeout(r, res.waitMs + 500))
      .then(() => flushLedger(env, { force: true }))
      .finally(() => { trailing = false; });
  }).catch(() => {}));
}

const round1 = n => Math.round(n * 10) / 10;

function summarize(s) {
  const out = {};
  for (const [shard, cats] of Object.entries(s || {})) {
    const t = { reads: 0, ruleReads: 0, writes: 0, deletes: 0 };
    for (const c of Object.values(cats || {})) {
      t.reads += c.r || 0; t.writes += c.w || 0; t.deletes += c.d || 0; t.ruleReads += c.x || 0;
    }
    const billedReads = t.reads + t.ruleReads;
    out[shard] = {
      ...t,
      billedReads,
      pct: {
        reads: round1(100 * billedReads / LIMITS.reads),
        writes: round1(100 * t.writes / LIMITS.writes),
        deletes: round1(100 * t.deletes / LIMITS.deletes),
      },
      byCategory: cats,
    };
  }
  return out;
}

export async function readUsage(env, nDays = 7, fetchImpl = fetch, now = Date.now()) {
  const reg = registryAdmin(env);
  if (!reg) return { error: 'not_configured' };
  const n = Math.min(14, Math.max(1, Math.floor(Number(nDays)) || 7));
  const { call } = api(reg, fetchImpl);
  const today = pacificDay(now);
  const days = [];
  for (let i = 0; i < n; i++) {
    const day = shiftDay(today, -i);
    const res = await call('/usage_daily/' + day);
    if (res.status === 404) { days.push({ day, shards: {} }); continue; }
    if (!res.ok) return { error: 'read_failed', status: res.status, day };
    const doc = await res.json();
    days.push({ day, shards: summarize(decodeFields(doc.fields).s) });
  }
  ledgerAdd('registry', 'usage', n);
  return { limits: LIMITS, resetsAt: 'midnight America/Los_Angeles', days, ts: new Date(now).toISOString() };
}
