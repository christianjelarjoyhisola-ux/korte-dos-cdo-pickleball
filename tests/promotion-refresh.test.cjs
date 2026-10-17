const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const live = require('../realtime-refresh.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  let now = Date.parse('2026-10-18T04:00:00Z'), id = 0;
  const timers = new Map(), requests = [], applied = [], cleared = [];
  const source = fs.readFileSync('index.html', 'utf8');
  const context = {
    Date: class extends Date { static now() { return now; } },
    RealtimeRefresh: { ...live, createDiscoveryCache: config => live.createDiscoveryCache({ ...config, now: () => now }) },
    document: { hidden: false },
    _featuredDealOffers: [], _featuredCourtPick: null, _featuredDealInitialized: true,
    normalizedFeaturedCourtPick: value => value?.expiresAt && Date.parse(value.expiresAt) <= now ? null : value,
    renderFeaturedCourtDeal: value => { context._featuredDealOffers = value; applied.push(['deals', value]); },
    renderFeaturedCourtPick: value => { context._featuredCourtPick = value; applied.push(['pick', value]); },
    BookingDemandCampaign: { loadFeaturedOffers: async args => { requests.push(['deals', args]); return await options.deals?.(args) || []; } },
    DB: {
      clearCache: scopes => cleared.push([...scopes]),
      getPublicFeaturedCourtHour: async args => { requests.push(['pick', args]); return await options.pick?.(args) || null; },
    },
    setTimeout(callback, delay) { timers.set(++id, { callback, at: now + delay }); return id; },
    clearTimeout(key) { timers.delete(key); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('let _promotionDiscoveryCaches'), source.indexOf('function courtPickDeepLinkToken()')), context);
  return {
    context, requests, applied, cleared, timers,
    advance(ms) { now += ms; },
    async nextTimer() {
      const [key, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(key); now = Math.max(now, timer.at); timer.callback(); await tick();
    },
  };
}

test('periodic discovery reads both endpoints once per five minutes, including cached empty results', async () => {
  const h = harness();
  await h.context.refreshFeaturedPromotions();
  assert.equal(h.requests.length, 2);
  for (let minute = 1; minute < 5; minute++) {
    h.advance(60000);
    await h.context.refreshFeaturedPromotions();
  }
  assert.equal(h.requests.length, 2, 'normal realtime/visibility calls reuse the discovery result');
  await h.nextTimer();
  assert.equal(h.requests.length, 4);
  for (let cycle = 0; cycle < 11; cycle++) await h.nextTimer();
  assert.equal(h.requests.length, 26, 'initial pair plus 24 periodic requests in one hour');
});

test('overlapping discovery calls share requests; unrelated booking changes do not force discovery', async () => {
  const read = deferred();
  const offer = { date: '2026-10-18', courtId: '1', slotHour: 15 };
  const h = harness({ deals: () => read.promise });
  const first = h.context.refreshFeaturedPromotions();
  const second = h.context.refreshFeaturedPromotions();
  await tick();
  assert.equal(h.requests.length, 2);
  read.resolve([offer]); await Promise.all([first, second]);
  h.context.invalidateFeaturedPromotions('bookings', { eventType: 'INSERT', new: { date: '2026-10-19', court_id: '1', slots: ['15'] } });
  await h.context.refreshFeaturedPromotions();
  assert.equal(h.requests.length, 2);
  h.context.invalidateFeaturedPromotions('bookings', { eventType: 'INSERT', new: { date: offer.date, court_id: '1', slots: ['15'] } });
  await h.context.refreshFeaturedPromotions();
  assert.equal(h.requests.length, 4, 'a newly occupied advertised slot refreshes immediately');
});

test('opening or selecting an offer bypasses both discovery and lower preview caches', async () => {
  const h = harness();
  await h.context.refreshFeaturedPromotions();
  await h.context.refreshFeaturedCourtDeal({ force: true });
  assert.equal(h.requests.filter(([type]) => type === 'deals').length, 2);
  assert.ok(h.cleared.every(scopes => scopes.includes('publicDemandCampaignFeaturedOffers')));
  assert.ok(h.requests.filter(([type]) => type === 'deals').every(([, args]) => args.force === true));
  await h.context.refreshFeaturedCourtPick({ force: true });
  assert.equal(h.requests.filter(([type]) => type === 'pick').length, 2);
  assert.ok(h.requests.filter(([type]) => type === 'pick').every(([, args]) => args.force === true));
});

test('force requests during an older discovery read wait for one new read and never apply the old response', async () => {
  const old = deferred();
  let count = 0;
  const h = harness({ deals: () => ++count === 1 ? old.promise : [{ date: '2026-10-18', courtId: '2', slotHour: 16 }] });
  const first = h.context.refreshFeaturedCourtDeal(); await tick();
  const clicked = h.context.refreshFeaturedCourtDeal({ force: true });
  const repeated = h.context.refreshFeaturedCourtDeal({ force: true });
  old.resolve([{ date: '2026-10-18', courtId: '1', slotHour: 15 }]);
  const values = await Promise.all([first, clicked, repeated]);
  assert.equal(count, 2);
  assert.equal(h.applied.length, 1);
  assert.ok(values.every(offers => offers[0].courtId === '2'));
});

test('concurrent explicit validations share an already forced read', async () => {
  const read = deferred();
  const h = harness({ deals: () => read.promise });
  const first = h.context.refreshFeaturedCourtDeal({ force: true });
  await tick();
  const second = h.context.refreshFeaturedCourtDeal({ force: true });
  read.resolve([]);
  await Promise.all([first, second]);
  assert.equal(h.requests.filter(([type]) => type === 'deals').length, 1);
});

test('settings invalidation during discovery discards stale results and coalesces the fresh pass', async () => {
  const old = deferred();
  let count = 0;
  const h = harness({ deals: () => ++count === 1 ? old.promise : [] });
  const first = h.context.refreshFeaturedPromotions(); await tick();
  h.context.invalidateFeaturedPromotions('settings', {});
  const second = h.context.refreshFeaturedPromotions();
  old.resolve([{ date: '2026-10-18', courtId: '1', slotHour: 15 }]);
  await Promise.all([first, second]);
  assert.equal(count, 2);
  assert.equal(h.applied.filter(([type]) => type === 'deals').length, 1);
  assert.deepEqual(h.context._featuredDealOffers, []);
});

test('hidden tabs skip scheduled discovery and defer invalidated reads until return', async () => {
  const old = deferred();
  let count = 0;
  const h = harness({ deals: () => ++count === 1 ? old.promise : [] });
  const first = h.context.refreshFeaturedPromotions(); await tick();
  h.context.document.hidden = true;
  h.context.invalidateFeaturedPromotions('settings', {});
  old.resolve([]);
  const hiddenResult = await first;
  assert.equal(hiddenResult.offers.length, 0, 'hidden invalidated callers receive a safe empty offer list');
  await h.nextTimer();
  assert.equal(count, 1, 'no follow-up discovery read while hidden');
  h.context.document.hidden = false;
  await h.context.refreshFeaturedPromotions();
  assert.equal(count, 2);
});

test('promotion expiry shortens discovery cache lifetime without changing availability cache TTLs', async () => {
  const h = harness({ pick: () => ({ expiresAt: '2026-10-18T04:02:00Z', courtId: '1' }) });
  await h.context.refreshFeaturedPromotions();
  await h.nextTimer();
  assert.equal(h.requests.filter(([type]) => type === 'pick').length, 2);
  assert.equal(h.requests.filter(([type]) => type === 'deals').length, 1);
});

test('expired displayed promotions disappear before a slow replacement request completes', async () => {
  const replacement = deferred();
  let reads = 0;
  const offer = { date: '2026-10-18', courtId: '1', slotHour: 12, endsAt: '2026-10-18T04:02:00Z' };
  const h = harness({ deals: () => ++reads === 1 ? [offer] : replacement.promise });
  await h.context.refreshFeaturedPromotions();
  assert.equal(h.context._featuredDealOffers.length, 1);
  h.advance(120000);
  const refresh = h.context.refreshFeaturedPromotions();
  assert.equal(h.context._featuredDealOffers.length, 0);
  replacement.resolve([]);
  await refresh;
});

test('booking impact checks advertised date, court, and hour; released slots wait for normal discovery', () => {
  const offers = [{ date: '2026-10-18', courtId: '1', slotHour: 15 }];
  const change = row => ({ eventType: 'UPDATE', old: { ref: 'booking' }, new: row });
  assert.equal(live.promotionsAffected('bookings', change({ date: '2026-10-18', court_id: '2', slots: [15] }), offers), false);
  assert.equal(live.promotionsAffected('bookings', change({ date: '2026-10-18', court_id: '1', slots: [16] }), offers), false);
  assert.equal(live.promotionsAffected('bookings', change({ date: '2026-10-18', court_id: '1', slots: [15] }), offers), true);
  assert.equal(live.promotionsAffected('bookings', { eventType: 'DELETE', old: { ref: 'booking' } }, offers), false);
  assert.equal(live.promotionsAffected('blocked_dates', {}, offers), true);
});

function databaseHarness() {
  const requests = [], timers = new Map();
  let id = 0;
  const client = {
    auth: { getSession: async () => ({ data: { session: null } }) },
    rpc(name) { const request = deferred(); requests.push({ name, ...request }); return request.promise; },
  };
  const context = {
    console, structuredClone,
    location: { hostname: 'kortedoscdo.club', pathname: '/', search: '' },
    localStorage: { getItem: () => null, removeItem() {} },
    supabase: { createClient: () => client },
    setTimeout(callback) { timers.set(++id, callback); return id; },
    clearTimeout(key) { timers.delete(key); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('supabase-config.js', 'utf8'), context);
  return { DB: context.DB, requests, timeout() { for (const [key, callback] of [...timers]) { timers.delete(key); callback(); } } };
}

for (const [method, scope, empty] of [
  ['getPublicDemandCampaignFeaturedOffers', 'publicDemandCampaignFeaturedOffers', []],
  ['getPublicFeaturedCourtHour', 'publicFeaturedCourtHour', null],
]) test(`${method} serializes a fresh forced read after the UI timeout instead of applying an old snapshot`, async () => {
  const h = databaseHarness();
  const load = () => { h.DB.clearCache([scope]); return h.DB[method]({ force: true }); };
  const first = load(), concurrent = load();
  await tick();
  assert.equal(h.requests.length, 1);
  h.timeout();
  assert.deepEqual(JSON.parse(JSON.stringify(await first)), empty);
  await concurrent;
  const afterTimeout = load();
  await tick();
  assert.equal(h.requests.length, 1, 'a UI timeout cannot release the actual transport gate');
  const row = court => ({
    court_id: court, court_name: `Court ${court}`, offer_date: '2099-10-18', slot_hour: 15,
    discount_percent: 5, regular_rate: 100, offer_rate: 95, ends_at: '2099-10-19T00:00:00Z',
    placement_token: '12345678-1234-4123-8123-123456789abc', play_date: '2099-10-18',
    end_hour: 16, expires_at: '2099-10-19T00:00:00Z',
  });
  let forcedCompleted = false;
  afterTimeout.then(() => { forcedCompleted = true; });
  h.requests[0].resolve({ data: [row('old')], error: null });
  await tick();
  assert.equal(forcedCompleted, false, 'the old transport response cannot satisfy fresh validation');
  assert.equal(h.requests.length, 2, 'start one fresh transport only after the old one finishes');
  h.requests[1].resolve({ data: [row('new')], error: null });
  const fresh = await afterTimeout;
  assert.equal((Array.isArray(fresh) ? fresh[0] : fresh).courtId, 'new');
  const revalidated = load();
  await tick();
  assert.equal(h.requests.length, 3, 'a later explicit read still revalidates');
  h.requests[2].resolve({ data: [], error: null });
  await revalidated;
});

for (const [method, scope] of [
  ['getPublicDemandCampaignFeaturedOffers', 'publicDemandCampaignFeaturedOffers'],
  ['getPublicFeaturedCourtHour', 'publicFeaturedCourtHour'],
]) test(`${method} drops a queued revalidation when its UI caller has already timed out`, async () => {
  const h = databaseHarness();
  const load = () => { h.DB.clearCache([scope]); return h.DB[method]({ force: true }); };
  const first = load(); await tick(); h.timeout(); await first;
  const queued = load(); await tick(); h.timeout(); await queued;
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ data: [], error: null }); await tick();
  assert.equal(h.requests.length, 1, 'do not dispatch an abandoned delayed refresh');
  const later = load(); await tick();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ data: [], error: null }); await later;
});
