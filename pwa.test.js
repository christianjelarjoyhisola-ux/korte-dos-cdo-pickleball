const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

for (const [file, route] of [['manifest.webmanifest', '/'], ['admin.webmanifest', '/admin'], ['host.webmanifest', '/host']]) {
  test(file + ' installs with distinct identity, standalone launch and real PNG icons', () => {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(manifest.id, route);
    assert.equal(manifest.start_url, route);
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.name && manifest.short_name);
    for (const size of ['192x192', '512x512']) assert.ok(manifest.icons.some(icon => icon.sizes === size && icon.purpose === 'any'));
    assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
    for (const icon of manifest.icons) {
      const bytes = fs.readFileSync('.' + icon.src);
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      assert.equal(bytes.readUInt32BE(16) + 'x' + bytes.readUInt32BE(20), icon.sizes);
    }
  });
}

test('booking, staff and host entry pages advertise their app and Apple home-screen icon', () => {
  for (const [page, manifest] of [['index.html', 'manifest.webmanifest'], ['admin.html', 'admin.webmanifest'], ['login.html', 'admin.webmanifest'], ['host.html', 'host.webmanifest']]) {
    const html = fs.readFileSync(page, 'utf8');
    assert.ok(html.includes('rel="manifest" href="/' + manifest + '"'));
    assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png"/);
    assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(html, /<script defer src="\/pwa\.js\?v=/);
  }
  const icon = fs.readFileSync('apple-touch-icon.png');
  assert.equal(icon.readUInt32BE(16), 180);
  assert.equal(icon.readUInt32BE(20), 180);
});

function workerHarness() {
  const listeners = {}, cached = new Map();
  const deleted = [], requests = [], precached = [];
  const context = {
    URL, Response,
    self: { location: { origin: 'https://kortedoscdo.club' }, addEventListener: (name, callback) => { listeners[name] = callback; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async () => ({ addAll: async paths => { precached.push(...paths); }, match: async path => cached.get(path) }), keys: async () => ['korte-dos-offline-v0', 'korte-dos-offline-v1', 'other-app'], delete: async name => { deleted.push(name); } },
    fetch: async (request, options) => { requests.push({ request, options }); return new Response('live'); },
  };
  vm.runInNewContext(fs.readFileSync('service-worker.js', 'utf8'), context);
  function dispatch(request) {
    let response;
    listeners.fetch({ request, respondWith: promise => { response = promise; } });
    return response;
  }
  return { listeners, context, cached, deleted, requests, precached, dispatch };
}

test('service worker precaches only a generic notice and icon, and cleans only its own old cache', async () => {
  const h = workerHarness(); let installing, activating;
  h.listeners.install({ waitUntil: p => { installing = p; } }); await installing;
  assert.deepEqual(h.precached, ['/offline.html', '/app-icon-192.png']);
  h.listeners.activate({ waitUntil: p => { activating = p; } }); await activating;
  assert.deepEqual(h.deleted, ['korte-dos-offline-v0']);
});

test('navigation always uses the network and falls back to a generic notice only when offline', async () => {
  const h = workerHarness();
  const request = { url: 'https://kortedoscdo.club/admin', method: 'GET', mode: 'navigate' };
  assert.equal(await (await h.dispatch(request)).text(), 'live');
  assert.equal(h.requests[0].options.cache, 'no-store');
  h.context.fetch = async () => { throw Error('offline'); };
  h.cached.set('/offline.html', new Response('Connect to the internet'));
  assert.equal(await (await h.dispatch(request)).text(), 'Connect to the internet');
  h.cached.clear();
  assert.equal((await h.dispatch(request)).status, 503);
});

test('payment POSTs, private reads, third-party APIs and application scripts are never intercepted', () => {
  const h = workerHarness();
  for (const request of [
    { url: 'https://kortedoscdo.club/pay', method: 'POST', mode: 'navigate' },
    { url: 'https://example.supabase.co/rest/v1/bookings', method: 'GET', mode: 'cors' },
    { url: 'https://kortedoscdo.club/api/bookings', method: 'GET', mode: 'cors' },
    { url: 'https://kortedoscdo.club/supabase-config.js', method: 'GET', mode: 'no-cors' },
  ]) assert.equal(h.dispatch(request), undefined);
  assert.equal(h.requests.length, 0);
});

test('registration fails harmlessly when service workers are unavailable and never forces a reload', async () => {
  const source = fs.readFileSync('pwa.js', 'utf8');
  vm.runInNewContext(source, { navigator: {}, window: {} });
  let registered = null;
  vm.runInNewContext(source, {
    navigator: { serviceWorker: { register: async (url, options) => { registered = { url, options }; } } },
    window: { isSecureContext: true }, document: { readyState: 'complete' }, console,
  });
  assert.equal(registered.url, '/service-worker.js');
  assert.equal(registered.options.scope, '/');
  assert.equal(registered.options.updateViaCache, 'none');
  assert.doesNotMatch(source, /location\.reload/);
});

test('production package includes every web-app asset with revalidation headers', () => {
  const deployment = fs.readFileSync('deploy-cloudflare-pages.ps1', 'utf8');
  for (const file of ['manifest.webmanifest', 'admin.webmanifest', 'host.webmanifest', 'pwa.js', 'service-worker.js', 'offline.html', 'apple-touch-icon.png', 'app-icon-192.png', 'app-icon-512.png', 'app-icon-maskable-512.png']) assert.ok(deployment.includes('"' + file + '"'), file);
  const headers = fs.readFileSync('_headers', 'utf8');
  assert.match(headers, /Content-Type: application\/manifest\+json/);
  assert.match(headers, /Service-Worker-Allowed: \//);
  assert.match(headers, /\/service-worker\.js[\s\S]*?Cache-Control: no-cache/);
});
