/**
 * functions/_lib/feedback-migrate.js
 *
 * One-off, resumable import of the FULL feedback documents already sitting
 * in each chat shard's own `feedback` collection (written directly by the
 * client — see src/app/lazy/feedback.js:_fbSubmit) into the registry's
 * aggregate rating counters (analytics-store.js's rating.r1..r5 + rating.sum
 * — see that file for why sum, not a stored average).
 *
 * WHY THIS EXISTS: a feedback submission already writes two things today —
 * the full doc (rating + tags + comment) to ITS OWN shard's `feedback`
 * collection, and a same-moment counter bump to the registry via
 * track('feedback', …) → POST /api/analytics. Those stay in sync for
 * everything submitted through a client that has that track() call. This
 * reconciles the registry's totals against the shards' own raw records for
 * anything that doesn't — older feedback from before that counter existed,
 * or any one-off where the counter call failed while the raw doc write
 * succeeded (track() failures are silently swallowed by design, same as
 * every other analytics call — see recordEvents' doc comment).
 *
 * EACH FEEDBACK DOC IS COUNTED ON THE DAY IT WAS ACTUALLY SUBMITTED, not the
 * day this migration happens to run — createdAt on the doc itself decides
 * which analytics_daily/{YYYY-MM-DD} it lands in. The lifetime totals doc
 * gets the same increments regardless of date, same as a live submission.
 *
 * REPLAY-SAFETY: resumable per shard via a high-water-mark cursor (the
 * createdAt of the last feedback doc processed for that shard), stored at
 * analytics_meta/migration_feedback_<shardName> in the registry, advanced
 * with the same updateTime-precondition pattern analytics-store.js's
 * migrateKv() already uses — re-POSTing the same page is a no-op, never a
 * double count. A createdAt cursor (rather than an offset) also means a
 * resumed page never re-reads documents it already processed: Firestore
 * bills an extra read for every document an `offset` skips, a range-filter
 * cursor pays nothing for what it skips.
 *
 * COST, per call, shared with the existing ~50-subrequest/invocation budget
 * (see firebase-admin.js's Budget — same ceiling runAdminCleanup works
 * within): per shard, 1 registry read (migration state) + 1 shard runQuery
 * (up to PAGE feedback docs — ONE subrequest and one Firestore query
 * regardless of how many of those docs come back) + 1 registry commit. Five
 * shards ≈ 15 subrequests per call, comfortably inside the ~50 ceiling
 * alongside whatever else runs in the same invocation. Firestore-side: each
 * returned feedback doc is one normal document read (createdAt is the
 * query's only range field, which Firestore explicitly exempts from the
 * extra index-entry charge a second range field would add — see
 * cloud.google.com/firestore/pricing). The registry commit is 1-3 writes
 * (one per day bucket touched this page, plus the totals doc, plus the
 * cursor) — for a realistic backlog that's a handful of distinct days per
 * page, not one write per feedback doc.
 *
 * USAGE (admin only, same Bearer as every other admin action):
 *   curl -X POST https://miutchat.pages.dev/api/analytics?action=migrate-feedback \
 *        -H "Authorization: Bearer $ADMIN_ACCESS"
 *   Repeat (same call, no body needed) until every shard in the response
 *   reports done:true — the cursor lives server-side in Firestore, so unlike
 *   the KV migration there's no pageToken to carry between calls yourself.
 */

'use strict';

import { discoverAdminShards, makeClient, Budget, BudgetExceeded, getAccessTokenCached, dropCachedToken } from './firebase-admin.js';
import { registryAdmin, incWrite, dayKey, decodeFields } from './analytics-store.js';

const PAGE = 100; // feedback docs per shard per call

function registryApi(reg, fetchImpl) {
  const root = `projects/${reg.projectId}/databases/(default)/documents`;
  const base = `https://firestore.googleapis.com/v1/${root}`;
  return {
    root,
    async call(path, init = {}) {
      const token = await getAccessTokenCached(reg.sa, fetchImpl);
      const res = await fetchImpl(base + path, {
        ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (res.status === 401) dropCachedToken(reg.sa);
      return res;
    },
  };
}

/**
 * Pure (no network): turns a page of decoded feedback docs into per-day
 * increment maps + a grand total for this page, validating and skipping
 * anything malformed rather than guessing. Exported on its own specifically
 * so it's unit-testable without mocking Firestore — see
 * tests/feedback-migrate.test.js.
 *
 * `docs`: [{ fields: {rating, createdAt, ...}, name }] — the shape runQuery
 * rows have BEFORE decoding (decodeFields is applied here per-doc so the
 * caller doesn't have to).
 * → { byDay: Map<"YYYY-MM-DD", Map<fieldPath, amount>>, total: Map<fieldPath, amount>,
 *     processed, skipped, lastCreatedAt: string|null }
 */
export function groupFeedbackPage(docs) {
  const byDay = new Map(), total = new Map();
  let processed = 0, skipped = 0, lastCreatedAt = null;

  const bump = (map, path, v) => map.set(path, (map.get(path) || 0) + v);

  for (const row of docs) {
    const f = decodeFields(row.document ? row.document.fields : row.fields);
    const rating = Number(f.rating);
    const createdAt = f.createdAt;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || typeof createdAt !== 'string' || !Date.parse(createdAt)) {
      skipped++;
      continue;
    }
    const day = dayKey(new Date(createdAt));
    if (!byDay.has(day)) byDay.set(day, new Map());
    const dayMap = byDay.get(day);
    bump(dayMap, 'ev.feedback', 1);
    bump(dayMap, `rating.r${rating}`, 1);
    bump(dayMap, 'rating.sum', rating);
    bump(total, 'ev.feedback', 1);
    bump(total, `rating.r${rating}`, 1);
    bump(total, 'rating.sum', rating);
    processed++;
    // Docs come back orderBy createdAt ASC, so the last one processed is the
    // new high-water mark — ISO string compares correctly as a Firestore
    // timestampValue filter, no need to parse it back out.
    lastCreatedAt = createdAt;
  }
  return { byDay, total, processed, skipped, lastCreatedAt };
}

/** One shard's worth of work for one call. Never throws BudgetExceeded past
 *  this point — it's caught here so one exhausted shard still lets the
 *  caller report partial progress on the others instead of losing the
 *  whole response. */
async function migrateShard(shard, reg, budget, fetchImpl) {
  const regApi = registryApi(reg, fetchImpl);
  const statePath = `analytics_meta/migration_feedback_${shard.name}`;

  let state = null;
  try {
    budget.take();
    const sRes = await regApi.call('/' + statePath);
    if (sRes.ok) { const d = await sRes.json(); state = { f: decodeFields(d.fields), updateTime: d.updateTime }; }
    else if (sRes.status !== 404) return { shard: shard.name, error: 'state_read_' + sRes.status };
  } catch (e) {
    if (e instanceof BudgetExceeded) return { shard: shard.name, deferred: true };
    return { shard: shard.name, error: String(e && e.message || e) };
  }
  if (state && state.f.done) return { shard: shard.name, done: true, processed: 0, skipped: 0, alreadyDone: true };

  const cursor = (state && state.f.cursor) || null;
  const client = makeClient(shard, budget, fetchImpl);
  let rows;
  try {
    rows = await client.runQuery('', {
      from: [{ collectionId: 'feedback' }],
      ...(cursor ? { where: { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'GREATER_THAN', value: { timestampValue: cursor } } } } : {}),
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' }],
      select: { fields: [{ fieldPath: 'rating' }, { fieldPath: 'createdAt' }] },
      limit: PAGE,
    });
  } catch (e) {
    if (e instanceof BudgetExceeded) return { shard: shard.name, deferred: true };
    return { shard: shard.name, error: 'query_failed: ' + String(e && e.message || e) };
  }

  const { byDay, total, processed, skipped, lastCreatedAt } = groupFeedbackPage(rows);
  const done = rows.length < PAGE;
  // No docs AND no prior cursor means an empty/never-used feedback collection
  // on this shard — that's done, not an error.
  const newCursor = lastCreatedAt || cursor || '';

  const writes = [];
  for (const [day, inc] of byDay) writes.push(incWrite(regApi.root, `analytics_daily/${day}`, ['day', day], inc));
  if (total.size) writes.push(incWrite(regApi.root, 'analytics_meta/totals', ['kind', 'totals'], total));
  writes.push({
    update: { name: `${regApi.root}/${statePath}`, fields: { cursor: { stringValue: newCursor }, done: { booleanValue: done } } },
    updateMask: { fieldPaths: ['cursor', 'done'] },
    currentDocument: state ? { updateTime: state.updateTime } : { exists: false },
  });

  try {
    budget.take();
    const res = await regApi.call(':commit', { method: 'POST', body: JSON.stringify({ writes }) });
    if (res.status === 409 || (res.status === 400 && (await res.clone().text()).includes('FAILED_PRECONDITION'))) {
      return { shard: shard.name, error: 'page_already_applied — retry this call' };
    }
    if (!res.ok) return { shard: shard.name, error: 'commit_' + res.status };
  } catch (e) {
    if (e instanceof BudgetExceeded) return { shard: shard.name, deferred: true };
    return { shard: shard.name, error: String(e && e.message || e) };
  }

  return { shard: shard.name, done, processed, skipped };
}

/** One resumable pass over every admin-enabled shard. Mirrors
 *  runAdminCleanup's budget-slicing exactly, for the same reason: Cloudflare
 *  counts subrequests per INVOCATION across everything, so a shard that
 *  finishes early hands its unused slice to the next. */
export async function migrateFeedback(env, { totalBudget = 44, fetchImpl = fetch } = {}) {
  const reg = registryAdmin(env);
  if (!reg) return { status: 501, body: { error: 'registry_not_configured' } };

  const shards = discoverAdminShards(env);
  if (!shards.length) return { status: 501, body: { error: 'no_admin_shards_configured', detail: 'Feedback migration needs a service account per shard (FIREBASE_SA_JSON / FIREBASE_DBn_SA_JSON) to read the feedback collection past the security rules — the same credentials cleanup.js already needs.' } };

  const out = { shards: [] };
  let remaining = totalBudget;
  for (let i = 0; i < shards.length; i++) {
    const shard = shards[i];
    const slice = Math.max(0, Math.floor(remaining / (shards.length - i)));
    const budget = new Budget(slice);
    let r;
    if (slice < 3) r = { shard: shard.name, deferred: true };
    else r = await migrateShard(shard, reg, budget, fetchImpl);
    remaining -= (slice - budget.left);
    out.shards.push(r);
  }
  out.totalProcessed = out.shards.reduce((a, r) => a + (r.processed || 0), 0);
  out.totalSkipped = out.shards.reduce((a, r) => a + (r.skipped || 0), 0);
  out.allDone = out.shards.every(r => r.done || r.alreadyDone);
  return { status: 200, body: out };
}
