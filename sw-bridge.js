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

  // build.js stamps the real release version into SW_VERSION (and
  // therefore the cache names) ONLY in the built sw.min.js output — the
  // raw sw.js checked into source always has the literal placeholder
  // '1.0.0' hardcoded. Registering sw.js directly meant the cache name
  // never changed across a single deploy of this app: the service worker
  // kept re-registering under the exact same cache keys every time,
  // so updated app.js/security.js/etc could sit cached indefinitely
  // regardless of how many real releases shipped. This is almost
  // certainly why fixes have appeared to "come back" repeatedly.
  const swPath  = new URL('sw.min.js',  document.baseURI).pathname;
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

    // Returning visitor who already granted notification permission in an
    // earlier session: silently (re)create the browser-level push
    // subscription now (this needs no room — it's per-browser, not
    // per-room). Saving that subscription onto the CURRENT room's member
    // doc happens separately, once a room is actually joined — see
    // window.syncPushSubscriptionForRoom, called from app.js right after
    // chat listeners start.
    if (Notification.permission === 'granted') ensureSubscription(reg).catch(() => {});

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
      // NOTE: app.js's `state`/`db` are top-level `let` in a classic
      // (non-module) script — those never become window.state/window.db
      // properties (only `var`/function declarations do), even though
      // every classic <script> on the page shares one global lexical
      // scope, so the bare names work here. This used to read
      // window.state/window.db and silently no-op every time — verified
      // with a real headless-browser check, not assumed.
      if (typeof state !== 'undefined' && state?.me && state?.roomCode && typeof db !== 'undefined' && db) {
        db.collection('rooms').doc(state.roomCode)
          .collection('members').doc(state.me.id)
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
  if (typeof stopChatListeners === 'function' && typeof state !== 'undefined' && state?.roomCode) {
    stopChatListeners();
    startChatListeners();
  }
});

window.addEventListener('offline', () => {
  if (typeof toast === 'function') toast('Offline', 'Messages will send when reconnected', '—');
});

/* ──────────────────────────────────────────
   PUSH
   Three layers, kept deliberately separate:
     1. ensureSubscription(reg)  — browser-level only. Creates (or reuses)
        the PushManager subscription. No room/Firestore involved — this
        is the same subscription across every room a person joins in this
        browser.
     2. saveSubscriptionForRoom(sub) — writes that subscription onto the
        CURRENT room's own member doc (rooms/{code}/members/{uid}
        .pushSubscription), which is what /api/notify reads server-side
        to know who to push to for messages in that specific room.
     3. window.requestPushPermission() / window.disablePush() — the two
        entry points app.js calls: the one-time post-first-message prompt
        and the Settings toggle.
────────────────────────────────────────── */
const VAPID_PUBLIC_KEY = 'BFcDPBMrMGLLi_7bMcZAMmwdjU2ZVduK3XaIZao3UXJ0JukXbWFzYhpQm-qD9thW-NyNhlbVStIqVKLoaAJU4yI';

function _b64urlToBytes(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function ensureSubscription(reg) {
  if (!('PushManager' in window)) return null;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({
    userVisibleOnly:      true,
    applicationServerKey: _b64urlToBytes(VAPID_PUBLIC_KEY),
  });
}

async function saveSubscriptionForRoom(sub) {
  // Bare `state`/`db`, not window.state/window.db — see the note on the
  // SYNC_PRESENCE handler above for why.
  const st = typeof state !== 'undefined' ? state : null;
  const database = typeof db !== 'undefined' ? db : null;
  if (!sub || !st?.me?.id || !st?.roomCode || !database) return;
  try {
    await database.collection('rooms').doc(st.roomCode)
      .collection('members').doc(st.me.id)
      .update({ pushSubscription: sub.toJSON() });
  } catch (e) { console.warn('[Bridge] Failed to save push subscription:', e.message); }
}

// Called once a room is actually joined (from app.js, right after chat
// listeners start) — covers the "already granted in an earlier session"
// case, where ensureSubscription() ran silently at page load with no
// room to attach it to yet.
window.syncPushSubscriptionForRoom = async function() {
  // Browser permission alone isn't enough — it can never go back to
  // "off" once granted, so it can't tell "never asked" apart from "the
  // person explicitly switched the Settings toggle off." pushEnabled is
  // app.js's own record of which of those it actually is; without this
  // check, turning the toggle off only lasted until the next room join,
  // which silently resubscribed anyway.
  const st = typeof state !== 'undefined' ? state : null;
  if (Notification.permission !== 'granted' || !st?.prefs?.pushEnabled) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await ensureSubscription(reg);
    await saveSubscriptionForRoom(sub);
  } catch {}
};

// The one UI entry point that actually asks the browser for permission —
// called exactly once ever, right after a person's first sent message
// (see app.js), and again from the Settings toggle if they turn it on
// later after having left it off.
window.requestPushPermission = async function() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'unsupported';
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm; // 'denied' — nothing more we can do from here
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await ensureSubscription(reg);
    await saveSubscriptionForRoom(sub);
  } catch (e) { console.warn('[Bridge] Push subscribe failed:', e.message); }
  return 'granted';
};

// Settings toggle "off" — unsubscribes at the browser level and clears
// the saved subscription from the current room's member doc. Does NOT
// (can't) revoke the OS-level notification permission itself; that's the
// browser's own setting if someone wants to fully reset it.
window.disablePush = async function() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch {}
  const st = typeof state !== 'undefined' ? state : null;
  const database = typeof db !== 'undefined' ? db : null;
  if (st?.me?.id && st?.roomCode && database) {
    database.collection('rooms').doc(st.roomCode).collection('members').doc(st.me.id)
      .update({ pushSubscription: null }).catch(() => {});
  }
};

/* ──────────────────────────────────────────
   UPDATE BANNER
────────────────────────────────────────── */
function showUpdateBanner(newWorker) {
  // This used to ALSO call toast(...) here, showing a toast AND this custom
  // banner for the same single update event — two stacked "Update
  // available" notifications for one thing. This banner is the intended,
  // persistent presentation (a reload prompt shouldn't auto-dismiss like a
  // toast does), so that's the one that stays; the toast call is gone.
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

