/**
 * functions/_lib/firebase-admin.js
 *
 * Server-side Firestore access that is NOT subject to the security rules,
 * using a Firebase *service account* (free on the Spark plan — no billing
 * needed). The existing anonymous-auth REST path in cleanup.js is bound by
 * the rules (`rooms` has `allow list: if false`, room delete is creator/admin
 * only), so it cannot find or delete expired rooms; this can.
 *
 * ENV — the SAME secrets notify.js already uses, so nothing new to configure
 * (all optional; when absent, callers fall back to the legacy behaviour):
 *   FIREBASE_SA_JSON            full service-account JSON key for shard db0
 *   FIREBASE_DBn_SA_JSON        same, for additional shard n (db1, db2…)
 * (FIREBASE_SERVICE_ACCOUNT / FIREBASE_DBn_SERVICE_ACCOUNT are accepted as aliases.)
 *
 * Cloudflare's free plan allows ~50 subrequests per invocation, so every
 * network call is counted against a Budget. When it runs out the work stops
 * cleanly and the caller reports `more: true` so it can be resumed (the
 * GitHub Actions cron does this automatically). All operations are
 * idempotent: deleting an already-deleted doc is not an error.
 */

'use strict';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE     = 'https://www.googleapis.com/auth/datastore';
const PAGE      = 300;   // docs per query/batch (Firestore batchWrite max is 500)

export class BudgetExceeded extends Error {
  constructor() { super('subrequest budget exhausted'); this.name = 'BudgetExceeded'; }
}

export class Budget {
  constructor(n) { this.left = n; }
  take() { if (this.left <= 0) throw new BudgetExceeded(); this.left--; }
}

/** Find every shard that has a service account configured. */
export function discoverAdminShards(env) {
  const shards = [];
  const add = (name, raw) => {
    if (!raw) return;
    try {
      const sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (sa && sa.client_email && sa.private_key && sa.project_id) {
        shards.push({ name, sa, projectId: sa.project_id });
      }
    } catch { /* malformed secret — ignore this shard */ }
  };
  add('miut-db0', env.FIREBASE_SA_JSON || env.FIREBASE_SERVICE_ACCOUNT);
  const nums = new Set();
  for (const k of Object.keys(env || {})) {
    const m = /^FIREBASE_DB(\d+)_(?:SA_JSON|SERVICE_ACCOUNT)$/.exec(k);
    if (m) nums.add(parseInt(m[1], 10));
  }
  for (const n of [...nums].sort((a, b) => a - b)) add(`miut-db${n}`, env[`FIREBASE_DB${n}_SA_JSON`] || env[`FIREBASE_DB${n}_SERVICE_ACCOUNT`]);
  return shards;
}

// ── Service-account OAuth (RS256 JWT → access token) ────────────────────────
const te = new TextEncoder();

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function getAccessToken(sa, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(te.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(te.encode(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  })));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, te.encode(`${header}.${claims}`));
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error('service-account token request failed: ' + res.status);
  return (await res.json()).access_token;
}

// ── Firestore REST client ───────────────────────────────────────────────────
export function makeClient(shard, budget, fetchImpl = fetch) {
  const root = `projects/${shard.projectId}/databases/(default)/documents`;
  const base = `https://firestore.googleapis.com/v1/${root}`;
  let token = null;

  async function call(url, init = {}) {
    if (!token) { budget.take(); token = await getAccessToken(shard.sa, fetchImpl); }
    budget.take();
    return fetchImpl(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  return {
    /** GET rooms/{code} → decoded fields or null if it doesn't exist. */
    async getRoom(code) {
      const res = await call(`${base}/rooms/${encodeURIComponent(code)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('getRoom ' + res.status);
      return (await res.json()).fields || {};
    },

    /** runQuery on the root, or on a document's subcollection when `parent` is given. */
    async runQuery(parent, structuredQuery) {
      const url = `${base}${parent ? '/' + parent : ''}:runQuery`;
      const res = await call(url, { method: 'POST', body: JSON.stringify({ structuredQuery }) });
      if (!res.ok) throw new Error('runQuery ' + res.status);
      return (await res.json()).filter(r => r.document);
    },

    /** Delete up to 500 documents (full resource names) in one request. */
    async batchDelete(names) {
      for (let i = 0; i < names.length; i += 500) {
        const res = await call(`${base}:batchWrite`, {
          method: 'POST',
          body: JSON.stringify({ writes: names.slice(i, i + 500).map(n => ({ delete: n })) }),
        });
        if (!res.ok) throw new Error('batchWrite ' + res.status);
      }
    },

    async deleteDoc(path) {
      const res = await call(`${base}/${path}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error('deleteDoc ' + res.status);
    },
  };
}

// ── Field decoding ──────────────────────────────────────────────────────────
export function fieldMillis(f) {
  if (!f) return 0;
  if (f.timestampValue) { const t = Date.parse(f.timestampValue); return Number.isFinite(t) ? t : 0; }
  if (f.integerValue !== undefined) return Number(f.integerValue) || 0;
  if (f.doubleValue  !== undefined) return Number(f.doubleValue)  || 0;
  return 0;
}

/** Room code from a full resource name (codes never contain '%', so decoding is safe). */
export function roomIdFromName(name) {
  const raw = String(name).split('/documents/rooms/')[1] || '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Fully delete a room: subcollections first, room document last. If the
 * budget runs out part-way, BudgetExceeded propagates and the room document
 * is still there (still expired), so the next run simply continues.
 * Returns true once the room document itself is gone.
 */
export async function wipeRoom(client, code) {
  const parent = `rooms/${encodeURIComponent(code)}`;
  for (const sub of ['messages', 'typing', 'members']) {
    for (;;) {
      const rows = await client.runQuery(parent, {
        from: [{ collectionId: sub }],
        select: { fields: [{ fieldPath: '__name__' }] },
        limit: PAGE,
      });
      if (!rows.length) break;
      await client.batchDelete(rows.map(r => r.document.name));
      if (rows.length < PAGE) break;
    }
  }
  await client.deleteDoc(parent);
  return true;
}

/** Wipe rooms whose autoDeleteAt has passed. Processed rooms vanish, so no cursor is needed. */
export async function wipeExpiredRooms(client, budget) {
  let wiped = 0, more = false;
  try {
    const rows = await client.runQuery('', {
      from: [{ collectionId: 'rooms' }],
      where: { fieldFilter: { field: { fieldPath: 'autoDeleteAt' }, op: 'LESS_THAN_OR_EQUAL',
                              value: { timestampValue: new Date().toISOString() } } },
      select: { fields: [{ fieldPath: '__name__' }] },
      limit: 25,
    });
    more = rows.length === 25;
    for (const r of rows) {
      const code = roomIdFromName(r.document.name);
      await wipeRoom(client, code);
      wiped++;
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    more = true;
  }
  return { wiped, more };
}

/**
 * Delete messages older than each room's msgTtlMs, for rooms that have one.
 * `cursor` is an offset into the (stable-ordered) list of TTL rooms so that a
 * budget-limited run resumes where it stopped instead of starving later rooms.
 */
export async function sweepExpiredMessages(client, budget, cursor = 0) {
  const ROOMS_PER_PAGE = 20;
  let processed = 0, deleted = 0, more = false;
  try {
    const rooms = await client.runQuery('', {
      from: [{ collectionId: 'rooms' }],
      where: { fieldFilter: { field: { fieldPath: 'msgTtlMs' }, op: 'GREATER_THAN', value: { integerValue: '0' } } },
      orderBy: [{ field: { fieldPath: 'msgTtlMs' }, direction: 'ASCENDING' },
                { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      select: { fields: [{ fieldPath: 'msgTtlMs' }] },
      offset: cursor,
      limit: ROOMS_PER_PAGE,
    });
    for (const r of rooms) {
      const ttl = fieldMillis(r.document.fields && r.document.fields.msgTtlMs);
      if (ttl > 0) {
        const code = roomIdFromName(r.document.name);
        const cutoff = new Date(Date.now() - ttl).toISOString();
        for (;;) {
          const msgs = await client.runQuery(`rooms/${encodeURIComponent(code)}`, {
            from: [{ collectionId: 'messages' }],
            where: { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: cutoff } } },
            select: { fields: [{ fieldPath: '__name__' }] },
            limit: PAGE,
          });
          if (!msgs.length) break;
          await client.batchDelete(msgs.map(m => m.document.name));
          deleted += msgs.length;
          if (msgs.length < PAGE) break;
        }
      }
      processed++;
    }
    more = rooms.length === ROOMS_PER_PAGE;
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    more = true;
  }
  return { processed, deleted, more, nextCursor: more ? cursor + processed : 0 };
}

/** One resumable pass over all admin-enabled shards. */
export async function runAdminCleanup(shards, { cursors = {}, budgetPerShard = 40, fetchImpl = fetch } = {}) {
  const out = { shards: [], cursors: {}, more: false };
  for (const shard of shards) {
    const budget = new Budget(budgetPerShard);
    const client = makeClient(shard, budget, fetchImpl);
    const r = { shard: shard.name };
    try {
      const rooms = await wipeExpiredRooms(client, budget);
      r.roomsWiped = rooms.wiped;
      const msgs = await sweepExpiredMessages(client, budget, Number(cursors[shard.name]) || 0);
      r.messagesDeleted = msgs.deleted;
      out.cursors[shard.name] = msgs.nextCursor;
      if (rooms.more || msgs.more) out.more = true;
    } catch (e) {
      r.error = String(e && e.message || e);
    }
    out.shards.push(r);
  }
  return out;
}
