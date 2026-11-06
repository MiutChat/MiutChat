'use strict';

import { LIMITS } from './usage-store.js';
import { pacificDay } from './usage-ledger.js';

export const HOT_UTIL = 0.8;
export const DEFAULT_SAFETY = 1.25;
const CACHE_MS = 60000;

export function safetyOf(env) {
  const n = Number(env && env.USAGE_SAFETY);
  return n >= 1 && n <= 4 ? n : DEFAULT_SAFETY;
}

export function utilization(doc, shardName, safety = DEFAULT_SAFETY) {
  const cats = doc && doc.s && doc.s[shardName.replace('-', '_')];
  if (!cats) return 0;
  let r = 0, w = 0, d = 0, x = 0;
  for (const c of Object.values(cats)) {
    r += Number(c.r) || 0; w += Number(c.w) || 0; d += Number(c.d) || 0; x += Number(c.x) || 0;
  }
  return Math.max((r + x) / LIMITS.reads, w / LIMITS.writes, d / LIMITS.deletes) * safety;
}

export function pickShard(live, rng = Math.random) {
  const usable = live.filter(s => !s.degraded);
  const open = usable.filter(s => s.util < HOT_UTIL);
  const pool = open.length ? open : usable.length ? usable : live;
  const band = s => Math.floor(s.util * 10);
  const lowest = Math.min(...pool.map(band));
  const inBand = pool.filter(s => band(s) === lowest);
  const fewest = Math.min(...inBand.map(s => s.count));
  const tied = inBand.filter(s => s.count === fewest);
  return tied[Math.floor(rng() * tied.length)];
}

let cache = { at: 0, day: '', doc: null };

export async function loadUsageDoc(readDoc, now = Date.now()) {
  const day = pacificDay(now);
  if (cache.day === day && now - cache.at < CACHE_MS) return cache.doc;
  try {
    const doc = await readDoc(day);
    cache = { at: now, day, doc };
    return doc;
  } catch {
    return cache.day === day ? cache.doc : null;
  }
}

export const resetUsageCache = () => { cache = { at: 0, day: '', doc: null }; };
