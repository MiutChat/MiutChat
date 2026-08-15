/* ═══════════════════════════════════════════════════════════════
   Miut · sw.js · Advanced Service Worker
   ── Strategies: Cache-First / Network-First / Stale-While-Revalidate
   ── Background Sync for queued messages
   ── Push Notifications with rich actions
   ── Periodic Background Sync for presence heartbeat
   ── IndexedDB offline message queue
   ── Precaching + runtime caching
   ── Skip-waiting + client claim
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────
   VERSIONS & CACHE NAMES
────────────────────────────────────────── */
const SW_VERSION      = '1.0.0';
const CACHE_SHELL     = `miut-shell-v${SW_VERSION}`;    // App shell (never stale)
const CACHE_STATIC    = `miut-static-v${SW_VERSION}`;   // Fonts, icons (long-lived)
const CACHE_RUNTIME   = `miut-runtime-v${SW_VERSION}`;  // Firebase responses, etc.
const CACHE_IMAGES    = `miut-images-v${SW_VERSION}`;   // User-sent images
const ALL_CACHES      = [CACHE_SHELL, CACHE_STATIC, CACHE_RUNTIME, CACHE_IMAGES];

const SYNC_TAG_MESSAGES  = 'miut-sync-messages';
const SYNC_TAG_PRESENCE  = 'miut-sync-presence';
const PERIODIC_SYNC_TAG  = 'miut-heartbeat';
const DB_NAME            = 'miut-offline-db';
const DB_VERSION         = 1;
const STORE_OUTBOX       = 'outbox';
const STORE_PRESENCE     = 'presence';

/* ──────────────────────────────────────────
   PRECACHE MANIFEST
   REQUIRED: must exist or SW install fails.
   OPTIONAL: cached if present, silently skipped if missing.
   NOTE: Relative paths work under any subdirectory (GitHub Pages).
────────────────────────────────────────── */
// Dynamic base path — handles both Cloudflare Pages (scope='/') and
// GitHub Pages (scope='/Miut/') without any code change on deploy.
const BASE = (() => {
  try { return new URL(self.registration.scope).pathname; }
  catch { return '/'; }
})();

const PRECACHE_REQUIRED = [
  BASE,
  BASE + 'style.min.css',
  BASE + 'app.min.js',
  BASE + 'db-manager.min.js',
  BASE + 'sw-bridge.min.js',
  BASE + 'manifest.json',
];

// Silently skipped if missing.
const PRECACHE_OPTIONAL = [
  BASE + 'offline.html',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  BASE + 'icons/icon-maskable-192.png',
  BASE + 'icons/icon-maskable-512.png',
];

/* ──────────────────────────────────────────
   ROUTE PATTERNS
────────────────────────────────────────── */
const FIREBASE_HOSTS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const CDN_HOSTS  = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];
// Firebase SDK scripts come from gstatic but must be treated as network-only (not cached)
// so they always get fresh copies and are never intercepted with stale CSP contexts.
const FIREBASE_SDK_HOST = 'www.gstatic.com';

function isFirebase(url)  { return FIREBASE_HOSTS.some(h => url.hostname.includes(h)); }
function isFont(url)      { return FONT_HOSTS.some(h => url.hostname.includes(h)); }
function isCDN(url)       { return CDN_HOSTS.some(h => url.hostname.includes(h)); }
function isFirebaseSDK(url) { return url.hostname === FIREBASE_SDK_HOST; }
function isShell(url)     { return url.origin === self.location.origin; }
function isImage(req)     { return req.destination === 'image'; }
function isNavigation(req){ return req.mode === 'navigate'; }

/* ══════════════════════════════════════════
   INSTALL — precache shell
══════════════════════════════════════════ */
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_SHELL);

      // Required assets — use individual fetch+put so a single 404 never aborts install
      await Promise.allSettled(
        PRECACHE_REQUIRED.map(async url => {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (res.ok) {
              await cache.put(url, res);
            } else {
              console.warn(`[SW] Precache skipped (${res.status}): ${url}`);
            }
          } catch (err) {
            console.warn(`[SW] Precache failed: ${url}`, err.message);
          }
        })
      );

      // Optional assets — completely silent on any failure
      await Promise.allSettled(
        PRECACHE_OPTIONAL.map(async url => {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (res.ok) await cache.put(url, res);
          } catch { /* silent */ }
        })
      );

      // Force immediate activation to replace any stale SW (e.g. one with broken CSP headers).
      await self.skipWaiting();
    })()
  );
});

/* ══════════════════════════════════════════
   ACTIVATE — prune old caches
══════════════════════════════════════════ */
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Delete all caches NOT in our current list
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(key => !ALL_CACHES.includes(key))
          .map(key => {
            return caches.delete(key);
          })
      );

      // Take control of all existing clients immediately
      await self.clients.claim();

      // Register periodic sync if supported and permitted
      if (self.registration.periodicSync) {
        try {
          await self.registration.periodicSync.register(PERIODIC_SYNC_TAG, {
            minInterval: 5 * 60 * 1000,
          });
        } catch {
          // Expected on most browsers — requires "periodic-background-sync" permission
          // which is only granted for installed PWAs on Android Chrome. Not an error.
        }
      }

      // Notify all clients about the update
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client =>
        client.postMessage({ type: 'SW_UPDATED', version: SW_VERSION })
      );

    })()
  );
});

/* ══════════════════════════════════════════
   FETCH — routing & caching strategies
══════════════════════════════════════════ */
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // ── Only intercept same-origin requests ──────────────────────────────────────
  // External fetches (fonts, Firebase SDKs, APIs) must pass through unmodified.
  // If the SW calls fetch() on external URLs, the page CSP applies to the SW
  // context and blocks them with connect-src violations. The browser handles
  // external requests natively without CSP interference when we don't intercept.
  if (url.origin !== self.location.origin) {
    return; // do not call event.respondWith() — browser handles it directly
  }

  // Never intercept non-GET except for POST to share-target
  if (req.method !== 'GET') {
    if (req.method === 'POST' && url.pathname === '/share-target') {
      event.respondWith(handleShareTarget(req));
    }
    return;
  }

  // Images — Cache First with fallback
  if (isImage(req)) {
    event.respondWith(cacheFirst(req, CACHE_IMAGES, { ttl: 7 * 24 * 60 * 60 }));
    return;
  }

  // Navigation (HTML pages) — Network First, fallback to shell or offline page
  if (isNavigation(req)) {
    event.respondWith(navigationHandler(req));
    return;
  }

  // Own origin JS/CSS — Network First for app.js and sw-bridge.js (critical — always fresh)
  // Style.css and others use stale-while-revalidate (fine to be 1-load stale)
  if (isShell(url) && (url.pathname.endsWith('app.js') || url.pathname.endsWith('sw-bridge.js'))) {
    event.respondWith(networkFirst(req, CACHE_SHELL));
    return;
  }

  // Own origin other JS/CSS — Stale-While-Revalidate (fast + always updating)
  if (isShell(url) && (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
    event.respondWith(staleWhileRevalidate(req, CACHE_SHELL));
    return;
  }

  // Own origin static assets — Cache First
  if (isShell(url)) {
    event.respondWith(cacheFirst(req, CACHE_SHELL));
    return;
  }

  // Everything else — Network First with runtime cache fallback
  event.respondWith(networkFirst(req, CACHE_RUNTIME, { ttl: 24 * 60 * 60 }));
});

/* ──────────────────────────────────────────
   CACHING STRATEGIES
────────────────────────────────────────── */

// Always go to network, no caching
async function networkOnly(req) {
  try {
    return await fetch(req);
  } catch {
    return new Response('{"offline":true}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Cache first, network fallback, optional TTL check
async function cacheFirst(req, cacheName, { ttl } = {}) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(req);
  if (cached) {
    // TTL check via Date header
    if (ttl) {
      const dateHeader = cached.headers.get('date');
      if (dateHeader) {
        const age = (Date.now() - new Date(dateHeader).getTime()) / 1000;
        if (age > ttl) {
          // Revalidate in background, serve stale now
          fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); }).catch(() => {});
        }
      }
    }
    return cached;
  }
  try {
    const response = await fetch(req);
    if (response.ok && response.status !== 206) {
      cache.put(req, response.clone());
    }
    return response;
  } catch {
    return cached || offlineFallback(req);
  }
}

// Network first, cache fallback
async function networkFirst(req, cacheName, { ttl } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(req);
    if (response.ok) {
      cache.put(req, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(req);
    return cached || offlineFallback(req);
  }
}

// Serve cache instantly, update in background
async function staleWhileRevalidate(req, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);

  const networkFetch = fetch(req).then(response => {
    if (response.ok) cache.put(req, response.clone());
    return response;
  }).catch(() => null);

  return cached || await networkFetch || offlineFallback(req);
}

// Navigation with shell fallback
async function navigationHandler(req) {
  try {
    const response = await fetch(req);
    if (response.ok) {
      const cache = await caches.open(CACHE_SHELL);
      cache.put(req, response.clone());
    }
    return response;
  } catch {
    // Try exact URL, then root shell
    const cache  = await caches.open(CACHE_SHELL);
    const cached = await cache.match(req) ||
                   await cache.match(new URL('./index.html', self.location).href) ||
                   await cache.match(new URL('./', self.location).href);
    if (cached) return cached;

    // Last resort: offline page
    const offline = await cache.match('/offline.html');
    return offline || new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>NEXUS · Offline</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d1a1a;color:#4ecdc4;font-family:'Space Mono',monospace;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}.wrap{display:flex;flex-direction:column;gap:16px;align-items:center}.hex{font-size:3rem;animation:pulse 2s infinite}@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}h1{font-size:1.4rem;letter-spacing:6px}p{font-size:.75rem;color:#6a9896;line-height:1.7}</style>
      </head><body><div class="wrap">
        <div class="hex">⬡</div>
        <h1>NEXUS</h1>
        <p>You are currently offline.<br/>Reconnect to access your rooms.</p>
      </div></body></html>`,
      { status: 503, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

function offlineFallback(req) {
  if (req.destination === 'image') {
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect width="100" height="100" fill="#182e2e"/>
        <text x="50" y="55" text-anchor="middle" fill="#4ecdc4" font-size="14" font-family="monospace">OFFLINE</text>
      </svg>`,
      { headers: { 'Content-Type': 'image/svg+xml' } }
    );
  }
  return new Response('{"error":"offline"}', {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

/* ══════════════════════════════════════════
   SHARE TARGET handler
══════════════════════════════════════════ */
async function handleShareTarget(req) {
  const formData = await req.formData().catch(() => null);
  if (!formData) return Response.redirect('/', 303);

  const text  = formData.get('text')  || '';
  const title = formData.get('title') || '';
  const url   = formData.get('url')   || '';
  const shared = encodeURIComponent([title, text, url].filter(Boolean).join('\n'));

  // Store in IDB for the app to pick up
  await idbSet('shared-content', { text, title, url, ts: Date.now() });

  return Response.redirect(`/?shared=${shared}`, 303);
}

/* ══════════════════════════════════════════
   BACKGROUND SYNC — outbox drain
══════════════════════════════════════════ */
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG_MESSAGES) {
    event.waitUntil(drainOutbox());
  }
  if (event.tag === SYNC_TAG_PRESENCE) {
    event.waitUntil(syncPresence());
  }
});

async function drainOutbox() {
  const messages = await idbGetAll(STORE_OUTBOX);
  if (!messages.length) return;


  for (const msg of messages) {
    try {
      // Notify the open client to actually send via Firebase SDK
      const clients = await self.clients.matchAll({ type: 'window' });
      if (clients.length > 0) {
        clients[0].postMessage({ type: 'DRAIN_OUTBOX', message: msg });
        await idbDelete(STORE_OUTBOX, msg.id);
      }
    } catch (err) {
      console.warn('[SW] Failed to drain message', err);
    }
  }
}

async function syncPresence() {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'SYNC_PRESENCE' }));
}

/* ══════════════════════════════════════════
   PERIODIC BACKGROUND SYNC — heartbeat
══════════════════════════════════════════ */
self.addEventListener('periodicsync', event => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({ type: 'window' });
        if (clients.length > 0) {
          clients.forEach(c => c.postMessage({ type: 'PERIODIC_HEARTBEAT' }));
        }
      })()
    );
  }
});

/* ══════════════════════════════════════════
   PUSH NOTIFICATIONS — rich with actions
══════════════════════════════════════════ */
self.addEventListener('push', event => {
  let data = { title: 'NEXUS', body: 'New message received', type: 'message' };

  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body:    data.body,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-72.png',
    image:   data.image  || undefined,
    tag:     data.roomCode || 'miut-notification',
    renotify: true,
    silent:  false,
    vibrate: [100, 50, 100, 50, 100],
    timestamp: Date.now(),
    requireInteraction: data.type === 'call',

    data: {
      url:      data.url      || '/',
      roomCode: data.roomCode || '',
      senderId: data.senderId || '',
      type:     data.type     || 'message',
    },

    actions: data.type === 'call'
      ? [
          { action: 'accept', title: 'Accept',  icon: '/icons/action-accept.png' },
          { action: 'decline', title: 'Decline', icon: '/icons/action-decline.png' },
        ]
      : [
          { action: 'reply',   title: 'Reply',       icon: '/icons/action-reply.png' },
          { action: 'dismiss', title: 'Dismiss',      icon: '/icons/action-dismiss.png' },
        ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

/* ──────────────────────────────────────────
   NOTIFICATION CLICK / CLOSE
────────────────────────────────────────── */
self.addEventListener('notificationclick', event => {
  const notification = event.notification;
  const action       = event.action;
  const data         = notification.data || {};

  notification.close();

  if (action === 'dismiss') return;

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      // If there's an open window, focus it and post a message
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type:     action === 'accept' ? 'CALL_ACCEPT' : action === 'reply' ? 'FOCUS_REPLY' : 'OPEN_ROOM',
            roomCode: data.roomCode,
            senderId: data.senderId,
          });
          return;
        }
      }

      // No open window — open a new one
      const targetUrl = data.roomCode
        ? `/?roomCode=${data.roomCode}&source=notification`
        : '/';
      await self.clients.openWindow(targetUrl);
    })()
  );
});

self.addEventListener('notificationclose', event => {
  // Analytics: track dismissed notifications
  const data = event.notification.data || {};
  const clients_p = self.clients.matchAll({ type: 'window' });
  clients_p.then(clients =>
    clients.forEach(c => c.postMessage({ type: 'NOTIFICATION_DISMISSED', data }))
  );
});

/* ══════════════════════════════════════════
   MESSAGE — commands from app clients
══════════════════════════════════════════ */
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch (type) {

    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'QUEUE_MESSAGE':
      // Store outbox message for background sync
      idbPut(STORE_OUTBOX, payload).then(() => {
        if (self.registration.sync) {
          self.registration.sync.register(SYNC_TAG_MESSAGES).catch(() => {});
        }
      });
      break;

    case 'QUEUE_PRESENCE':
      idbPut(STORE_PRESENCE, payload).then(() => {
        if (self.registration.sync) {
          self.registration.sync.register(SYNC_TAG_PRESENCE).catch(() => {});
        }
      });
      break;

    case 'CACHE_URLS':
      // Dynamically cache a list of URLs sent from the app
      if (Array.isArray(payload)) {
        caches.open(CACHE_RUNTIME).then(cache => cache.addAll(payload).catch(() => {}));
      }
      break;

    case 'CLEAR_CACHE':
      caches.delete(CACHE_RUNTIME).then(() =>
        event.source?.postMessage({ type: 'CACHE_CLEARED' })
      );
      break;

    case 'GET_VERSION':
      event.source?.postMessage({ type: 'SW_VERSION', version: SW_VERSION });
      break;

    case 'PRECACHE_ROOM':
      // Pre-warm cache when user enters a room
      if (payload?.assets) {
        caches.open(CACHE_RUNTIME).then(cache =>
          Promise.allSettled(payload.assets.map(u => cache.add(u)))
        );
      }
      break;
  }
});

/* ══════════════════════════════════════════
   IndexedDB HELPERS (lightweight, no deps)
══════════════════════════════════════════ */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const store = db.createObjectStore(STORE_OUTBOX, { keyPath: 'id' });
        store.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PRESENCE)) {
        db.createObjectStore(STORE_PRESENCE, { keyPath: 'uid' });
      }
      // Generic KV store for misc data (shared content, etc.)
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };

    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

async function idbPut(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

async function idbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = e => resolve(e.target.result || []);
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ key, value });
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = e => resolve(e.target.result?.value ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

/* ══════════════════════════════════════════
   UTILITY
══════════════════════════════════════════ */
// Broadcast to all window clients
async function broadcastToClients(message) {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage(message));
}

