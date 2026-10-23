'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   Web Crypto API only · No external libraries · Browser-ready
   ═══════════════════════════════════════════════════════════════════════════ */
window.MiutProtocol = (function () {

  const subtle  = crypto.subtle;
  const ENC     = new TextEncoder(), DEC = new TextDecoder();
  const ECDH    = { name:'ECDH',  namedCurve:'P-256' };
  const ECDSA   = { name:'ECDSA', namedCurve:'P-256' };
  const SIGN    = { name:'ECDSA', hash:'SHA-256' };
  const AES_GCM = { name:'AES-GCM', length:256 };

  /* ── Utility ─────────────────────────────────────────────────────────────── */
  const rnd   = n   => crypto.getRandomValues(new Uint8Array(n));
  const u8    = buf => buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const cat   = (...a) => { const o = new Uint8Array(a.reduce((s,x)=>s+x.length,0)); let off=0; for(const x of a){o.set(x,off);off+=x.length;} return o; };

  async function digest(d)         { return u8(await subtle.digest('SHA-256', d)); }
  async function rawKey(kp)        { return u8(await subtle.exportKey('raw', kp.publicKey)); }
  async function exportPriv(k)     { return u8(await subtle.exportKey('pkcs8', k)); }
  async function importPrivECDH(r) { return subtle.importKey('pkcs8', r, ECDH, true, ['deriveBits']); }
  async function importPrivSign(r) { return subtle.importKey('pkcs8', {name:'ECDSA',namedCurve:'P-256'}, r, false, ['sign']); }
  async function importPubRaw(r)   { return subtle.importKey('raw', r, ECDH, false, []); }

  async function ecdh(priv, pubRaw) {
    const pub = await importPubRaw(pubRaw);
    return u8(await subtle.deriveBits({ name:'ECDH', public:pub }, priv, 256));
  }

  async function hkdf(ikm, salt, info, len) {
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return u8(await subtle.deriveBits(
      { name:'HKDF', hash:'SHA-256', salt: salt||new Uint8Array(32), info: ENC.encode(info) },
      base, len*8
    ));
  }

  async function aesEncrypt(key, pt, iv, aad) {
    return u8(await subtle.encrypt({ name:'AES-GCM', iv, additionalData:aad }, key, pt));
  }
  async function aesDecrypt(key, ct, iv, aad) {
    return u8(await subtle.decrypt({ name:'AES-GCM', iv, additionalData:aad }, key, ct));
  }
  async function importAES(raw, usage) {
    return subtle.importKey('raw', raw, AES_GCM, false, [usage]);
  }

  /* ── IndexedDB ───────────────────────────────────────────────────────────── */
  let _idb = null;
  async function openIdb() {
    if (_idb) return _idb;
    return new Promise((res,rej) => {
      const r = indexedDB.open('miut-mp-v1', 1);
      r.onupgradeneeded = () => { const d=r.result; if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); };
      r.onsuccess = () => { _idb=r.result; res(_idb); };
      r.onerror   = () => rej(r.error);
    });
  }
  async function idbGet(k) {
    const d=await openIdb(); return new Promise((res,rej)=>{ const t=d.transaction('kv','readonly'),q=t.objectStore('kv').get(k); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); });
  }
  async function idbPut(k,v) {
    const d=await openIdb(); return new Promise((res,rej)=>{ const t=d.transaction('kv','readwrite'),q=t.objectStore('kv').put(v,k); q.onsuccess=res; q.onerror=rej; });
  }

  /* ── State ───────────────────────────────────────────────────────────────── */
  let _id       = null;   // { ikPriv, ikPub, sigPriv, sigPub }
  const _sess   = new Map();  // peerId → session
  const _nonces = new Set();  // replay protection

  /* ══════════════════════════════════════════════════════════════════════════
     1. IDENTITY
     ══════════════════════════════════════════════════════════════════════════ */
  async function initIdentity() {
    const stored = await idbGet('identity');
    if (stored) {
      _id = {
        ikPriv:   await importPrivECDH(stored.ikPriv),
        ikPub:    stored.ikPub,
        sigPriv:  await importPrivSign(stored.sigPriv),
        sigPub:   stored.sigPub,
      };
      return { ikPub: _id.ikPub, sigPub: _id.sigPub };
    }
    const [ikKp, sigKp] = await Promise.all([
      subtle.generateKey(ECDH, true, ['deriveBits']),
      subtle.generateKey({...ECDSA,namedCurve:'P-256'}, true, ['sign','verify']),
    ]);
    const [ikPrivRaw, ikPubRaw, sigPrivRaw, sigPubRaw] = await Promise.all([
      exportPriv(ikKp.privateKey), rawKey(ikKp),
      exportPriv(sigKp.privateKey), rawKey(sigKp),
    ]);
    await idbPut('identity', { ikPriv:ikPrivRaw, ikPub:ikPubRaw, sigPriv:sigPrivRaw, sigPub:sigPubRaw });
    _id = { ikPriv:ikKp.privateKey, ikPub:ikPubRaw, sigPriv:sigKp.privateKey, sigPub:sigPubRaw };
    return { ikPub:ikPubRaw, sigPub:sigPubRaw };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     2. PRE-KEY BUNDLE
     ══════════════════════════════════════════════════════════════════════════ */
  async function generatePreKeyBundle() {
    if (!_id) throw new Error('Call initIdentity() first');
    const spkKp = await subtle.generateKey(ECDH, true, ['deriveBits']);
    const [spkPrivRaw, spkPubRaw] = await Promise.all([exportPriv(spkKp.privateKey), rawKey(spkKp)]);
    const sig = u8(await subtle.sign(SIGN, _id.sigPriv, spkPubRaw));
    const opks = [], opkPrivs = [];
    for (let i=0; i<8; i++) {
      const kp = await subtle.generateKey(ECDH, true, ['deriveBits']);
      const [priv,pub] = await Promise.all([exportPriv(kp.privateKey), rawKey(kp)]);
      opks.push(pub); opkPrivs.push({id:i, priv, pub});
    }
    await Promise.all([
      idbPut('spk', { pub:spkPubRaw, priv:spkPrivRaw }),
      idbPut('opks', opkPrivs),
    ]);
    return { identityPub:_id.ikPub, sigPub:_id.sigPub, signedPreKeyPub:spkPubRaw, signature:sig, oneTimePreKeys:opks };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     3. X3DH HANDSHAKE — INITIATOR
     ══════════════════════════════════════════════════════════════════════════ */
  async function initiateSession(peerId, bundle) {
    if (!_id) throw new Error('Call initIdentity() first');
    const { identityPub, sigPub, signedPreKeyPub, signature, oneTimePreKeys } = bundle;
    // Verify SPK signature
    const sigPubKey = await subtle.importKey('raw', sigPub, {name:'ECDSA',namedCurve:'P-256'}, false, ['verify']);
    if (!await subtle.verify(SIGN, sigPubKey, signature, signedPreKeyPub))
      throw new Error('SPK signature invalid — possible MITM');
    // Ephemeral key
    const ekKp = await subtle.generateKey(ECDH, true, ['deriveBits']);
    const ekPub = await rawKey(ekKp);
    const opkPub = oneTimePreKeys?.[0] || null;
    // 3 (or 4) ECDH operations
    const [dh1,dh2,dh3] = await Promise.all([
      ecdh(_id.ikPriv, signedPreKeyPub),
      ecdh(ekKp.privateKey, identityPub),
      ecdh(ekKp.privateKey, signedPreKeyPub),
    ]);
    const dh4    = opkPub ? await ecdh(ekKp.privateKey, opkPub) : null;
    const master = await hkdf(dh4 ? cat(dh1,dh2,dh3,dh4) : cat(dh1,dh2,dh3), new Uint8Array(32), 'MIUT_PROTO_v1', 64);
    _sess.set(peerId, { rootKey:master.slice(0,32), sendChain:master.slice(32), recvChain:null, sendN:0, recvN:0, peerIkPub:identityPub });
    return { senderIkPub:_id.ikPub, ephemeralPub:ekPub, opkId:opkPub?0:null };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     4. X3DH — RESPONDER
     ══════════════════════════════════════════════════════════════════════════ */
  async function completeSession(peerId, header) {
    if (!_id) throw new Error('Call initIdentity() first');
    const spkData = await idbGet('spk');
    if (!spkData) throw new Error('No SPK available');
    const spkPriv = await importPrivECDH(spkData.priv);
    const [dh1,dh2,dh3] = await Promise.all([
      ecdh(spkPriv, header.senderIkPub),
      ecdh(_id.ikPriv, header.ephemeralPub),
      ecdh(spkPriv, header.ephemeralPub),
    ]);
    let dh4 = null;
    if (header.opkId != null) {
      const opks = await idbGet('opks');
      const entry = (opks||[]).find(o=>o.id===header.opkId);
      if (entry) { const p=await importPrivECDH(entry.priv); dh4=await ecdh(p,header.ephemeralPub); }
    }
    const master = await hkdf(dh4 ? cat(dh1,dh2,dh3,dh4) : cat(dh1,dh2,dh3), new Uint8Array(32), 'MIUT_PROTO_v1', 64);
    _sess.set(peerId, { rootKey:master.slice(0,32), sendChain:null, recvChain:master.slice(32), sendN:0, recvN:0, peerIkPub:header.senderIkPub });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     5. DOUBLE RATCHET
     ══════════════════════════════════════════════════════════════════════════ */
  async function _ratchet(chain) {
    const mk   = await hkdf(chain, new Uint8Array(1), 'MIUT_MP_MSG_KEY', 32);
    const next = await hkdf(chain, new Uint8Array(2), 'MIUT_MP_CHAIN', 32);
    return { mk, next };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     6. ENCRYPT / DECRYPT
     ══════════════════════════════════════════════════════════════════════════ */
  async function encryptMessage(peerId, plaintext, ctx) {
    const s = _sess.get(peerId);
    if (!s?.sendChain) throw new Error('No send chain for peer: ' + peerId);
    const { mk, next } = await _ratchet(s.sendChain);
    s.sendChain = next; s.sendN++;
    const iv    = rnd(12), nonce = rnd(16), ts = Date.now();
    const aad   = _buildAAD({ ...ctx, ts, nonce });
    const key   = await importAES(mk, 'encrypt');
    const pt    = ENC.encode(typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext));
    const ct    = await aesEncrypt(key, pt, iv, aad);
    return { v:2, iv, ct, aad, ts, nonce, n:s.sendN };
  }

  async function decryptMessage(peerId, env) {
    const s = _sess.get(peerId);
    if (!s?.recvChain) throw new Error('No recv chain for peer: ' + peerId);
    // Replay check
    const nk = peerId + ':' + Array.from(u8(env.nonce)).join(',');
    if (_nonces.has(nk)) throw new Error('Replay detected');
    if (Math.abs(Date.now() - (env.ts||0)) > 300000) throw new Error('Timestamp out of window');
    const { mk, next } = await _ratchet(s.recvChain);
    s.recvChain = next; s.recvN++;
    const key = await importAES(mk, 'decrypt');
    const pt  = await aesDecrypt(key, u8(env.ct), u8(env.iv), u8(env.aad));
    _nonces.add(nk);
    if (_nonces.size > 1000) { const it=_nonces.values(); for(let i=0;i<200;i++) _nonces.delete(it.next().value); }
    return DEC.decode(pt);
  }

  function _buildAAD(ctx) {
    return ENC.encode(['MIUT_AAD_v2', ctx.roomCode||'', ctx.senderId||'', ctx.epoch??'', ctx.ts||0, Array.from(u8(ctx.nonce)).join('-')].join('|'));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     7. IDENTITY VERIFICATION — 60-digit safety number
     ══════════════════════════════════════════════════════════════════════════ */
  async function verifyFingerprint(peerIkPub) {
    if (!_id) throw new Error('Call initIdentity() first');
    const a = _id.ikPub, b = u8(peerIkPub);
    // Canonical order: lexicographic sort so both peers get the same number
    let lo = a, hi = b;
    for (let i=0; i<Math.min(a.length,b.length); i++) {
      if (a[i] < b[i]) { break; }
      if (a[i] > b[i]) { lo=b; hi=a; break; }
    }
    const h = await digest(cat(lo, hi));
    // 60-digit safety number (12 × 5-digit groups from hash bytes)
    let num = '';
    for (let i=0; i<12; i++) {
      const v = ((h[i*2]<<16) | (h[i*2+1]<<8) | (h[i*2+2]||0)) % 100000;
      num += String(v).padStart(5,'0');
    }
    const groups = num.slice(0,60).match(/.{1,5}/g)||[];
    return { safetyNumber: groups.join(' '), raw: num.slice(0,60), hash: h };
  }

  /* ── Public API ──────────────────────────────────────────────────────────── */
  return {
    initIdentity,
    generatePreKeyBundle,
    initiateSession,
    completeSession,
    encryptMessage,
    decryptMessage,
    verifyFingerprint,
    getIdentityPub: () => _id?.ikPub || null,
    hasSession:     id => _sess.has(id) && !!_sess.get(id).sendChain,
    clearSession:   id => _sess.delete(id),
  };
})();
