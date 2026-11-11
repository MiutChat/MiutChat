'use strict';

/**
 * functions/_lib/usage-store.js
 *
 * Storage for the self-built Firestore read/write/delete ESTIMATE — see
 * src/core/db-manager.js's _usageMeter for how it's measured client-side,
 * and functions/_lib/placement.js for how room placement consumes it.
 *
 * SCHEMA (simplified — previously a separate usage_daily/{day} collection
 * with a full category breakdown per shard; both are gone now):
 *   shardLoad/{shardName} gains four fields, alongside the existing `count`
 *   and `degradedUntil` placement already reads from that SAME document:
 *     reads, writes, deletes   — running totals since usageDay started
 *     usageDay                 — the Pacific calendar day these totals are
 *                                 for (matches Firestore's own daily
 *                                 free-quota reset boundary)
 *   A write that finds usageDay is no longer today resets the three
 *   counters to just that write's own delta rather than erroring or
 *   requiring a separate cron pass — the reset happens inline, lazily, on
 *   whichever report happens to land first after midnight.
 *
 * Category detail (messages/members/typing/...) still exists ONLY in the
 * CLIENT's own wire format (CLIENT_CATS below) and the in-memory ledger —
 * it's summed away at the point a delta is actually written to the
 * registry, because nothing downstream (placement's utilization(), the
 * admin view) ever needed anything finer than a per-shard total; the
 * category breakdown was pure storage overhead for a number nobody read
 * broken out that way.
 *
 * Two independent paths write here, both converging on the same
 * applyUsageDeltas():
 *   - Client reports (usage.js POST → recordUsage): infrequent (one per
 *     tab every ~5 min, see db-manager.js), committed immediately.
 *   - The server's OWN self-tracked operations (ledgerAdd calls scattered
 *     through firebase-admin.js, shard-registry.js, notify.js,
 *     analytics-store.js — unchanged by this file) accumulate in the
 *     in-memory ledger (usage-ledger.js, untouched) and are flushed here
 *     periodically (flushLedger), batched to avoid a registry write on
 *     every single internal Firestore call.
 *
 * Concurrency: a write here is read-current → compute new totals →
 * conditional PATCH pinned to the document's updateTime, retried once on a
 * precondition conflict. Two concurrent writers to the SAME shard (a client
 * report landing at the same moment as a ledger flush) converge correctly
 * instead of one silently clobbering the other's delta.
 */

import { registryAdmin, api, decodeFields } from './analytics-store.js';
import { ledgerAdd, ledgerTake, ledgerRestore, ledgerSize, pacificDay } from './usage-ledger.js';

export { pacificDay };

export const CLIENT_CATS = ['room', 'messages', 'send', 'readack', 'react', 'members', 'heartbeat', 'presence', 'typing', 'config', 'feedback', 'polls', 'other'];
export const LIMITS = { reads: 50000, writes: 20000, deletes: 20000 };
export const MAX_BODY = 16384;

const RID_RE = /^[A-Za-z0-9_-]{8,32}$/;
// Generous ceiling for one real tab's ~5-minute report, not a limit anyone
// legitimate gets near — kept tight because this endpoint is unauthenticated
// and a forged report directly inflates the shardLoad numbers placement.js
// uses to route new rooms, so a high ceiling here is a load-balancer
// poisoning primitive, not just an inflated counter.
const MAX_FIELD = 3000;
const MAX_SHARD_DELTA = 6000; // hard per-shard-per-report ceiling across all categories combined, enforced in sanitizeReport below
const MIN_GAP_MS = 25000;
const round1 = n => Math.round(n * 10) / 10;

/**
 * Validates a client report and collapses it straight down to a per-shard
 * delta: every CLIENT_CATS category summed together, and ONLY today's
 * (Pacific) day considered — a report entry for any other day is dropped
 * rather than risk corrupting a day's total that's either not started yet
 * or already closed out. A late report (laptop asleep across midnight) can
 * lose its stale-day counts this way; accepted tradeoff for a system that's
 * explicitly an estimate, not a ledger of record.
 */
export function sanitizeReport(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || body.v !== 1) return null;
  if (typeof body.rid !== 'string' || !RID_RE.test(body.rid)) return null;
  if (!body.d || typeof body.d !== 'object') return null;
  const today = pacificDay(now);
  const shards = body.d[today];
  if (!shards || typeof shards !== 'object') return null;
  const deltas = new Map();
  for (const [shard, cats] of Object.entries(shards).slice(0, 16)) {
    if (!cats || typeof cats !== 'object') continue;
    const sum = [0, 0, 0, 0];
    for (const cat of CLIENT_CATS) {
      const v = cats[cat];
      if (!Array.isArray(v) || v.length !== 4) continue;
      for (let i = 0; i < 4; i++) {
        const n = Math.min(MAX_FIELD, Math.floor(Number(v[i])));
        if (n > 0) sum[i] += n;
      }
    }
    for (let i = 0; i < 4; i++) sum[i] = Math.min(sum[i], MAX_SHARD_DELTA);
    if (sum[0] || sum[1] || sum[2] || sum[3]) deltas.set(shard, sum);
  }
  return deltas.size ? { rid: body.rid, deltas } : null;
}

/** One shard's conditional read-modify-write, retried once on a precondition conflict. delta is [r, w, d, x]. */
async function writeShardDelta(root, call, shard, delta, today) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let cur = null, updateTime;
    try {
      const res = await call('/shardLoad/' + shard);
      if (res.status === 404) cur = null;
      else if (res.ok) { const doc = await res.json(); cur = decodeFields(doc.fields); updateTime = doc.updateTime; }
      else return false;
    } catch { return false; }

    const sameDay = cur && cur.usageDay === today;
    const base = sameDay ? cur : {};
    const fields = {
      reads:    { integerValue: String((Number(base.reads) || 0) + delta[0] + delta[3]) }, // rule-dependency reads (x) are real billed reads too — folded in here, the one place that distinction still mattered
      writes:   { integerValue: String((Number(base.writes) || 0) + delta[1]) },
      deletes:  { integerValue: String((Number(base.deletes) || 0) + delta[2]) },
      usageDay: { stringValue: today },
    };
    let res2;
    try {
      res2 = await call(':commit', { method: 'POST', body: JSON.stringify({ writes: [{
        update: { name: `${root}/shardLoad/${shard}`, fields },
        updateMask: { fieldPaths: ['reads', 'writes', 'deletes', 'usageDay'] },
        updateTransforms: [{ fieldPath: 'usageUpdatedAt', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: cur ? { updateTime } : { exists: false },
      }] }) });
    } catch { return false; }
    if (res2.ok) return true;
    if (res2.status === 400 || res2.status === 409) continue; // precondition failed (someone else wrote first) — re-read and retry once
    return false;
  }
  return false;
}

/** deltaMap: Map<shard, [r,w,d,x]>. Each shard is independent — one failing never blocks the others. */
export async function applyUsageDeltas(env, deltaMap, fetchImpl = fetch, now = Date.now()) {
  const reg = registryAdmin(env);
  if (!reg) return { ok: false, reason: 'not_configured' };
  if (!deltaMap || !deltaMap.size) return { ok: true, empty: true };
  const { root, call } = api(reg, fetchImpl);
  const today = pacificDay(now);
  const failedShards = [];
  for (const [shard, delta] of deltaMap) {
    const ok = await writeShardDelta(root, call, shard, delta, today);
    if (!ok) failedShards.push(shard);
  }
  return { ok: failedShards.length === 0, failedShards };
}

export const recordUsage = (env, report, fetchImpl = fetch) => applyUsageDeltas(env, report.deltas, fetchImpl);

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

/** Collapses the ledger's accumulated (shard, cat, [r,w,d,x]) cells to per-shard totals for TODAY and commits them — everything else about the ledger (usage-ledger.js) is unchanged. */
export async function flushLedger(env, { force = false, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!ledgerSize()) return { ok: true, empty: true };
  if (!force && now - lastFlush < MIN_GAP_MS) return { ok: true, deferred: true, waitMs: MIN_GAP_MS - (now - lastFlush) };
  if (!registryAdmin(env)) { ledgerTake(); return { ok: false, reason: 'not_configured' }; }
  lastFlush = now;
  const items = ledgerTake(); // [{day, shard, cat, c:[r,w,d,x]}]
  const today = pacificDay(now);
  const byShard = new Map();
  const itemsByShard = new Map(); // kept so a PARTIAL failure can restore only the shards that actually failed, not the whole flush
  for (const it of items) {
    if (it.day !== today) continue; // a stray entry from a flush delayed across a midnight boundary — dropped, not corrupted into the wrong day's total
    const d = byShard.get(it.shard) || [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) d[i] += it.c[i];
    byShard.set(it.shard, d);
    (itemsByShard.get(it.shard) || itemsByShard.set(it.shard, []).get(it.shard)).push(it);
  }
  const res = await applyUsageDeltas(env, byShard, fetchImpl, now);
  if (!res.ok && ledgerSize() < 200) {
    const toRestore = [];
    for (const shard of res.failedShards || []) toRestore.push(...(itemsByShard.get(shard) || []));
    if (toRestore.length) ledgerRestore(toRestore);
  }
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

/**
 * Per-shard summary straight from shardLoad — the same document placement
 * already reads for count/degradedUntil, now also holding the usage
 * totals, so the admin view costs exactly one read per shard, same as
 * before this feature existed.
 */
export async function readUsage(env, shardNames, fetchImpl = fetch, now = Date.now()) {
  const reg = registryAdmin(env);
  if (!reg) return { error: 'not_configured' };
  const { call } = api(reg, fetchImpl);
  const today = pacificDay(now);
  const shards = {};
  for (const name of shardNames) {
    let res;
    try { res = await call('/shardLoad/' + name); } catch { shards[name] = { error: 'read_failed' }; continue; }
    ledgerAdd('registry', 'usage', 1);
    if (res.status === 404) { shards[name] = { reads: 0, writes: 0, deletes: 0, usageDay: null, stale: true, pct: { reads: 0, writes: 0, deletes: 0 } }; continue; }
    if (!res.ok) { shards[name] = { error: 'read_failed', status: res.status }; continue; }
    const doc = decodeFields((await res.json()).fields);
    const stale = doc.usageDay !== today; // yesterday's totals (or no report at all yet today) — not a live number, but worth showing which it is
    const reads = stale ? 0 : (Number(doc.reads) || 0);
    const writes = stale ? 0 : (Number(doc.writes) || 0);
    const deletes = stale ? 0 : (Number(doc.deletes) || 0);
    shards[name] = {
      reads, writes, deletes, usageDay: doc.usageDay || null, stale,
      pct: { reads: round1(100 * reads / LIMITS.reads), writes: round1(100 * writes / LIMITS.writes), deletes: round1(100 * deletes / LIMITS.deletes) },
    };
  }
  return { limits: LIMITS, resetsAt: 'midnight America/Los_Angeles', shards, ts: new Date(now).toISOString() };
}
