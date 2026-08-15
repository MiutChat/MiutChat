'use strict';
(function(W) {
  let _worker = null;
  let _pending = new Map();
  let _id = 0;
  let _useWorker = false;
  let _initPromise = null;

  function _ensureWorker() {
    if (_worker) return;
    try {
      _worker = new Worker('crypto-worker.js');
      _worker.onmessage = (e) => {
        const { id, ok, result, error, progress, chunkIndex, totalChunks } = e.data;
        const p = _pending.get(id);
        if (!p) return;
        if (progress !== undefined) { p.onProgress?.(progress, chunkIndex, totalChunks); return; }
        _pending.delete(id);
        ok ? p.resolve(result) : p.reject(new Error(error));
      };
      _worker.onerror = (e) => {
        for (const [, p] of _pending) p.reject(new Error('Worker error: ' + e.message));
        _pending.clear();
        _worker = null;
      };
      _useWorker = true;
    } catch { _useWorker = false; }
  }

  function _call(op, args, transfers, onProgress) {
    if (!_useWorker || !_worker) {
      if (!W.MiutCrypto) throw new Error('MiutCrypto not loaded');
      const C = W.MiutCrypto;
      const map = { encryptText: C.encryptText, decryptText: C.decryptText, encryptFile: C.encryptFile, decryptFile: C.decryptFile };
      if (op === 'encryptFile') return map[op](...args.slice(0, 6), onProgress);
      return map[op](...args);
    }
    return new Promise((resolve, reject) => {
      const id = ++_id;
      _pending.set(id, { resolve, reject, onProgress });
      _worker.postMessage({ id, op, args }, transfers || []);
    });
  }

  async function init() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      _ensureWorker();
      if (!W.MiutCrypto) {
        await new Promise(r => {
          if (W.MiutCrypto) return r();
          const check = setInterval(() => { if (W.MiutCrypto) { clearInterval(check); r(); } }, 50);
          setTimeout(() => { clearInterval(check); r(); }, 3000);
        });
      }
    })();
    return _initPromise;
  }

  W.MiutCryptoBridge = {
    init,
    encryptText: (t, rc, sid, ep, salt) => _call('encryptText', [t, rc, sid, ep, salt]),
    decryptText: (b, rc, sid, ep, salt) => _call('decryptText', [b, rc, sid, ep, salt]),
    encryptFile: (f, meta, rc, sid, ep, salt, onProg) => _call('encryptFile', [f, meta, rc, sid, ep, salt], [], onProg),
    decryptFile: (chunks, rc, sid, ep, salt) => _call('decryptFile', [chunks, rc, sid, ep, salt]),
  };
})(window);
