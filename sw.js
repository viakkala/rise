// Rise service worker: offline app shell.
// Bump CACHE when you change index.html so installed copies pick up the update.
const CACHE = 'rise-v11';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate for same-origin GETs; navigations fall back to the cached shell offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      const network = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => null);
      if (cached) { event.waitUntil(network); return cached; }
      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    })
  );
});

// Task reminders sent by the scheduled GitHub job (scripts/notify.mjs).
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Rise', {
    body: d.body || 'Your list for today is ready.',
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    tag: d.tag || 'rise',
    renotify: true,
    data: { url: d.url || './index.html' }
  }));
});

// Tapping a reminder opens Rise, or brings it to the front if it's already open.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './index.html', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(target);
  }));
});
