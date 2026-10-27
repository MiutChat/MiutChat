'use strict';

// Extracted from app.js. Loaded lazily — only when the user actually attaches
// a file, or renders a message whose type is image/video/file/chunk. A
// session that never touches a file never downloads this module at all.
//
// Design rules this file follows (see README.md's architecture notes for why):
// - Never reads an imported binding (state, db, _roomEpoch, _roomSalt) at
//   module TOP LEVEL — only inside function bodies, which only ever run
//   after this module has fully finished loading. Top-level code here is
//   limited to declaring private state and scheduling the sweep timer below,
//   neither of which reads anything imported.
// - _roomSalt is read fresh via the live import on every use, never
//   snapshotted into a local variable across an await — a stale snapshot
//   would silently undo the self-heal in decBytes().
// - _chunkGroups and _epochKeys are PRIVATE to this module. Nothing outside
//   file-transfer.js ever touched them even before this extraction (verified
//   by dependency trace, not assumed). _chunkGroups used to be reset
//   externally by app.js's bootApp() on room entry; that external reset is
//   gone now that this module is lazy-loaded, possibly well after bootApp()
//   has already run. Instead, every group is tagged with the room code it
//   was created under, and the self-contained sweep below treats a group
//   whose room code no longer matches the current room as stale, same as a
//   group that's timed out.

import {
  CONFIG, state, db, toast, scrollBottom, renderMsg, signMsg, ts_now, _log,
  esc, playSound, _testCompression, _b64uDec, idbGetBlob, idbSetBlob,
  showScrollFab, _placeMsg, _notifyRoomOfNewMessage,
  _roomEpoch, _roomSalt, setRoomSalt, _lazyDataMap, _lruMap,
} from '../app.js';

export const CHUNK_TIMING = {
  healDelaysMs: [2500, 7000, 15000],
  stallMs: 20000,
  waitingLabelMs: 4000,
  giveUpMs: 10 * 60 * 1000,
};

const _doneGroups = new Set();
const _failedGroups = new Map();

let _chunkGroups = {};
const _epochKeys = _lruMap(50);

// Self-contained — does not depend on app.js's expiry-sweep timer, since
// that timer runs for every session from boot and would otherwise force
// this module to load eagerly just to be resettable. Reads `state.roomCode`
// only inside the callback (fine — scheduling is not reading), never at the
// top level of this module.
setInterval(() => _sweepStaleChunkGroups(), 5000);

async function _getEpochKey(code, epoch) {
  const saltTag  = _roomSalt || 'v1';
  const cacheKey = `${code}:${epoch}:${saltTag}`;
  if (_epochKeys.has(cacheKey)) return _epochKeys.get(cacheKey);

  let salt;
  if (_roomSalt) {
    const roomSaltBytes = _b64uDec(_roomSalt);
    const epochTag = new TextEncoder().encode(`|epoch:${epoch}`);
    const combined = new Uint8Array(roomSaltBytes.length + epochTag.length);
    combined.set(roomSaltBytes, 0);
    combined.set(epochTag, roomSaltBytes.length);
    salt = new Uint8Array(await crypto.subtle.digest('SHA-256', combined)).slice(0, 16);
  } else {
    const saltInput = new TextEncoder().encode(`NEXUS_EPOCH|${code}|${epoch}`);
    const saltHash  = await crypto.subtle.digest('SHA-256', saltInput);
    salt = new Uint8Array(saltHash).slice(0, 16);
  }

  const raw  = new TextEncoder().encode(code);
  const base = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  const key  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  _epochKeys.set(cacheKey, key);
  return key;
}

async function _collectStream(readable) {
  const chunks = [], reader = readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export async function encBytes(file, code, opts = {}) {
  try {
    const epoch = _roomEpoch;
    const key   = await _getEpochKey(code, epoch);
    const iv    = crypto.getRandomValues(new Uint8Array(12));
    let fileBuf = new Uint8Array(await file.arrayBuffer());
    let compressed = false;
    if (opts.compress !== false && await _testCompression() && file.size > 1024) {
      try {
        const cs = new CompressionStream('deflate-raw');
        const w  = cs.writable.getWriter();
        w.write(fileBuf); w.close();
        const cBuf = await _collectStream(cs.readable);
        if (cBuf.length < fileBuf.length * 0.95) {
          fileBuf = cBuf; compressed = true;
        }
      } catch {}
    }
    const markedBuf = new Uint8Array(1 + fileBuf.length);
    markedBuf[0] = compressed ? 0xC0 : 0x00;
    markedBuf.set(fileBuf, 1);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, markedBuf);
    const epochBuf = new Uint8Array(4);
    new DataView(epochBuf.buffer).setUint32(0, epoch, false);
    const ctBytes = new Uint8Array(ct);
    const out = new Uint8Array(4 + 12 + ctBytes.byteLength);
    out.set(epochBuf, 0);
    out.set(iv, 4);
    out.set(ctBytes, 16);
    let s = '';
    for (let i = 0; i < out.length; i += 16384) {
      s += String.fromCharCode(...out.subarray(i, i + 16384));
    }
    return 'b:' + btoa(s);
  } catch (e) { throw e; }
}

async function _yieldToMain() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  return new Promise(r => setTimeout(r, 0));
}

async function _b64ToBytes(input) {
  const parts = Array.isArray(input) ? input : [input];
  let chars = 0;
  for (const p of parts) chars += p.length;
  chars -= 2;
  const last = parts[parts.length - 1];
  const pad = last.endsWith('==') ? 2 : last.endsWith('=') ? 1 : 0;
  if (chars % 4 !== 0) return Uint8Array.from(atob(parts.join('').slice(2)), c => c.charCodeAt(0));
  const out = new Uint8Array((chars / 4) * 3 - pad);
  let o = 0, carry = '';
  for (let i = 0; i < parts.length; i++) {
    let str = carry + (i === 0 ? parts[i].slice(2) : parts[i]);
    const cut = i === parts.length - 1 ? str.length : str.length - (str.length % 4);
    carry = str.slice(cut);
    str = str.slice(0, cut);
    for (let k = 0; k < str.length; k += 196608) {
      const bin = atob(str.slice(k, k + 196608));
      for (let n = 0; n < bin.length; n++) out[o++] = bin.charCodeAt(n);
    }
    if (parts.length > 1 || str.length > 262144) await _yieldToMain();
  }
  return o === out.length ? out : out.subarray(0, o);
}

export async function decBytes(input, mime, code) {
  const first = Array.isArray(input) ? input[0] : input;
  if (typeof first === 'string' && first.startsWith('b:')) {
    const raw   = await _b64ToBytes(input);
    const epoch = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, false);
    const iv    = raw.subarray(4, 16);
    const ct    = raw.subarray(16);
    let key     = await _getEpochKey(code, epoch);
    let pt;
    try {
      pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
    } catch (e) {
      if (code === state.roomCode && db) {
        try {
          const roomSnap = await db.collection('rooms').doc(code).get();
          const freshSalt = roomSnap.exists ? (roomSnap.data()?.salt || null) : null;
          if (freshSalt && freshSalt !== _roomSalt) {
            setRoomSalt(freshSalt);
            _epochKeys.delete(`${code}:${epoch}:${freshSalt}`);
            key = await _getEpochKey(code, epoch);
            pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
          } else { throw e; }
        } catch { throw e; }
      } else { throw e; }
    }
    if (pt.length > 1 && pt[0] === 0xC0) {
      try {
        const ds = new DecompressionStream('deflate-raw');
        const w  = ds.writable.getWriter();
        w.write(pt.subarray(1)); w.close();
        pt = await _collectStream(ds.readable);
      } catch (e) {
        throw new Error('decompress failed: ' + (e?.message || e));
      }
    } else if (pt.length > 1 && pt[0] === 0x00) {
      pt = pt.subarray(1);
    }
    return new Blob([pt], { type: mime });
  }
  throw new Error('Unsupported legacy media format');
}

export async function prepareImageForUpload(file, opts = {}) {
  const maxEdge = opts.maxEdge || 1600, quality = opts.quality || 0.82, keepBelow = opts.keepBelow || 700 * 1024;
  const looksImage = /^image\/(jpeg|png|webp|heic|heif|avif|bmp)$/.test(file.type) || (!file.type && /\.(heic|heif|avif|bmp|jpe?g|png|webp)$/i.test(file.name));
  if (!looksImage) return file;
  let bmp = null;
  try {
    bmp = await createImageBitmap(file);
    const w = bmp.width, h = bmp.height;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    if (scale === 1 && file.size <= keepBelow) return file;
    const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(tw, th) : Object.assign(document.createElement('canvas'), { width: tw, height: th });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tw, th);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, tw, th);
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
      : await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bmp?.close?.();
  }
}

export async function handleFileAttach(e) {
  const file = e.target.files?.[0];
  if (!file || !state.roomCode) return;
  e.target.value = '';
  if (typeof window.updateActionBtn === 'function') window.updateActionBtn();

  if (file.size > CONFIG.MAX_FILE_BYTES) {
    toast('File too large', 'Max 25 MB per file', 'err'); return;
  }

  const isImg   = file.type.startsWith('image/');
  const isVid   = file.type.startsWith('video/');
  const msgType = isImg ? 'image' : isVid ? 'video' : 'file';

  let _optimisticEl = null;
  if (isImg) {
    const localUrl  = URL.createObjectURL(file);
    const fakeDocId = 'opt_' + Date.now();
    const fakeData  = {
      type: 'image', senderId: state.me.id, senderName: state.me.name,
      senderColor: state.me.color, ts: Date.now(), enc: '', sig: null,
    };
    const area = document.getElementById('messages-area');
    if (area) {
      const wrap = document.createElement('div');
      wrap.className    = 'msg-wrapper sent';
      wrap.dataset.docId = fakeDocId;
      wrap.dataset.ts    = fakeData.ts;
      wrap.style.opacity = '0.75';
      wrap.innerHTML = `<div class="msg-swipe-wrapper"><div class="msg-bubble-wrap">
        <div class="msg-inner">
          <div class="msg-bubble" style="padding:4px;background:transparent">
            <img src="${localUrl}" style="max-width:220px;max-height:220px;border-radius:14px;display:block" loading="eager"/>
            <div class="msg-upload-progress"><div class="msg-upload-bar"></div></div>
          </div>
          <div class="msg-meta"><span class="msg-time-sm">Sending…</span></div>
        </div>
      </div></div>`;
      area.appendChild(wrap);
      scrollBottom();
      _optimisticEl = wrap;
      const bar = wrap.querySelector('.msg-upload-bar');
      if (bar) { setTimeout(() => { bar.style.width = '60%'; }, 50); }
    }
  } else {
    toast('Encrypting…', file.name, 'dot');
  }

  try {
    const sendFile = isImg ? await prepareImageForUpload(file) : file;
    const encrypted = await encBytes(sendFile, state.roomCode, { compress: !isImg && !isVid });
    const totalSize = encrypted.length;

    if (totalSize <= CONFIG.CHUNK_BYTES) {
      const fts  = Date.now();
      const fsig = await signMsg(state.me.id, fts, encrypted.slice(0, 64));
      await db.collection('rooms').doc(state.roomCode).collection('messages').add({
        type: msgType, encData: encrypted, mime: sendFile.type,
        fileName: sendFile.name, fileSize: sendFile.size, chunks: 1, chunkOf: 1,
        senderId: state.me.id, senderName: state.me.name, senderColor: state.me.color,
        sig: fsig, ts: fts, createdAt: ts_now(),
      });
    } else {
      const parts   = [];
      for (let i = 0; i < totalSize; i += CONFIG.CHUNK_BYTES)
        parts.push(encrypted.slice(i, i + CONFIG.CHUNK_BYTES));
      const groupId = 'grp_' + state.me.id.slice(0, 8) + '_' + Date.now() + '_' +
        Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => b.toString(36)).join('').slice(0, 8);
      const now     = Date.now();
      const BATCH   = 4;
      const writtenRefs = [];
      let chunksSent = 0;
      try {
        for (let b = 0; b < parts.length; b += BATCH) {
          const refs = await Promise.all(parts.slice(b, b + BATCH).map((part, li) => {
            const idx = b + li;
            return db.collection('rooms').doc(state.roomCode).collection('messages').add({
              type: idx === 0 ? msgType : 'chunk', encData: part,
              mime: sendFile.type, fileName: sendFile.name, fileSize: sendFile.size,
              groupId, chunkIdx: idx, chunkOf: parts.length,
              senderId: state.me.id, senderName: state.me.name, senderColor: state.me.color,
              createdAt: ts_now(), ts: idx === 0 ? now : Date.now(),
            });
          }));
          writtenRefs.push(...refs);
          chunksSent += refs.length;
        }
      } catch (chunkErr) {
        _log('warn', `[MIUT upload] chunked upload failed after ${chunksSent}/${parts.length} parts for group ${groupId} — cleaning up orphaned chunks:`, chunkErr?.message || chunkErr);
        await Promise.all(writtenRefs.map(ref => ref.delete().catch(() => {})));
        throw new Error(`Only ${chunksSent} of ${parts.length} parts uploaded before the connection dropped — the partial upload was cleaned up. Try again.`);
      }
    }
    playSound('send');
    _notifyRoomOfNewMessage();
    if (_optimisticEl) {
      _optimisticEl.style.transition = 'opacity .3s';
      _optimisticEl.style.opacity = '0';
      setTimeout(() => _optimisticEl?.remove(), 320);
    } else {
      toast('Sent!', file.name, 'ok');
    }
  } catch (err) {
    if (_optimisticEl) { _optimisticEl.remove(); }
    toast('Upload failed', err.message || 'Check your connection', 'err');
  }
}

function _groupMissing(g) {
  const out = [];
  for (let i = 0; i < g.total; i++) if (g.parts[i] === undefined) out.push(i);
  return out;
}

function _addPart(g, d, docId) {
  if (g.parts[d.chunkIdx] !== undefined) return false;
  g.parts[d.chunkIdx] = d.encData;
  g.lastProgressAt = Date.now();
  g.healStep = 0;
  g.stalled = false;
  if (d.chunkIdx === 0) { g.meta = d; g.docId = docId; }
  return true;
}

function _newGroup(data, docId) {
  const now = Date.now();
  return { parts: {}, total: data.chunkOf, meta: data, docId, firstSeenAt: now, lastProgressAt: now, healStep: 0, healing: false, stalled: false, timer: null, roomCode: state.roomCode };
}

export function assembleChunk(data, docId) {
  const gid = data.groupId;
  if (!gid) { _log('warn', '[MIUT media] chunk doc has no groupId, cannot assemble:', docId, data); return; }
  if (_doneGroups.has(gid)) return;
  let g = _chunkGroups[gid];
  const isNew = !g;
  if (isNew) g = _chunkGroups[gid] = _newGroup(data, docId);
  _addPart(g, data, docId);
  if (isNew) _renderChunkProgressBubble(gid, data, docId);
  _paintGroup(gid);
  if (_groupMissing(g).length === 0) { _finishGroup(gid); return; }
  _armWatch(gid);
}

function _groupEl(gid) {
  return document.querySelector(`.msg-media[data-group-id="${CSS.escape(gid)}"]`);
}

function _paintError(el, gid, have, total) {
  el.classList.remove('loading');
  el.innerHTML = `<div class="msg-media-err">Missing ${total - have} of ${total} parts — the sender may have lost connection.<button type="button" class="chunk-retry">Retry</button></div>`;
  el.querySelector('.chunk-retry').addEventListener('click', () => _retryGroup(gid));
}

function _paintGroup(gid) {
  const g = _chunkGroups[gid];
  const el = g && _groupEl(gid);
  if (!el) return;
  const have = Object.keys(g.parts).length;
  if (g.stalled) { _paintError(el, gid, have, g.total); return; }
  el.classList.add('loading');
  let lab = el.querySelector('.media-decrypt-label');
  if (!lab) {
    el.innerHTML = '<div class="media-decrypt-spinner"></div><div class="media-decrypt-label"></div>';
    lab = el.querySelector('.media-decrypt-label');
  }
  const isMine = el.closest('.msg-wrapper')?.classList.contains('sent');
  const waiting = Date.now() - g.lastProgressAt > CHUNK_TIMING.waitingLabelMs;
  lab.textContent = waiting ? `Waiting for the remaining parts… ${have}/${g.total}` : _chunkProgressLabel(have, g.total, isMine);
}

function _armWatch(gid) {
  const g = _chunkGroups[gid];
  if (!g) return;
  clearTimeout(g.timer);
  g.timer = setTimeout(() => _tickGroup(gid), g.stalled ? 2000 : 400);
}

async function _tickGroup(gid) {
  const g = _chunkGroups[gid];
  if (!g) return;
  const T = CHUNK_TIMING;
  if (Date.now() - g.firstSeenAt > T.giveUpMs) { _failGroup(gid); return; }
  if (!g.stalled && !g.healing && g.healStep < T.healDelaysMs.length && Date.now() - g.lastProgressAt >= T.healDelaysMs[g.healStep]) {
    await _healGroup(gid);
  }
  const cur = _chunkGroups[gid];
  if (!cur) return;
  if (!cur.stalled && cur.healStep >= T.healDelaysMs.length && Date.now() - cur.lastProgressAt >= T.stallMs) cur.stalled = true;
  _paintGroup(gid);
  _armWatch(gid);
}

async function _healGroup(gid) {
  const g = _chunkGroups[gid];
  if (!g || g.healing || !state.roomCode || !db) return 0;
  g.healing = true;
  let added = 0;
  try {
    const missing = _groupMissing(g);
    const col = db.collection('rooms').doc(state.roomCode).collection('messages');
    const docs = [];
    try {
      for (let i = 0; i < missing.length; i += 10) {
        const snap = await col.where('groupId', '==', gid).where('chunkIdx', 'in', missing.slice(i, i + 10)).get();
        snap.forEach(d => docs.push(d));
      }
    } catch {
      docs.length = 0;
      const snap = await col.where('groupId', '==', gid).get();
      snap.forEach(d => docs.push(d));
    }
    for (const d of docs) if (_addPart(g, d.data(), d.id)) added++;
  } catch (e) {
    _log('warn', '[MIUT media] could not look up missing parts for', gid, e);
  } finally {
    g.healing = false;
  }
  const cur = _chunkGroups[gid];
  if (cur) {
    if (!added) cur.healStep++;
    if (_groupMissing(cur).length === 0) _finishGroup(gid); else _paintGroup(gid);
  }
  return added;
}

export async function healChunkGroupsNow() {
  await Promise.all(Object.keys(_chunkGroups).map(gid => _healGroup(gid)));
}

function _retryGroup(gid) {
  const g = _chunkGroups[gid];
  if (g) {
    g.stalled = false; g.healStep = 0; g.lastProgressAt = Date.now();
    _paintGroup(gid);
    _healGroup(gid).then(() => _armWatch(gid));
    return;
  }
  const f = _failedGroups.get(gid);
  if (!f) return;
  _failedGroups.delete(gid);
  _chunkGroups[gid] = _newGroup(f.meta, f.docId);
  _chunkGroups[gid].total = f.total;
  _paintGroup(gid);
  _healGroup(gid).then(() => { if (_chunkGroups[gid]) _armWatch(gid); });
}

function _failGroup(gid) {
  const g = _chunkGroups[gid];
  if (!g) return;
  clearTimeout(g.timer);
  const have = Object.keys(g.parts).length;
  _failedGroups.set(gid, { total: g.total, meta: g.meta, docId: g.docId });
  delete _chunkGroups[gid];
  const el = _groupEl(gid);
  if (el) _paintError(el, gid, have, g.total);
  _log('warn', `[MIUT media] gave up on chunk group ${gid} at ${have}/${g.total} parts`);
}

function _finishGroup(gid) {
  const g = _chunkGroups[gid];
  if (!g) return;
  clearTimeout(g.timer);
  delete _chunkGroups[gid];
  _doneGroups.add(gid);
  if (_doneGroups.size > 300) _doneGroups.delete(_doneGroups.values().next().value);
  const parts = Array.from({ length: g.total }, (_, i) => g.parts[i]);
  _log('debug', `[MIUT media] group ${gid} complete (${g.total} parts), rendering`);
  _removeChunkProgressBubble(gid);
  const existing = document.querySelector(`.msg-wrapper[data-doc-id="${CSS.escape(g.docId)}"]`);
  if (existing) existing.remove();
  return renderMsg({ ...g.meta, encData: parts, type: g.meta.type === 'chunk' ? 'file' : g.meta.type, _assembled: true }, g.docId);
}

function _sweepStaleChunkGroups() {
  for (const gid of Object.keys(_chunkGroups)) {
    const g = _chunkGroups[gid];
    if (!g) continue;
    if (g.roomCode !== undefined && g.roomCode !== state.roomCode) {
      clearTimeout(g.timer);
      delete _chunkGroups[gid];
    } else if (Date.now() - g.firstSeenAt > CHUNK_TIMING.giveUpMs) {
      _failGroup(gid);
    }
  }
  for (const uid of _lazyDataMap.keys()) {
    if (!document.getElementById(uid)) _lazyDataMap.delete(uid);
  }
}

function _renderChunkProgressBubble(gid, data, docId) {
  if (_groupEl(gid)) return;
  const area = document.getElementById('messages-area');
  if (!area) return;
  document.getElementById('msg-skeleton') && (document.getElementById('msg-skeleton').style.display = 'none');
  document.getElementById('room-welcome') && (document.getElementById('room-welcome').style.display = 'none');
  const isMine = data.senderId === state.me?.id;
  const wrap = document.createElement('div');
  wrap.className      = `msg-wrapper ${isMine ? 'sent' : 'received'}`;
  wrap.dataset.docId   = docId || '';
  wrap.dataset.groupId = gid;
  wrap.dataset.ts      = data.ts || '';
  wrap.innerHTML = `<div class="msg-swipe-wrapper"><div class="msg-bubble-wrap"><div class="msg-inner">
    <div class="msg-bubble" style="padding:4px;background:transparent">
      <div class="msg-media loading" data-group-id="${esc(gid)}">
        <div class="media-decrypt-spinner"></div>
        <div class="media-decrypt-label">${esc(_chunkProgressLabel(1, data.chunkOf, isMine))}</div>
      </div>
    </div>
  </div></div></div>`;
  const _wasNearBottom = (area.scrollHeight - area.scrollTop - area.clientHeight) < 120;
  _placeMsg(area, wrap, data);
  if (isMine || _wasNearBottom) scrollBottom();
  else showScrollFab();
}

function _removeChunkProgressBubble(gid) {
  document.querySelectorAll(`[data-group-id="${CSS.escape(gid)}"]`).forEach(el => (el.closest('.msg-wrapper') || el).remove());
}

function _chunkProgressLabel(have, total, isMine) {
  const pct = total ? Math.round((have / total) * 100) : 0;
  return `${isMine ? 'Sending' : 'Receiving'} file… ${have}/${total} parts (${pct}%)`;
}

export function openViewer(type, src) {
  const v = document.getElementById('media-viewer'), img = document.getElementById('mv-img'), vid = document.getElementById('mv-video');
  if (!v) return;
  if (img) { img.src = ''; img.style.display = 'none'; }
  if (vid) { vid.src = ''; vid.style.display = 'none'; }
  if (type === 'img'   && img) { img.src = src; img.style.display = 'block'; }
  if (type === 'video' && vid) { vid.src = src; vid.style.display = 'block'; }
  v.style.display = 'flex';
}

export function closeMediaViewer() {
  const v = document.getElementById('media-viewer'); if (!v) return;
  v.style.display = 'none';
  const vid = document.getElementById('mv-video'); if (vid) { vid.pause?.(); vid.src = ''; }
  const img = document.getElementById('mv-img');   if (img) img.src = '';
}

export async function decryptAndShow(encData, mime, type, fileName, domId) {
  if (!encData || (Array.isArray(encData) && !encData.length)) {
    _log('warn', '[MIUT media] decryptAndShow called with empty/missing encData — nothing to decrypt:', domId, { type, fileName });
    const el0 = document.getElementById(domId);
    if (el0) el0.innerHTML = `<div style="padding:8px;color:var(--text2);font-size:.7rem">Media unavailable</div>`;
    return;
  }
  const cacheKey = 'blob_' + btoa((Array.isArray(encData) ? encData[0] : encData).slice(0, 32).replace(/[^a-zA-Z0-9]/g, '').padEnd(8, '0')).slice(0, 16);

  let url = null;

  const cachedBytes = await idbGetBlob(cacheKey).catch(e => { _log('debug', '[MIUT media] IDB cache miss/error (not fatal, will re-decrypt):', domId, e); return null; });
  if (cachedBytes) {
    try {
      const blob = new Blob([cachedBytes], { type: mime });
      url = URL.createObjectURL(blob);
      _log('debug', '[MIUT media] served from IDB cache:', domId);
    } catch (e) { _log('debug', '[MIUT media] cached blob construction failed, falling through to re-decrypt:', domId, e); }
  }

  if (!url) {
    try {
      const blob  = await decBytes(encData, mime, state.roomCode);
      url = URL.createObjectURL(blob);
      (window.requestIdleCallback || setTimeout)(() => idbSetBlob(cacheKey, blob).catch(() => {}));
      _log('debug', '[MIUT media] decrypted fresh:', domId, { bytes: blob.size });
    } catch (e) {
      _log('error', '[MIUT media] decryption FAILED — this is why the media never rendered:', domId, { type, mime, encDataLength: encData?.length }, e);
      const el = document.getElementById(domId);
      const why = String(e?.message || '').startsWith('decompress failed') ? "This file uses compression this browser can't open" : 'This message could not be decrypted';
      if (el) el.innerHTML = `<div style="padding:8px;color:var(--text2);font-size:.7rem">${why}</div>`;
      return;
    }
  }

  const el = document.getElementById(domId);
  if (!el) {
    _log('warn', '[MIUT media] decryption succeeded but the placeholder element is gone from the DOM — media decrypted into nothing:', domId, '(the wrap was likely removed/replaced — e.g. re-rendered, deleted, or the room was left — between when decrypt started and finished)');
    return;
  }

  if (type === 'image') {
    const img = document.createElement('img');
    img.src = url; img.alt = 'image'; img.loading = 'lazy'; img.style.cursor = 'pointer';
    img.addEventListener('click', () => openViewer('img', url));
    img.addEventListener('error', () => {
      el.classList.remove('loading');
      el.innerHTML = `<div class="media-fallback"><div class="media-fallback-msg">This image can't be displayed on this device (unsupported format or too large).</div><div class="media-fallback-actions"><a class="media-fallback-dl" href="${esc(url)}" download="${esc(fileName || 'image')}">Download</a><button type="button" class="media-fallback-retry">Retry</button></div></div>`;
      el.querySelector('.media-fallback-retry').addEventListener('click', async () => {
        try { await idbSetBlob(cacheKey, null); } catch {}
        el.classList.add('loading');
        el.innerHTML = '<div class="media-decrypt-spinner"></div><div class="media-decrypt-label">Decrypting…</div>';
        decryptAndShow(encData, mime, type, fileName, domId);
      });
    }, { once: true });
    const hint = document.createElement('div');
    hint.className = 'media-tap-hint'; hint.textContent = 'Tap to expand';
    el.innerHTML = ''; el.appendChild(img); el.appendChild(hint);
    el.classList.remove('loading');
  } else if (type === 'video') {
    const thumb = document.createElement('div');
    thumb.className = 'video-thumb';
    thumb.innerHTML = `<div class="video-play-btn"><svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M8 5v14l11-7z"/></svg></div><div class="video-label">${esc(fileName || 'Video')}</div>`;
    thumb.addEventListener('click', () => openViewer('video', url));
    el.innerHTML = ''; el.appendChild(thumb);
    el.classList.remove('loading');
  } else {
    el.outerHTML = `<a class="msg-file" href="${esc(url)}" download="${esc(fileName || 'file')}" target="_blank" rel="noopener">
      <div class="file-icon"><svg viewBox="0 0 20 20" fill="none" width="22" height="22">
        <path d="M4 4a2 2 0 012-2h5l5 5v9a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" stroke="currentColor" stroke-width="1.5"/>
        <path d="M11 2v5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg></div>
      <div class="file-info">
        <div class="file-name">${esc(fileName || 'File')}</div>
      </div>
      <div class="file-dl"><svg viewBox="0 0 20 20" fill="none" width="16" height="16">
        <path d="M10 3v10M6 9l4 4 4-4M4 17h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg></div>
    </a>`;
  }
}
