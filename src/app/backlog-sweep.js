'use strict';
// @ts-check
/**
 * Pure loop for sweeping an entire (possibly paginated) backlog of expired
 * message docs, independent of Firestore/DOM. Split out from app.js so it
 * can be unit tested directly in Node (see test/backlog-sweep.test.js) —
 * the surrounding app.js is a browser bundle with window/DOM side effects
 * at module scope and can't be imported in a plain Node test.
 *
 * Why this exists: app.js's other expiry paths (_runExpirySweep,
 * fetchHistoryOnce, loadEarlierMessages) only ever see messages that have
 * actually been loaded into the client — by default just the newest
 * _HISTORY_PAGE messages, or however far someone has paged back with
 * "Load earlier". A message past its TTL that sits further back than that
 * is invisible to all of them: never queried, so never deleted, no matter
 * how long an active client sits in the room with the periodic sweep
 * ticking. runBacklogSweepLoop instead re-queries directly for "anything
 * still matching the expired cutoff" on each page, independent of what's
 * paginated into the DOM, until a short page says nothing's left.
 *
 * @param {() => Promise<any[]>} fetchPage - returns up to `pageSize` items
 *   still matching the expiry cutoff (callers re-run the same query each
 *   time, so items deleted by the previous page naturally drop out).
 * @param {(items: any[]) => Promise<void>} deletePage - deletes exactly the
 *   items it's given.
 * @param {number} pageSize - the limit() used by fetchPage; a page shorter
 *   than this means the query is exhausted.
 * @param {number} [maxPages] - safety valve against an unbounded loop.
 * @returns {Promise<{pages: number, exhausted: boolean}>}
 */
export async function runBacklogSweepLoop(fetchPage, deletePage, pageSize, maxPages = 40) {
  if (!pageSize || pageSize <= 0) throw new Error('pageSize must be > 0');
  let pages = 0;
  for (; pages < maxPages; pages++) {
    const items = await fetchPage();
    if (!items || !items.length) return { pages, exhausted: true };
    await deletePage(items);
    if (items.length < pageSize) return { pages: pages + 1, exhausted: true };
  }
  return { pages, exhausted: false };
}
