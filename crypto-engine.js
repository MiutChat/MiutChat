'use strict';
const VERSION = 3;
const MAX_FIRESTORE_DOC = 1_048_576;
const OVERHEAD_BYTES = 1 + 4 + 8 + 4 + 4 + 12 + 16;
const HKDF_HASH = 'SHA-256';
const AES_ALGO = 'AES-GCM';
const SKIP_COMPRESS_MIME = new Set([
  'image/jpeg','image/png','image/webp','image/gif','image/avif',
  'video/mp4','video/webm','video/ogg','audio/mpeg','audio/ogg',
  'audio/webm','application/zip','application/gzip','application/zstd',
]);
const REPLAY_WINDOW_MS = 300_000;
const _seenIVs = new Set();
const _iksCache = new Map();

async function _deriveBaseKey(roomCode) {
  const raw = new TextEncoder().encode(roomCode);
  return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey','deriveBits']);
}

async function _deriveMessageKey(baseKey, roomCode, epoch, timestamp, context) {
  const info = new TextEncoder().encode(`miutchat|${roomCode}|${epoch}|${timestamp}|${context}`);
  const salt = new Uint8Array(32);
  const saltView = new DataView(salt.buffer);
  for (let i = 0; i < 8; i++) saltView.setUint8(i, (timestamp / Math.pow(256, 7 - i)) & 0xff);
  saltView.setUint32(8, epoch, false);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: HKDF_HASH, salt, info },
    baseKey,
    { name: AES_ALGO, length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function _buildAAD(roomCode, senderId, epoch, timestamp, chunkIndex) {
  const enc = new TextEncoder();
  const roomBytes = enc.encode(roomCode.slice(0, 64));
  const senderBytes = enc.encode(senderId.slice(0, 64));
  const aad = new Uint8Array(roomBytes.length + senderBytes.length + 4 + 8 + 4 + 2);
  let off = 0;
  aad[off++] = roomBytes.length;
  aad.set(roomBytes, off); off += roomBytes.length;
  aad[off++] = senderBytes.length;
  aad.set(senderBytes, off); off += senderBytes.length;
  const dv = new DataView(aad.buffer, off);
  dv.setUint32(0, epoch, false); off += 4;
  const hi = Math.floor(timestamp / 0x100000000);
  const lo = timestamp >>> 0;
  dv.setUint32(4, hi, false);
  dv.setUint32(8, lo, false); off += 8;
  dv.setUint32(12, chunkIndex, false);
  return aad;
}

function _validateTimestamp(timestamp) {
  const now = Date.now();
  const delta = Math.abs(now - timestamp);
  if (delta > REPLAY_WINDOW_MS) throw new Error(`REPLAY: timestamp delta ${delta}ms exceeds ${REPLAY_WINDOW_MS}ms`);
}

function _checkIVUnique(iv) {
  const key = _b64Fast(iv);
  if (_seenIVs.has(key)) throw new Error('SECURITY: IV reuse detected');
  _seenIVs.add(key);
  if (_seenIVs.size > 100_000) {
    const it = _seenIVs.values();
    for (let i = 0; i < 10_000; i++) _seenIVs.delete(it.next().value);
  }
}

function _b64Fast(buf) {
  let s = '';
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(s);
}

async function _compress(data, mime) {
  if (mime && SKIP_COMPRESS_MIME.has(mime)) return { data, compressed: false };
  if (typeof CompressionStream === 'undefined') return { data, compressed: false };
  try {
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter();
    w.write(data instanceof Uint8Array ? data : new Uint8Array(data));
    w.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    if (total >= data.byteLength) return { data, compressed: false };
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return { data: out, compressed: true };
  } catch { return { data, compressed: false }; }
}

async function _decompress(data) {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(data);
  w.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function _computeSafeChunkSize(fileSize, concurrentChunks) {
  const safetyMargin = 0.08;
  const maxPayload = Math.floor(MAX_FIRESTORE_DOC * (1 - safetyMargin)) - OVERHEAD_BYTES;
  if (fileSize < 1_048_576) return fileSize;
  if (fileSize < 10_485_760) return Math.min(maxPayload, 917_504);
  if (fileSize < 104_857_600) return Math.min(maxPayload, 524_288);
  const memEstimate = (typeof performance !== 'undefined' && performance.memory)
    ? performance.memory.jsHeapSizeLimit : 256_000_000;
  const memSafe = Math.floor(memEstimate * 0.15 / Math.max(concurrentChunks, 1));
  return Math.min(maxPayload, memSafe, 393_216);
}

async function encryptText(plaintext, roomCode, senderId, epoch, salt) {
  const normalized = plaintext.normalize('NFKC');
  const raw = new TextEncoder().encode(normalized);
  const { data: payload, compressed } = await _compress(raw, null);
  const timestamp = Date.now();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  _checkIVUnique(iv);
  const cacheKey = `${roomCode}:${epoch}`;
  let baseKey = _iksCache.get(cacheKey);
  if (!baseKey) {
    const saltBytes = salt ? _b64FastDecode(salt) : new Uint8Array(32);
    baseKey = await _deriveBaseKeyWithSalt(roomCode, epoch, saltBytes);
    _iksCache.set(cacheKey, baseKey);
  }
  const key = await _deriveMessageKey(baseKey, roomCode, epoch, timestamp, 'text');
  const aad = _buildAAD(roomCode, senderId, epoch, timestamp, 0);
  const ct = await crypto.subtle.encrypt({ name: AES_ALGO, iv, additionalData: aad }, key, payload);
  const ctBytes = new Uint8Array(ct);
  const out = new Uint8Array(1 + 4 + 8 + 12 + ctBytes.length);
  let off = 0;
  out[off++] = VERSION | (compressed ? 0x80 : 0x00);
  const dv = new DataView(out.buffer, off);
  dv.setUint32(0, epoch, false); off += 4;
  dv.setUint32(4, Math.floor(timestamp / 0x100000000), false);
  dv.setUint32(8, timestamp >>> 0, false); off += 8;
  out.set(iv, off); off += 12;
  out.set(ctBytes, off);
  return { data: out, senderId, epoch, timestamp, aad };
}

async function decryptText(binaryData, roomCode, senderId, epoch, salt) {
  const buf = binaryData instanceof Uint8Array ? binaryData : new Uint8Array(binaryData);
  if (buf.length < 26) throw new Error('CORRUPT: payload too short');
  let off = 0;
  const versionByte = buf[off++];
  const compressed = (versionByte & 0x80) !== 0;
  const dv = new DataView(buf.buffer, buf.byteOffset + off);
  const epochStored = dv.getUint32(0, false); off += 4;
  const hi = dv.getUint32(4, false);
  const lo = dv.getUint32(8, false);
  const timestamp = hi * 0x100000000 + lo; off += 8;
  _validateTimestamp(timestamp);
  const iv = buf.slice(off, off + 12); off += 12;
  const ct = buf.slice(off);
  const cacheKey = `${roomCode}:${epochStored}`;
  let baseKey = _iksCache.get(cacheKey);
  if (!baseKey) {
    const saltBytes = salt ? _b64FastDecode(salt) : new Uint8Array(32);
    baseKey = await _deriveBaseKeyWithSalt(roomCode, epochStored, saltBytes);
    _iksCache.set(cacheKey, baseKey);
  }
  const key = await _deriveMessageKey(baseKey, roomCode, epochStored, timestamp, 'text');
  const aad = _buildAAD(roomCode, senderId, epochStored, timestamp, 0);
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: AES_ALGO, iv, additionalData: aad }, key, ct);
  } catch { throw new Error('DECRYPT: AES-GCM authentication failed'); }
  const ptBytes = new Uint8Array(pt);
  const decompressed = compressed ? await _decompress(ptBytes) : ptBytes;
  return new TextDecoder().decode(decompressed);
}

async function _deriveBaseKeyWithSalt(roomCode, epoch, saltBytes) {
  const raw = new TextEncoder().encode(roomCode);
  const importedRaw = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100_000, hash: HKDF_HASH },
    importedRaw, 256
  );
  return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

function _b64FastDecode(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

async function encryptFile(file, metadata, roomCode, senderId, epoch, salt, onProgress) {
  const { name, type: mime, size } = file;
  const CONCURRENCY = 4;
  const chunkSize = _computeSafeChunkSize(size, CONCURRENCY);
  const totalChunks = Math.ceil(size / chunkSize) || 1;
  const timestamp = Date.now();
  const cacheKey = `${roomCode}:${epoch}`;
  let baseKey = _iksCache.get(cacheKey);
  if (!baseKey) {
    const saltBytes = salt ? _b64FastDecode(salt) : new Uint8Array(32);
    baseKey = await _deriveBaseKeyWithSalt(roomCode, epoch, saltBytes);
    _iksCache.set(cacheKey, baseKey);
  }
  const skipCompress = SKIP_COMPRESS_MIME.has(mime);
  const results = new Array(totalChunks);
  let completed = 0;
  const semaphore = _createSemaphore(CONCURRENCY);

  const jobs = Array.from({ length: totalChunks }, (_, i) => async () => {
    const release = await semaphore.acquire();
    try {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, size);
      const slice = file.slice(start, end);
      const ab = await slice.arrayBuffer();
      let payload = new Uint8Array(ab);
      let compressed = false;
      if (!skipCompress) {
        const r = await _compress(payload, mime);
        payload = r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data);
        compressed = r.compressed;
      }
      const chunkTs = timestamp + i;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      _checkIVUnique(iv);
      const key = await _deriveMessageKey(baseKey, roomCode, epoch, chunkTs, `chunk:${i}`);
      const aad = _buildAAD(roomCode, senderId, epoch, chunkTs, i);
      const ct = await crypto.subtle.encrypt({ name: AES_ALGO, iv, additionalData: aad }, key, payload);
      const ctBytes = new Uint8Array(ct);
      const out = new Uint8Array(OVERHEAD_BYTES + ctBytes.length);
      let off = 0;
      out[off++] = VERSION | (compressed ? 0x80 : 0x00);
      const dv = new DataView(out.buffer, off);
      dv.setUint32(0, epoch, false); off += 4;
      dv.setUint32(4, Math.floor(chunkTs / 0x100000000), false);
      dv.setUint32(8, chunkTs >>> 0, false); off += 8;
      dv.setUint32(12, i, false); off += 4;
      dv.setUint32(16, totalChunks, false); off += 4;
      out.set(iv, off); off += 12;
      out.set(ctBytes, off);
      results[i] = { index: i, data: out, size: out.length };
      completed++;
      if (onProgress) onProgress(completed / totalChunks, i, totalChunks);
    } finally { release(); }
  });

  await Promise.all(jobs.map(j => j()));

  if (out.length > MAX_FIRESTORE_DOC) {
    throw new Error(`OVERFLOW: chunk ${results.findIndex(r => r && r.size > MAX_FIRESTORE_DOC)} exceeds 1MB`);
  }

  return {
    chunks: results,
    metadata: { name, mime, size, totalChunks, epoch, timestamp, senderId },
  };
}

async function decryptFile(chunks, roomCode, senderId, epoch, salt) {
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  const cacheKey = `${roomCode}:${epoch}`;
  let baseKey = _iksCache.get(cacheKey);
  if (!baseKey) {
    const saltBytes = salt ? _b64FastDecode(salt) : new Uint8Array(32);
    baseKey = await _deriveBaseKeyWithSalt(roomCode, epoch, saltBytes);
    _iksCache.set(cacheKey, baseKey);
  }
  const CONCURRENCY = 4;
  const semaphore = _createSemaphore(CONCURRENCY);
  const results = new Array(sorted.length);

  await Promise.all(sorted.map((chunk, i) => async () => {
    const release = await semaphore.acquire();
    try {
      const buf = chunk.data instanceof Uint8Array ? chunk.data : new Uint8Array(chunk.data);
      if (buf.length < OVERHEAD_BYTES) throw new Error(`CORRUPT: chunk ${i} too small`);
      let off = 0;
      const vb = buf[off++];
      const compressed = (vb & 0x80) !== 0;
      const dv = new DataView(buf.buffer, buf.byteOffset + off);
      const epochStored = dv.getUint32(0, false); off += 4;
      const hi = dv.getUint32(4, false);
      const lo = dv.getUint32(8, false);
      const chunkTs = hi * 0x100000000 + lo; off += 8;
      const chunkIdx = dv.getUint32(12, false); off += 4;
      off += 4;
      const iv = buf.slice(off, off + 12); off += 12;
      const ct = buf.slice(off);
      if (chunkIdx !== chunk.index) throw new Error(`CORRUPT: chunk index mismatch ${chunkIdx} != ${chunk.index}`);
      const key = await _deriveMessageKey(baseKey, roomCode, epochStored, chunkTs, `chunk:${chunkIdx}`);
      const aad = _buildAAD(roomCode, senderId, epochStored, chunkTs, chunkIdx);
      let pt;
      try {
        pt = await crypto.subtle.decrypt({ name: AES_ALGO, iv, additionalData: aad }, key, ct);
      } catch { throw new Error(`DECRYPT: chunk ${i} authentication failed`); }
      const ptBytes = new Uint8Array(pt);
      results[i] = compressed ? await _decompress(ptBytes) : ptBytes;
    } finally { release(); }
  }).map(j => j()));

  let total = 0;
  for (const r of results) total += r.length;
  const assembled = new Uint8Array(total);
  let off = 0;
  for (const r of results) { assembled.set(r, off); off += r.length; }
  return assembled;
}

function _createSemaphore(max) {
  let active = 0;
  const queue = [];
  return {
    acquire() {
      return new Promise(resolve => {
        const tryAcquire = () => {
          if (active < max) { active++; resolve(() => { active--; if (queue.length) queue.shift()(); }); }
          else queue.push(tryAcquire);
        };
        tryAcquire();
      });
    }
  };
}

function clearKeyCache() { _iksCache.clear(); }

if (typeof window !== 'undefined') {
  window.MiutCrypto = { encryptText, decryptText, encryptFile, decryptFile, clearKeyCache, VERSION };
} else if (typeof self !== 'undefined') {
  self.MiutCrypto = { encryptText, decryptText, encryptFile, decryptFile, clearKeyCache, VERSION };
}
