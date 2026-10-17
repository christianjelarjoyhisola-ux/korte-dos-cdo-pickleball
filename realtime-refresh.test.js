const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const live = require('./realtime-refresh.js');

function clock() {
  const timers = new Map();
  let id = 0;
  return {
    setTimer(callback) { timers.set(++id, callback); return id; },
    clearTimer(key) { timers.delete(key); },
    size: () => timers.size,
    run() {
      const [key, callback] = timers.entries().next().value || [];
      assert.ok(callback, 'a refresh is scheduled');
      timers.delete(key);
      return callback();
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness(page, options = {}) {
  const time = clock();
  const rows = new Map(), events = new Map(), invalidations = [], renders = [];
  let subscription;
  const channel = {
    on(_, filter, callback) { rows.set(filter.table, callback); return channel; },
    subscribe(callback) { subscription = callback; callback('SUBSCRIBED'); return channel; },
  };
  const document = {
    hidden: false, activeElement: null, modal: false,
    addEventListener(event, callback) { events.set(event, callback); },
    querySelector() { return document.modal; },
  };
  const context = {
    document, console,
    addEventListener(event, callback) { events.set(event, callback); },
    RealtimeRefresh: { ...live, createQueue: opts => live.createQueue({ ...opts, setTimer: time.setTimer, clearTimer: time.clearTimer }) },
    DB: { clearCache: scopes => invalidations.push([...scopes]) },
    _supabase: { channel: () => channel },
    _curSection: 'bookings',
    SECTION_LOADERS: Object.fromEntries(['bookings', 'payreview', 'notifications', 'courts', 'gamemgr'].map(section => [section, async () => renders.push(section)])),
    court: { id: '1' }, sharedCourtDate: '',
    $: id => id === 'calendarView' ? { style: { display: options.calendar ? '' : 'none' } } : { value: options.slotDate || '2026-10-17' },
    selectedCourtBrowseDate: () => options.browseDate || '2026-10-17',
    renderCourts: async () => { renders.push('courts'); await options.courtRead?.(); },
    renderSlots: async () => renders.push('slots'),
    renderCalendar: async () => renders.push('calendar'),
    refreshFeaturedPromotions: async () => renders.push('promotions'),
  };
  context.window = context;
  const source = fs.readFileSync(page + '.html', 'utf8').replace(/\r\n/g, '\n');
  const begin = source.indexOf(page === 'index' ? 'let _publicRealtimeRefresh' : 'let _adminRealtimeRefresh');
  const end = source.indexOf('/* =============================================', begin);
  assert.ok(begin >= 0 && end > begin);
  vm.createContext(context);
  vm.runInContext(source.slice(begin, end), context);
  context[page === 'index' ? 'startRealtime' : 'startAdminRealtime']();
  return { context, document, time, invalidations, renders,
    change: (table, payload = {}) => rows.get(table)(payload),
    event: name => events.get(name)(),
    status: value => subscription(value),
  };
}

test('booking events preserve unrelated settings, court and registration caches', async () => {
  const h = harness('index');
  h.change('bookings', { eventType: 'INSERT', new: { date: '2026-10-17' } });
  assert.ok(h.invalidations[0].includes('publicBookingSlots'));
  for (const scope of ['courts', 'settings', 'openPlayCount', 'blockedDates']) assert.ok(!h.invalidations[0].includes(scope));
  await h.time.run();
  assert.deepEqual(h.renders, ['courts', 'promotions', 'slots']);
});

test('unrelated dates skip court reads; reschedules refresh both old and new dates', async () => {
  const h = harness('index');
  h.change('bookings', { eventType: 'INSERT', new: { date: '2026-10-18' } });
  await h.time.run();
  assert.deepEqual(h.renders, ['promotions']);
  h.renders.length = 0;
  h.change('bookings', { eventType: 'UPDATE', old: { date: '2026-10-17' }, new: { date: '2026-10-18' } });
  await h.time.run();
  assert.ok(h.renders.includes('courts'));
  assert.equal(live.affectsDate({ eventType: 'UPDATE', old: { date: '2026-10-17' }, new: { date: '2026-10-18' } }, '2026-10-18'), true);
  assert.equal(live.affectsDate({ eventType: 'UPDATE', old: { date: '2026-10-17' }, new: { date: '2026-10-18' } }, '2026-10-19'), false);
});

test('partial UPDATE and DELETE payloads never leave released slots stale', async () => {
  const h = harness('index');
  for (const payload of [
    { eventType: 'DELETE', old: { ref: 'old-booking' } },
    { eventType: 'UPDATE', old: { ref: 'moved-booking' }, new: { date: '2026-10-18' } },
  ]) {
    h.renders.length = 0;
    h.change('bookings', payload);
    await h.time.run();
    assert.ok(h.renders.includes('courts'));
  }
});

test('Open Play registrations update each displayed date independently, including the booking wizard', async () => {
  const h = harness('index', { slotDate: '2026-10-18' });
  h.change('open_play_registrations', { eventType: 'INSERT', new: { date: '2026-10-18' } });
  await h.time.run();
  assert.deepEqual(h.renders, ['slots'], 'wizard remaining places refresh even when the browse date differs');
  assert.ok(h.invalidations[0].includes('openPlayCount'));
  h.renders.length = 0;
  h.change('open_play_registrations', { eventType: 'INSERT', new: { date: '2026-10-17' } });
  await h.time.run();
  assert.deepEqual(h.renders, ['courts']);
  h.change('open_play_registrations', { eventType: 'INSERT', new: { date: '2026-10-19' } });
  assert.equal(h.time.size(), 0, 'an unrelated date does not fetch either view');
});

test('hidden public tabs invalidate immediately but coalesce all reads on return', async () => {
  const h = harness('index');
  h.document.hidden = true;
  for (let i = 0; i < 10; i++) h.change('bookings');
  h.change('settings');
  assert.equal(h.invalidations.length, 11);
  assert.equal(h.time.size(), 0);
  assert.deepEqual(h.renders, []);
  h.document.hidden = false;
  h.event('visibilitychange');
  assert.equal(h.time.size(), 1);
  await h.time.run();
  assert.deepEqual(h.renders, ['courts', 'promotions', 'slots']);
  assert.equal(h.time.size(), 0);
});

test('events received during an in-flight court read get one subsequent refresh', async () => {
  const read = deferred();
  let calls = 0;
  const h = harness('index', { courtRead: () => ++calls === 1 ? read.promise : undefined });
  h.change('bookings');
  const first = h.time.run();
  h.change('bookings');
  h.change('bookings');
  assert.equal(h.invalidations.length, 3, 'invalidate before the old read can finish');
  assert.equal(h.time.size(), 0, 'do not overlap network refreshes');
  read.resolve();
  await first;
  assert.equal(h.time.size(), 1);
  await h.time.run();
  assert.equal(calls, 2);
  assert.equal(h.time.size(), 0);
});

test('admin only reloads relevant sections; Notifications ignores booking/game changes', async () => {
  const h = harness('admin');
  h.context._curSection = 'notifications';
  for (const table of ['bookings', 'open_play_game_players', 'settings']) h.change(table);
  assert.equal(h.time.size(), 0);
  h.context._curSection = 'bookings';
  h.change('open_play_game_players');
  assert.equal(h.time.size(), 0);
  h.change('host_booking_balance_payments');
  await h.time.run();
  assert.deepEqual(h.renders, ['bookings']);
  h.context._curSection = 'payreview';
  h.change('open_play_registrations');
  await h.time.run();
  assert.deepEqual(h.renders, ['bookings', 'payreview']);
});

test('hidden admin tabs refresh once and do not overwrite active forms or receipt dialogs', async () => {
  const h = harness('admin');
  h.document.hidden = true;
  for (let i = 0; i < 5; i++) h.change('bookings');
  assert.equal(h.time.size(), 0);
  h.document.hidden = false;
  h.event('visibilitychange');
  h.document.activeElement = { tagName: 'INPUT' };
  await h.time.run();
  assert.deepEqual(h.renders, []);
  h.document.activeElement = null;
  h.document.modal = true;
  await h.time.run();
  assert.deepEqual(h.renders, []);
  h.document.modal = false;
  await h.time.run();
  assert.deepEqual(h.renders, ['bookings']);
  assert.equal(h.time.size(), 0);
});

test('reconnects revalidate missed changes once and only render the current admin section', async () => {
  const h = harness('admin');
  assert.equal(h.time.size(), 0, 'initial subscription does not duplicate the initial page load');
  h.status('CHANNEL_ERROR');
  h.status('SUBSCRIBED');
  h.event('online');
  assert.equal(h.time.size(), 1);
  assert.ok(h.invalidations[0].includes('settings'), 'also invalidate other sections in case their events were missed');
  await h.time.run();
  assert.deepEqual(h.renders, ['bookings']);
});

test('navigation while a refresh is queued does not reload an unrelated section', async () => {
  const h = harness('admin');
  h.change('bookings');
  h.context._curSection = 'notifications';
  await h.time.run();
  assert.deepEqual(h.renders, []);
});

test('court and settings changes refresh the visible booking calendar and its cached dependencies', async () => {
  const h = harness('admin', { calendar: true });
  h.change('courts');
  h.change('settings');
  assert.ok(h.invalidations[0].includes('courts'));
  assert.ok(h.invalidations[1].includes('settings'));
  await h.time.run();
  assert.deepEqual(h.renders, ['calendar'], 'do not reload the hidden booking table');
  const table = harness('admin');
  table.change('settings');
  await table.time.run();
  assert.deepEqual(table.renders, ['bookings'], 'maintenance rows also depend on settings');
});

test('returning from the calendar refreshes the booking list after changes while it was hidden', () => {
  const source = fs.readFileSync('admin.html', 'utf8');
  const start = source.indexOf('function switchBookingView(');
  const end = source.indexOf('function calNav(', start);
  const nodes = new Map();
  const rendered = [];
  const context = {
    $: id => {
      if (!nodes.has(id)) nodes.set(id, { style: {}, classList: { toggle() {} }, hidden: false });
      return nodes.get(id);
    },
    renderCalendar: () => rendered.push('calendar'),
    renderBookings: () => rendered.push('bookings'),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.switchBookingView('cal');
  assert.equal(nodes.get('tableView').style.display, 'none');
  context.switchBookingView('list');
  assert.equal(nodes.get('calendarView').style.display, 'none');
  assert.equal(nodes.get('tableView').style.display, '');
  assert.deepEqual(rendered, ['calendar', 'bookings']);
});

test('a failed refresh does not strand later events', async () => {
  const time = clock();
  let reads = 0, failures = 0;
  const queue = live.createQueue({ ...time, refresh: async () => { if (++reads === 1) throw new Error('offline'); }, onError: () => failures++ });
  queue.request(['courts']);
  await time.run();
  queue.request(['courts']);
  await time.run();
  assert.equal(reads, 2);
  assert.equal(failures, 1);
});
