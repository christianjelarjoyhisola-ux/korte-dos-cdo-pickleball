/* Only a generic offline notice is cached. Never cache bookings, accounts,
   payment requests, API responses, or application HTML/JavaScript here. */
const OFFLINE_CACHE = 'korte-dos-offline-v1';
const OFFLINE_PAGE = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.addAll([OFFLINE_PAGE, '/app-icon-192.png']);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('korte-dos-offline-') && name !== OFFLINE_CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      const fallback = await cache.match(OFFLINE_PAGE);
      return fallback || new Response('You are offline. Reconnect to use Korte DOS.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }));
  } else if (url.pathname === '/app-icon-192.png' && !url.search) {
    event.respondWith((async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      return (await cache.match('/app-icon-192.png')) || fetch(request);
    })());
  }
});

// Never render arbitrary payload text or links on the lock screen.
self.addEventListener('push', event => {
  let test = false;
  try { test = event.data?.json()?.type === 'test'; } catch (_) {}
  event.waitUntil(self.registration.showNotification('Korte DOS', {
    body: test ? 'Phone notifications are working on this device.' : 'A payment needs review. Sign in to view the details.',
    icon: '/app-icon-192.png', badge: '/app-icon-192.png',
    tag: test ? 'korte-dos-test' : 'korte-dos-payment-review',
    data: { test },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.test ? '/admin?section=notifications' : '/admin?section=payreview', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && /^\/admin(?:\.html)?$/.test(new URL(client.url).pathname)) {
        await client.navigate(url); await client.focus(); return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
