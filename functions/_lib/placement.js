'use strict';

/**
 * functions/_lib/placement.js
 *
 * Which shard should a new room go to? Reads utilization straight off the
 * SAME shardLoad/{name} document shard-registry.js already fetches for
 * count/degradedUntil (see usage-store.js's schema note for why reads/
 * writes/deletes/usageDay live there now) — no separate shared usage
 * document, no cache to invalidate; placement costs exactly the per-shard
 * reads it already needed.
 */

import { LIMITS } from './usage-store.js';
import { pacificDay } from './usage-ledger.js';

export const HOT_UTIL = 0.8;
export const DEFAULT_SAFETY = 1.25;

export function safetyOf(env) {
  const n = Number(env && env.USAGE_SAFETY);
  return n >= 1 && n <= 4 ? n : DEFAULT_SAFETY;
}

/**
 * `load` is the already-fetched shardLoad/{name} doc. A shard with no
 * report yet today, or whose last report is from a previous Pacific day
 * (usageDay mismatch — including the reset that happens lazily on that
 * shard's next write), reads as 0 utilization: there's nothing live to
 * measure yet, not a reason to treat the shard as unusually free OR
 * unusually loaded.
 */
export function utilization(load, now = Date.now(), safety = DEFAULT_SAFETY) {
  if (!load || load.usageDay !== pacificDay(now)) return 0;
  const reads = Number(load.reads) || 0, writes = Number(load.writes) || 0, deletes = Number(load.deletes) || 0;
  return Math.max(reads / LIMITS.reads, writes / LIMITS.writes, deletes / LIMITS.deletes) * safety;
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
