/* ═══════════════════════════════════════════════════════════
   Miut · sw-bridge.js
   Client-side Service Worker registration + message bridge.
   Include this AFTER app.js in index.html.
   ═══════════════════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────
   REGISTRATION
────────────────────────────────────────── */
(async function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  const swPath  = new URL('sw.js',  document.baseURI).pathname;
  const swScope = new URL('./',     document.baseURI).pathname;

  try {
    const reg = await navigator.serviceWorker.register(swPath, {
      scope:          swScope,
      updateViaCache: 'none',
    });


    reg.update();
    setInterval(() => reg.update(), 5 * 60 * 1000);

    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(newWorker);
        }
      });
    });

    if ('SyncManager' in window) window._bgSyncSupported = true;

    if (reg.periodicSync) {
      try {
        const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (status.state === 'granted') {
          await reg.periodicSync.register('miut-heartbeat', { minInterval: 5 * 60 * 1000 });
        }
      } catch {}
    }

    if (Notification.permission === 'granted') subscribeToPush(reg).catch(() => {});

  } catch (err) {
    console.error('[Bridge] SW registration failed:', err);
  }
})();

/* ──────────────────────────────────────────
   SW → APP MESSAGES
────────────────────────────────────────── */
navigator.serviceWorker.addEventListener('message', event => {
  const { type, version } = event.data || {};
  switch (type) {
    case 'SW_UPDATED':
      break;
    case 'DRAIN_OUTBOX':
    case 'SYNC_PRESENCE':
    case 'PERIODIC_HEARTBEAT':
      if (window.state && window.state.me && window.state.roomCode && window.db) {
        window.db.collection('rooms').doc(window.state.roomCode)
          .collection('members').doc(window.state.me.id)
          .update({ online: true }).catch(() => {});
      }
      break;
    case 'FOCUS_REPLY':
      setTimeout(() => document.getElementById('msg-input')?.focus(), 200);
      break;
  }
});

/* ──────────────────────────────────────────
   ONLINE / OFFLINE
────────────────────────────────────────── */
window.addEventListener('online', () => {
  if (typeof toast === 'function') toast('Back online', 'Connection restored', '◈');
  navigator.serviceWorker.ready.then(reg => {
    if (reg.sync) {
      reg.sync.register('miut-sync-messages').catch(() => {});
      reg.sync.register('miut-sync-presence').catch(() => {});
    }
  });
  if (typeof stopChatListeners === 'function' && window.state && window.state.roomCode) {
    stopChatListeners();
    startChatListeners();
  }
});

window.addEventListener('offline', () => {
  if (typeof toast === 'function') toast('Offline', 'Messages will send when reconnected', '—');
});

/* ──────────────────────────────────────────
   PUSH
────────────────────────────────────────── */
async function subscribeToPush(reg) {
  if (!('PushManager' in window)) return;
  if (await reg.pushManager.getSubscription()) return;
  const VAPID = 'BBcjg7g86hx_xP6kV45g8npzi_7_ECe1GvWF1joQzzWlKu5X31Qf1kHxBSz5Vfhr8aILCf9VJsLrbbwXu09FSE0';
  try {
    await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: (function(b64) {
        const pad = '='.repeat((4 - b64.length % 4) % 4);
        const raw = atob((b64 + pad).replace(/-/g,'+').replace(/_/g,'/'));
        return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
      })(VAPID),
    });
  } catch (e) { console.warn('[Bridge] Push subscribe failed:', e.message); }
}

/* ──────────────────────────────────────────
   UPDATE BANNER
────────────────────────────────────────── */
function showUpdateBanner(newWorker) {
  if (typeof toast === 'function') toast('Update available', 'Tap to reload', '⬡');
  document.getElementById('sw-update-banner')?.remove();
  const b = document.createElement('div');
  b.id = 'sw-update-banner';
  b.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--surface2,#1d3535);border:1px solid var(--teal,#4ecdc4);color:var(--text,#cce8e6);font-family:var(--font-ui,"Syne",sans-serif);font-size:.7rem;font-weight:700;letter-spacing:2px;padding:10px 20px;border-radius:100px;cursor:pointer;z-index:9998;white-space:nowrap;animation:fade-up .3s ease both';
  b.textContent = '⬡ UPDATE AVAILABLE — TAP TO RELOAD';
  b.onclick = () => { newWorker.postMessage({ type: 'SKIP_WAITING' }); window.location.reload(); };
  document.body.appendChild(b);
}

/* ──────────────────────────────────────────
   HOME SCREEN SHORTCUTS
────────────────────────────────────────── */
window.getSWVersion = async function() {
  if (!navigator.serviceWorker.controller) return null;
  return new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = e => resolve(e.data && e.data.version || null);
    navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
    setTimeout(() => resolve(null), 1000);
  });
};

