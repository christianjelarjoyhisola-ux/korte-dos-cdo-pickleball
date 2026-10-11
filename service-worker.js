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
