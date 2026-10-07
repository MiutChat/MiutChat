/**
 * MIUT — /functions/api/notify.js
 *
 * Fires real Web Push notifications (RFC 8291 aes128gcm encryption +
 * RFC 8292 VAPID) to every OTHER member of a room who has an active push
 * subscription, whenever a new message is sent. Called fire-and-forget by
 * the client right after a message write succeeds — see sendMessage() in
 * app.js. Carries NO message content (title/body only say "New message
 * from <name>"), so E2EE is untouched: the push payload itself is still
 * encrypted end-to-end to each subscriber by the Web Push protocol, but
 * what it SAYS is generic, never chat ciphertext or plaintext.
 *
 * Why this is hand-rolled WebCrypto instead of the `web-push` npm
 * package: build.js runs every functions/api/*.js file through esbuild
 * with --bundle=false (see CF_JOBS there) — no npm deps are ever bundled
 * into a Function, by design, so each one stays a single self-contained
 * file that can be hand-edited via GitHub's web UI from a phone. Every
 * primitive below (ECDH, HKDF via HMAC-SHA256, AES-128-GCM, ECDSA P-256)
 * comes from the Workers runtime's native crypto.subtle — nothing to
 * install. The encryption path was verified byte-for-byte against RFC
 * 8291 Appendix A's own worked example before being used here.
 *
 * ENV VARS REQUIRED (Cloudflare Pages dashboard → Settings → Environment
 * variables; VAPID_PRIVATE_KEY must be added as an encrypted "Secret"):
 *   VAPID_PUBLIC_KEY   — must match the VAPID const in sw-bridge.js
 *   VAPID_PRIVATE_KEY  — the matching private scalar (base64url). SECRET.
 *   FIREBASE_API_KEY / FIREBASE_PROJECT_ID           — shard "miut-db0"
 *   FIREBASE_DBn_API_KEY / FIREBASE_DBn_PROJECT_ID   — any extra shard
 *     (same vars cleanup.js and shard-registry.js already use)
 *
 * One VAPID keypair covers every shard — VAPID identifies this
 * application server to the browser's push service (FCM, Mozilla
 * autopush, etc.), it has nothing to do with which Firestore project a
 * room's data happens to live in.
 */

'use strict';

const CORS = { 'Access-Control-Allow-Origin': '*' };

// ── base64url helpers ───────────────────────────────────────────────────
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ── shard discovery — same pattern as cleanup.js ────────────────────────
function discoverShards(env) {
  const shards = [{
    name: 'miut-db0',
    apiKey: env.FIREBASE_API_KEY || '',
    projectId: env.FIREBASE_PROJECT_ID || '',
  }];
  const nums = new Set();
  for (const key of Object.keys(env)) {
    const m = /^FIREBASE_DB(\d+)_API_KEY$/.exec(key);
    if (m) nums.add(parseInt(m[1], 10));
  }
  for (const n of [...nums].sort((a, b) => a - b)) {
    shards.push({
      name: `miut-db${n}`,
      apiKey: env[`FIREBASE_DB${n}_API_KEY`] || '',
      projectId: env[`FIREBASE_DB${n}_PROJECT_ID`] || '',
    });
  }
  return shards;
}

async function getFirebaseToken(apiKey) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"returnSecureToken":true}' }
  );
  if (!res.ok) throw new Error('Firebase auth failed: ' + res.status);
  const data = await res.json();
  return data.idToken;
}

// List all member docs of a room via the Firestore REST API — rooms are
// small (a handful to low hundreds of members), so a plain list beats the
// complexity of a structured "field exists" query for this.
async function listMembers(projectId, token, roomCode) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/rooms/${encodeURIComponent(roomCode)}/members?pageSize=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.documents || [];
}

// Firestore REST documents use a typed-value wire format — unwrap the
// handful of types a member doc's pushSubscription field can contain.
function fsValueToJs(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('mapValue' in v) {
    const out = {};
    const fields = v.mapValue.fields || {};
    for (const k of Object.keys(fields)) out[k] = fsValueToJs(fields[k]);
    return out;
  }
  if ('nullValue' in v) return null;
  return v;
}

// ── VAPID (RFC 8292) ─────────────────────────────────────────────────────
async function importVapidPrivateKey(privateKeyB64url, publicKeyB64url) {
  const pub = b64urlToBytes(publicKeyB64url);
  const x = pub.slice(1, 33), y = pub.slice(33, 65);
  const jwk = { kty: 'EC', crv: 'P-256', d: privateKeyB64url, x: bytesToB64url(x), y: bytesToB64url(y), ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function buildVapidAuth(endpoint, privateKey, publicKeyB64url) {
  const origin = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = { aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:admin@miutchat.pages.dev' };
  const seg = o => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = seg(header) + '.' + seg(claims);
  // Web Crypto's ECDSA sign() output is already the raw r||s (IEEE P1363)
  // format JWT's ES256 wants — no DER conversion needed.
  const sigBuf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(signingInput));
  const jwt = signingInput + '.' + bytesToB64url(new Uint8Array(sigBuf));
  return `vapid t=${jwt}, k=${publicKeyB64url}`;
}

// ── Web Push payload encryption (RFC 8291, aes128gcm) ───────────────────
async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}
async function hkdfExpand(prk, info, length) {
  // Single-block HKDF-Expand (fine since we only ever need <=32 bytes):
  // T(1) = HMAC(PRK, info || 0x01)
  const full = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
  return full.slice(0, length);
}

async function encryptPayload(receiverPubB64url, authSecretB64url, plaintextBytes) {
  const receiverPubRaw = b64urlToBytes(receiverPubB64url);
  const authSecret = b64urlToBytes(authSecretB64url);

  const uaPub = await crypto.subtle.importKey('raw', receiverPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const senderPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPub }, asKeyPair.privateKey, 256));

  const keyInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), receiverPubRaw, senderPubRaw);
  const prkCombine = await hmacSha256(authSecret, ecdhSecret);       // HKDF-Extract(salt=auth_secret, ikm=ecdh_secret)
  const ikm = await hkdfExpand(prkCombine, keyInfo, 32);             // HKDF-Expand -> "ikm" for the next extract

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);                          // HKDF-Extract(salt=salt, ikm=ikm)
  const cek = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const padded = concatBytes(plaintextBytes, new Uint8Array([2])); // delimiter octet — single/last record
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096); // record size — payload here is always far smaller
  const header = concatBytes(salt, rs, new Uint8Array([senderPubRaw.length]), senderPubRaw);
  return concatBytes(header, ciphertext);
}

async function sendWebPush(subscription, vapidPrivateKey, vapidPublicKeyB64url, payloadObj) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return { ok: false, reason: 'bad-subscription' };

  const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));
  const body = await encryptPayload(keys.p256dh, keys.auth, plaintext);
  const auth = await buildVapidAuth(endpoint, vapidPrivateKey, vapidPublicKeyB64url);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':               '86400',
      'Authorization':      auth,
    },
    body,
  });
  // 404/410 means the subscription is dead (revoked, app uninstalled,
  // etc.) — surfaced in the response so a future cleanup pass could prune
  // pushSubscription off that member's doc; not pruned here to keep this
  // endpoint's one job (send) separate from housekeeping.
  return { ok: res.ok, status: res.status };
}

async function runNotify(env, { roomCode, shard, senderId, senderName }) {
  const shards = discoverShards(env);
  const s = shards.find(x => x.name === shard) || shards[0];
  if (!s?.apiKey || !s?.projectId) return { error: 'Unknown or unconfigured shard' };
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return { error: 'VAPID keys not configured' };

  const token = await getFirebaseToken(s.apiKey);
  const docs = await listMembers(s.projectId, token, roomCode);
  const privateKey = await importVapidPrivateKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);

  const targets = [];
  for (const d of docs) {
    const uid = (d.name || '').split('/').pop();
    if (uid === senderId) continue; // never notify the sender of their own message
    const fields = {};
    for (const k of Object.keys(d.fields || {})) fields[k] = fsValueToJs(d.fields[k]);
    if (fields.pushSubscription?.endpoint) targets.push({ uid, sub: fields.pushSubscription });
  }

  const payload = { title: 'MIUT', body: `New message from ${senderName || 'someone'}`, roomCode, type: 'message' };
  const results = await Promise.all(targets.map(t =>
    sendWebPush(t.sub, privateKey, env.VAPID_PUBLIC_KEY, payload)
      .then(r => ({ uid: t.uid, ...r }))
      .catch(e => ({ uid: t.uid, ok: false, reason: e.message }))
  ));

  return { sent: results.filter(r => r.ok).length, total: targets.length, results };
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const roomCode   = String(body.roomCode   || '').slice(0, 64);
  const shard      = String(body.shard      || 'miut-db0').slice(0, 32);
  const senderId   = String(body.senderId   || '').slice(0, 128);
  const senderName = String(body.senderName || '').slice(0, 64);

  if (!roomCode || !senderId) {
    return new Response(JSON.stringify({ error: 'roomCode and senderId required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  try {
    const result = await runNotify(env, { roomCode, shard, senderId, senderName });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
  }
}
