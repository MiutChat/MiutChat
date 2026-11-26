'use strict';

const enc = new TextEncoder();
const SALT_TTL_SEC = 36 * 3600;
let memo = { day: '', key: null };

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function dayStamp(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function expandV6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  if (t === null) return h;
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
}

export function kvOf(env) {
  return (env && (env.MIUT_RL || env.MIUT_KV)) || null;
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

async function dailyKey(env, day) {
  if (memo.day === day && memo.key) return memo.key;
  let material;
  const kv = kvOf(env);
  if (kv) {
    try {
      let salt = await kv.get('salt:' + day);
      if (!salt) {
        const rnd = new Uint8Array(32);
        crypto.getRandomValues(rnd);
        salt = b64url(rnd);
        await kv.put('salt:' + day, salt, { expirationTtl: SALT_TTL_SEC });
        const again = await kv.get('salt:' + day);
        if (again) salt = again;
      }
      material = salt;
    } catch {}
  }
  if (!material) material = (env && env.MIUT_IP_SALT ? env.MIUT_IP_SALT : 'miut-dev-salt') + '|' + day;
  const key = await crypto.subtle.importKey('raw', enc.encode(material), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  memo = { day, key };
  return key;
}

export async function ipToken(request, env) {
  const ip = normalizeIp(
    request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0] || ''
  );
  if (ip === 'unknown') return 'unknown';
  const key = await dailyKey(env, dayStamp());
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(ip));
  return b64url(new Uint8Array(mac).slice(0, 12));
}
