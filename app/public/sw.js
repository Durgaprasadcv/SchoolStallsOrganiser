// Stall Day service worker: opens offline on weak school Wi-Fi, and shows push notifications.
// Data always comes live from Supabase (never cached here) so stock and orders are never stale.
const CACHE = 'stallday-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png'])));
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

const keep = (req, res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; };

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // Supabase, fonts, WhatsApp: straight to the network
  if (req.mode === 'navigate') {
    // every route is the same index.html: network first, cached copy when offline
    e.respondWith(fetch(req).then(res => keep('/', res)).catch(() => caches.match('/')));
  } else if (url.pathname.startsWith('/assets/')) {
    // hashed build files never change: cache first
    // ponytail: old hashed files pile up until CACHE is bumped; a few hundred KB per deploy
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => keep(req, res))));
  }
});

self.addEventListener('push', e => {
  const d = (() => { try { return e.data.json(); } catch { return { title: 'Stall Day', body: e.data ? e.data.text() : '' }; } })();
  e.waitUntil(self.registration.showNotification(d.title || 'Stall Day', {
    body: d.body, tag: d.tag, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' }, vibrate: [200, 100, 200],
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find(w => w.url === url) || wins[0];
    if (same) { await same.focus(); if (same.url !== url) await same.navigate(url); } else await self.clients.openWindow(url);
  })());
});
