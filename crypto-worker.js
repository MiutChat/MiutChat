'use strict';
importScripts('crypto-engine.js');
self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const C = self.MiutCrypto;
    let result;
    if (op === 'encryptText')  result = await C.encryptText(...args);
    else if (op === 'decryptText')  result = await C.decryptText(...args);
    else if (op === 'encryptFile') {
      const [file, meta, rc, sid, ep, salt] = args;
      result = await C.encryptFile(file, meta, rc, sid, ep, salt, (pct, ci, ct) => {
        self.postMessage({ id, progress: pct, chunkIndex: ci, totalChunks: ct });
      });
    } else if (op === 'decryptFile') result = await C.decryptFile(...args);
    else throw new Error('Unknown op: ' + op);
    const transfers = [];
    if (result?.data?.buffer) transfers.push(result.data.buffer);
    if (result?.chunks) {
      for (const c of result.chunks) if (c?.data?.buffer) transfers.push(c.data.buffer);
    }
    if (result instanceof Uint8Array) transfers.push(result.buffer);
    self.postMessage({ id, ok: true, result }, transfers);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
