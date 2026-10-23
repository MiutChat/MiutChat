'use strict';
const CHUNK_COLL = 'chunks';
const MAX_BATCH = 499;
const MAX_RETRY = 3;
const RETRY_BASE_MS = 400;

async function _retryOp(fn) {
  let lastErr;
  for (let i = 0; i < MAX_RETRY; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (e?.code === 'permission-denied' || e?.code === 'unauthenticated') throw e;
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, i) + Math.random() * 200));
    }
  }
  throw lastErr;
}

function _toFirestoreBytes(uint8) {
  return { _type: 'bytes', data: Array.from(uint8) };
}

function _fromFirestoreBytes(field) {
  if (field instanceof Uint8Array) return field;
  if (field?._type === 'bytes') return new Uint8Array(field.data);
  if (field instanceof ArrayBuffer) return new Uint8Array(field);
  throw new Error('Cannot decode bytes field');
}

async function writeEncryptedText(db, roomCode, msgId, encResult) {
  const { data, senderId, epoch, timestamp } = encResult;
  const docRef = db.collection('rooms').doc(roomCode).collection('messages').doc(msgId);
  await _retryOp(() => docRef.set({
    v: 3,
    t: 'text',
    enc: firebase.firestore.Blob.fromUint8Array(data),
    sid: senderId,
    ep: epoch,
    ts: timestamp,
    ca: firebase.firestore.FieldValue.serverTimestamp(),
  }));
  return { docId: msgId, bytes: data.length };
}

async function writeEncryptedFile(db, roomCode, groupId, encResult, metadata) {
  const { chunks, metadata: meta } = encResult;
  const total = chunks.length;
  if (total === 0) throw new Error('No chunks to write');
  for (const chunk of chunks) {
    if (chunk.size > 1_048_576) throw new Error(`OVERFLOW: chunk ${chunk.index} is ${chunk.size} bytes`);
  }
  const BATCH_SIZE = Math.min(Math.floor(MAX_BATCH / 2), 100);
  const written = [];
  for (let b = 0; b < total; b += BATCH_SIZE) {
    const slice = chunks.slice(b, b + BATCH_SIZE);
    await _retryOp(async () => {
      const batch = db.batch();
      for (const chunk of slice) {
        const ref = db.collection('rooms').doc(roomCode)
          .collection('messages').doc(`${groupId}_c${chunk.index}`);
        batch.set(ref, {
          v: 3,
          t: b === 0 && chunk.index === 0 ? meta.mime : 'chunk',
          gid: groupId,
          ci: chunk.index,
          ct: total,
          fn: meta.name,
          fs: meta.size,
          enc: firebase.firestore.Blob.fromUint8Array(chunk.data),
          sid: meta.senderId,
          ep: meta.epoch,
          ts: meta.timestamp + chunk.index,
          ca: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    });
    for (const c of slice) written.push(c.index);
  }
  return { groupId, totalChunks: total, writtenChunks: written.length, metadata: meta };
}

async function readEncryptedText(db, roomCode, msgId) {
  const snap = await _retryOp(() =>
    db.collection('rooms').doc(roomCode).collection('messages').doc(msgId).get()
  );
  if (!snap.exists) throw new Error(`Message ${msgId} not found`);
  const d = snap.data();
  const enc = d.enc;
  let bytes;
  if (enc && typeof enc.toUint8Array === 'function') bytes = enc.toUint8Array();
  else if (enc instanceof Uint8Array) bytes = enc;
  else throw new Error('Cannot read encrypted field');
  return { data: bytes, senderId: d.sid, epoch: d.ep, timestamp: d.ts };
}

async function readEncryptedFile(db, roomCode, groupId) {
  const snap = await _retryOp(() =>
    db.collection('rooms').doc(roomCode).collection('messages')
      .where('gid', '==', groupId)
      .orderBy('ci', 'asc')
      .get()
  );
  if (snap.empty) throw new Error(`Group ${groupId} not found`);
  const chunks = snap.docs.map(doc => {
    const d = doc.data();
    let enc = d.enc;
    let bytes;
    if (enc && typeof enc.toUint8Array === 'function') bytes = enc.toUint8Array();
    else if (enc instanceof Uint8Array) bytes = enc;
    else throw new Error(`Cannot read chunk ${d.ci}`);
    return { index: d.ci, data: bytes, epoch: d.ep, timestamp: d.ts, senderId: d.sid };
  });
  const meta = (() => {
    const d = snap.docs[0].data();
    return { name: d.fn, mime: d.t, size: d.fs, totalChunks: d.ct, senderId: d.sid, epoch: d.ep };
  })();
  return { chunks, metadata: meta };
}

if (typeof window !== 'undefined') {
  window.MiutStorage = { writeEncryptedText, writeEncryptedFile, readEncryptedText, readEncryptedFile };
}
