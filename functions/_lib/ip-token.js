'use strict';

const enc = new TextEncoder();
const SALT_TTL_SEC = 36 * 3600;
const DAY_MS = 86400000;
// memo is keyed per (period bucket, periodDays) pair so the default daily
// token and a longer-lived token (see ipToken's `periodDays` below) don't
// stomp each other's cached HMAC key when both are requested in the same
// isolate.
let memo = { k: '', key: null };

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function dayStamp(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

// A bucket id that only changes every `periodDays` days (UTC calendar days
// since the epoch, divided into fixed-size buckets) — used instead of
// dayStamp() wherever the resulting token has to stay valid for longer than
// one day. periodDays=1 reduces to one bucket per calendar day, same as
// dayStamp() but as an integer rather than a date string.
function periodStamp(periodDays, ms = Date.now()) {
  const bucket = Math.floor(ms / (DAY_MS * periodDays));
  return `p${periodDays}:${bucket}`;
}

function expandV6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  if (t === null) return h;
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
}

export function normalizeIp(ip) {
  const raw = String(ip || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw.includes(':') && !/^\d+\.\d+\.\d+\.\d+$/.test(raw)) {
    const v4mapped = raw.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped) return v4mapped[1];
    return expandV6(raw).slice(0, 4).map(g => g.padStart(4, '0')).join(':') + '::/64';
  }
  return raw;
}

async function dailyKey(env, bucketId, saltTtlSec) {
  if (memo.k === bucketId && memo.key) return memo.key;
  let material;
  const kv = env && env.MIUT_RL;
  if (kv) {
    try {
      const saltKey = 'salt:' + bucketId;
      let salt = await kv.get(saltKey);
      if (!salt) {
        const rnd = new Uint8Array(32);
        crypto.getRandomValues(rnd);
        salt = b64url(rnd);
        await kv.put(saltKey, salt, { expirationTtl: saltTtlSec });
        const again = await kv.get(saltKey);
        if (again) salt = again;
      }
      material = salt;
    } catch {}
  }
  if (!material) material = (env && env.MIUT_IP_SALT ? env.MIUT_IP_SALT : 'miut-dev-salt') + '|' + bucketId;
  const key = await crypto.subtle.importKey('raw', enc.encode(material), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  memo = { k: bucketId, key };
  return key;
}

/**
 * A pseudonymous, non-reversible per-IP token: a daily-rotating keyed HMAC of
 * the caller's IP, never the raw IP itself. Safe as-is for anything scoped to
 * "within the current day" — short rate-limit windows, per-day analytics
 * bucketing — because a new, unlinkable token is intentionally produced every
 * day for privacy.
 *
 * NOT safe as a key into anything that must keep recognizing the same caller
 * for LONGER than a day: a KV-persisted ban, an abuse cooldown, or a
 * duplicate-reporter check with a multi-day TTL. The entry's lookup key
 * silently changes value when the UTC calendar day rolls over mid-TTL, which
 * either lets a ban lapse early or lets the same caller count as a "new"
 * distinct reporter on the next day. Pass `periodDays` (an integer > 1) for
 * those cases: it keeps the same unlinkable-pseudonym property, just
 * rotating on a longer, TTL-appropriate cycle instead of every calendar day.
 * Only use a longer period for persistent anti-abuse bookkeeping (bans,
 * cooldowns, report dedup) — leave it at the default everywhere the daily
 * rotation is the intended privacy property, not a bug to work around.
 */
export async function ipToken(request, env, periodDays = 1) {
  const ip = normalizeIp(
    request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0] || ''
  );
  if (ip === 'unknown') return 'unknown';
  const bucketId = periodDays > 1 ? periodStamp(periodDays) : dayStamp();
  const saltTtlSec = periodDays > 1 ? periodDays * 86400 + SALT_TTL_SEC : SALT_TTL_SEC;
  const key = await dailyKey(env, bucketId, saltTtlSec);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(ip));
  return b64url(new Uint8Array(mac).slice(0, 12));
}
