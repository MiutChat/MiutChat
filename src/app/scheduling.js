'use strict';
/**
 * Pure helper for running periodic housekeeping (the TTL sweep, the
 * presence heartbeat) off the user-blocking path, independent of any
 * global `scheduler`/`window` — split out so it can be unit tested
 * directly in Node. See backlog-sweep.js's top comment for why app.js
 * can't import this directly (--bundle=false, zero top-level imports):
 * this is a deliberate duplicate of runBackground below, mirrored by
 * hand into app.js's own copy. If you change the logic here, mirror the
 * change there too.
 *
 * Runs `fn` via the Scheduler API's 'background' priority when available
 * (scheduler.postTask), so it queues behind any pending user-blocking or
 * user-visible task — typing, clicks, incoming-message render — instead
 * of competing with them for the next turn of the main thread. Falls
 * back to a plain macrotask (setTimeout) where the API doesn't exist.
 *
 * `schedulerObj`/`timeoutFn` are injected (not read from globals) so
 * this stays unit-testable without a real browser scheduler — same
 * reasoning as media-swap.js and screen-transition.js.
 *
 * @param {() => void} fn
 * @param {{postTask?: (fn: Function, opts: {priority: string}) => Promise<any>}} [schedulerObj]
 * @param {(fn: Function, ms: number) => any} [timeoutFn]
 */
export function runBackground(fn, schedulerObj, timeoutFn) {
  if (schedulerObj?.postTask) {
    const result = schedulerObj.postTask(fn, { priority: 'background' });
    if (result?.catch) result.catch(() => {});
    return result;
  }
  return timeoutFn(fn, 0);
}
