/**
 * MIUT — /functions/api/notify.js
 *
 * Fires real Web Push notifications (RFC 8291 aes128gcm encryption +
 * RFC 8292 VAPID) to every OTHER approved member of a room who has an active
 * push subscription, whenever a new message is sent. Also handles
 * type 'join-request' (admins only), 'member-joined' (everyone else) and
 * 'sync' (recompute rooms/{code}.pushUids, the list of subscribed members the
 * client checks so it never calls this endpoint when nobody could receive). Called fire-and-forget by
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
 * variables; VAPID_PRIVATE_KEY and every *_SA_JSON below must be added as
 * an encrypted "Secret", not a plain variable):
 *   VAPID_PUBLIC_KEY   — must match the VAPID const in sw-bridge.js
 *   VAPID_PRIVATE_KEY  — the matching private scalar (base64url). SECRET.
 *   FIREBASE_API_KEY / FIREBASE_PROJECT_ID           — shard "miut-db0"
 *   FIREBASE_DBn_API_KEY / FIREBASE_DBn_PROJECT_ID   — any extra shard
 *     (same vars cleanup.js and shard-registry.js already use)
 *   FIREBASE_SA_JSON / FIREBASE_DBn_SA_JSON — SECRET. The full JSON key
 *     file for a Google Cloud SERVICE ACCOUNT in that shard's Firebase
 *     project, pasted verbatim as the variable's value, one per shard:
 *       1. Firebase Console → that project → ⚙ Project settings →
 *          Service accounts → Generate new private key. Downloads a
 *          .json file.
 *       2. That default service account already has Firestore access
 *          (it's the same identity the Admin SDK uses) — no extra IAM
 *          role to add.
 *       3. Open the downloaded .json file, copy its ENTIRE contents, and
 *          paste that as the value of FIREBASE_SA_JSON (shard miut-db0)
 *          or FIREBASE_DB1_SA_JSON / FIREBASE_DB2_SA_JSON / etc. for
 *          every other shard — one key per Firebase project, since each
 *          is a separate project with its own service account.
 *     Without this, every call fails closed with a clear
 *     "No service account configured for shard ..." error instead of
 *     the old silent `sent 0, total 0` — see runNotify() below for why
 *     a regular end-user auth token can never work here regardless of
 *     how it's obtained.
 *
 * One VAPID keypair covers every shard — VAPID identifies this
 * application server to the browser's push service (FCM, Mozilla
 * autopush, etc.), it has nothing to do with which Firestore project a
 * room's data happens to live in.
 */

'use strict';

import { ledgerAdd } from '../_lib/usage-ledger.js';
import { getAccessTokenCached } from '../_lib/firebase-admin.js';

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
// Each shard now ALSO carries an optional `saJson` — a Google Cloud
// service-account key JSON (exchanged for a token via getAccessTokenCached in firebase-admin.js). This is a
// different, additive credential from apiKey/projectId: apiKey is still
// used by config.js for the public client config, but this file no
// longer authenticates with it (see why below).
function discoverShards(env) {
  const shards = [{
    name: 'miut-db0',
    apiKey: env.FIREBASE_API_KEY || '',
    projectId: env.FIREBASE_PROJECT_ID || '',
    saJson: env.FIREBASE_SA_JSON || '',
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
      saJson: env[`FIREBASE_DB${n}_SA_JSON`] || '',
    });
  }
  return shards;
}

const DOCS = projectId => `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
const MEMBER_PAGE = 200;

async function listMembers(projectId, token, roomCode, shardName) {
  const url = `${DOCS(projectId)}/rooms/${encodeURIComponent(roomCode)}/members?pageSize=${MEMBER_PAGE}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const data = await res.json();
  const docs = data.documents || [];
  ledgerAdd(shardName, 'notify', Math.max(1, docs.length));
  return { docs, complete: !data.nextPageToken };
}

async function patchDoc(projectId, token, shardName, path, mask, fields, mustExist) {
  const q = mask.map(m => 'updateMask.fieldPaths=' + encodeURIComponent(m)).join('&') + (mustExist ? '&currentDocument.exists=true' : '');
  const res = await fetch(`${DOCS(projectId)}/${path}?${q}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (res.ok) ledgerAdd(shardName, 'notify', 0, 1);
  return res.ok;
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
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsValueToJs);
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

const EVENT_TYPES = new Set(['message', 'join-request', 'member-joined', 'sync']);
const SYNC_COOLDOWN_MS = 5000;
const lastSync = new Map();

function readMember(d) {
  const fields = {};
  for (const k of Object.keys(d.fields || {})) fields[k] = fsValueToJs(d.fields[k]);
  const uid = (d.name || '').split('/').pop();
  const eligible = fields.approved !== false && !fields.blocked && !fields.declined;
  const sub = fields.pushSubscription && fields.pushSubscription.endpoint ? fields.pushSubscription : null;
  return { uid, eligible, admin: fields.role === 'admin', sub };
}

function payloadFor(type, roomCode, senderName) {
  const who = senderName || 'someone';
  if (type === 'join-request') return { title: 'MIUT', body: `${who} wants to join the room`, roomCode, senderName: senderName || '', type };
  if (type === 'member-joined') return { title: 'MIUT', body: `${who} joined the room`, roomCode, senderName: senderName || '', type };
  return { title: 'MIUT', body: `New message from ${who}`, roomCode, senderName: senderName || '', type: 'message' };
}

function targetsFor(type, members, senderId) {
  return members.filter(m => m.sub && m.eligible && m.uid !== senderId && (type !== 'join-request' || m.admin));
}

async function runNotify(env, { roomCode, shard, type, senderId, senderName, indexCount }) {
  const shards = discoverShards(env);
  const s = shards.find(x => x.name === shard) || shards[0];
  if (!s?.projectId) return { error: 'Unknown or unconfigured shard' };
  if (!s.saJson) return { error: `No service account configured for shard ${s.name}` };
  if (type !== 'sync' && (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY)) return { error: 'VAPID keys not configured' };

  if (type === 'sync') {
    const key = `${s.name}|${roomCode}|${senderId}`;
    const now = Date.now();
    if (now - (lastSync.get(key) || 0) < SYNC_COOLDOWN_MS) return { skipped: 'cooldown' };
    if (lastSync.size > 500) lastSync.clear();
    lastSync.set(key, now);
  }

  const token = await getAccessTokenCached(JSON.parse(s.saJson), fetch);
  const listed = await listMembers(s.projectId, token, roomCode, s.name);
  if (!listed) return { error: 'Could not list members' };
  const members = listed.docs.map(readMember);

  const targets = type === 'sync' ? [] : targetsFor(type, members, senderId);
  const dead = new Set();
  let results = [];
  if (targets.length) {
    const privateKey = await importVapidPrivateKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
    const payload = payloadFor(type, roomCode, senderName);
    results = await Promise.all(targets.map(t =>
      sendWebPush(t.sub, privateKey, env.VAPID_PUBLIC_KEY, payload)
        .then(r => ({ uid: t.uid, ...r }))
        .catch(e => ({ uid: t.uid, ok: false, reason: e.message }))
    ));
    for (const r of results) if (r.status === 404 || r.status === 410) dead.add(r.uid);
  }

  for (const uid of dead) {
    await patchDoc(s.projectId, token, s.name, `rooms/${encodeURIComponent(roomCode)}/members/${encodeURIComponent(uid)}`, ['pushSubscription'], { pushSubscription: { nullValue: null } }, true);
  }

  const uids = members.filter(m => m.sub && m.eligible && !dead.has(m.uid)).map(m => m.uid).sort();
  const stale = indexCount !== undefined && (indexCount === null || indexCount !== uids.length);
  let indexed = false;
  if ((type === 'sync' || dead.size || stale) && listed.complete) {
    indexed = await patchDoc(s.projectId, token, s.name, `rooms/${encodeURIComponent(roomCode)}`, ['pushUids'],
      { pushUids: { arrayValue: { values: uids.map(u => ({ stringValue: u })) } } }, true);
  }

  return { type, sent: results.filter(r => r.ok).length, total: targets.length, pruned: dead.size, indexed };
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return reply({ error: 'POST required' }, 405);

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const roomCode   = String(body.roomCode   || '').slice(0, 64);
  const shard      = String(body.shard      || 'miut-db0').slice(0, 32);
  const senderId   = String(body.senderId   || '').slice(0, 128);
  const senderName = String(body.senderName || '').slice(0, 64);
  const type       = EVENT_TYPES.has(body.type) ? body.type : 'message';

  if (!roomCode || !senderId) return reply({ error: 'roomCode and senderId required' }, 400);

  try {
    return reply(await runNotify(env, { roomCode, shard, type, senderId, senderName, indexCount: 'indexCount' in body ? (Number.isInteger(body.indexCount) && body.indexCount >= 0 ? body.indexCount : null) : undefined }));
  } catch (e) {
    return reply({ error: e.message }, 500);
  }
}
