const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n');
const config = fs.readFileSync('supabase-config.js', 'utf8');
function fn(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const following = html.slice(start + 1).search(/\n(?:async )?function /);
  const end = html.lastIndexOf('\n}', start + 1 + following);
  return html.slice(start, end + 2);
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function element() { return { dataset: {}, style: {}, textContent: '', innerHTML: '', isConnected: true, closest() { return this; }, classList: { add() {}, remove() {} } }; }
function timerHarness() {
  let now = Date.parse('2026-09-28T00:00:00Z');
  const elements = {};
  const intervals = new Map();
  let nextId = 0, closed = 0;
  const context = {
    Date: class extends Date { static now() { return now; } },
    _reservationStartedAt: new Date(now).toISOString(), RESERVATION_MINUTES: 15,
    _countdownInterval: null, _countdownTick: null, _bookingSubmissionInFlight: false,
    $: id => elements[id] ||= element(), updatePaymentWindowText() {}, clearReservationTimerIntro() {},
    setInterval: callback => { intervals.set(++nextId, callback); return nextId; },
    clearInterval: id => intervals.delete(id), showReservationTimerIntro() {}, toast() {},
    closeBookModal: () => { closed++; },
  };
  vm.createContext(context);
  vm.runInContext(fn('startSlotCountdown') + '\n' + fn('stopSlotCountdown'), context);
  return { context, elements, intervals, advance: ms => { now += ms; }, closed: () => closed };
}
test('reservation countdown includes setup latency, background time, and retry time', () => {
  const h = timerHarness();
  h.advance(90000); h.context.startSlotCountdown();
  assert.equal(h.elements.scdTime.textContent, '13:30');
  h.advance(5 * 60000); h.context._countdownTick();
  assert.equal(h.elements.scdTime.textContent, '08:30');
  h.context.stopSlotCountdown(); h.advance(30000); h.context.startSlotCountdown(900);
  assert.equal(h.elements.scdTime.textContent, '08:00', 'retry must not extend the hold');
  assert.equal(h.intervals.size, 1);
});
test('expiry clears every timer and never cancels an in-flight receipt request', () => {
  const h = timerHarness(); h.context.startSlotCountdown();
  h.context._bookingSubmissionInFlight = true;
  h.advance(16 * 60000); h.context._countdownTick();
  assert.equal(h.closed(), 0);
  assert.equal(h.elements.scdTime.textContent, '00:00');
  h.context._bookingSubmissionInFlight = false; h.context._countdownTick();
  assert.equal(h.closed(), 1); assert.equal(h.intervals.size, 0); assert.equal(h.context._countdownTick, null);
  h.context.startSlotCountdown();
  assert.equal(h.intervals.size, 0, 'an already-expired timer must not leak an interval');
});
function loadDB(handler) {
  const client = {
    auth: { getSession: async () => ({ data: { session: null } }) },
    rpc: (name, args) => handler(name, args),
    from: name => ({ select: () => ({ order: () => handler(name) }) }),
  };
  const context = { console: { error() {} }, location: { hostname: 'kortedoscdo.club', pathname: '/', search: '' }, localStorage: { getItem: () => null, removeItem() {} }, supabase: { createClient: () => client }, structuredClone };
  context.window = context;
  vm.createContext(context); vm.runInContext(config, context);
  return context;
}
for (const [method, args, response] of [
  ['getBookings', [{ date: '2026-09-28', activeOnly: true }], [{ court_id: '1', date: '2026-09-28', hour: 8, status: 'booked' }]],
  ['getCourts', [], [{ id: '1', name: 'Court 1', rate: 300 }]],
  ['getBlockedDates', [], [{ date: '2026-09-28' }]],
  ['getSettings', [], [{ key: 'open_hour', value: '6' }]],
]) test(method + ' propagates failure and retries instead of caching empty availability', async () => {
  let calls = 0;
  const context = loadDB(async () => ++calls === 1 ? { error: new Error('offline'), data: null } : { error: null, data: response });
  await assert.rejects(context.DB[method](...args), /offline/);
  const result = await context.DB[method](...args);
  assert.ok(Array.isArray(result) ? result.length : Object.keys(result).length);
  assert.equal(calls, 2);
});
test('invalidated in-flight reads cannot overwrite newer cached availability', async () => {
  const old = deferred(); let calls = 0;
  const context = loadDB(() => ++calls === 1 ? old.promise : Promise.resolve({ data: [{ court_id: '1', date: '2026-09-28', hour: 8, status: 'booked' }] }));
  const args = { date: '2026-09-28', activeOnly: true };
  const first = context.DB.getBookings(args);
  await new Promise(resolve => setImmediate(resolve));
  context.DB.clearCache();
  assert.equal((await context.DB.getBookings(args)).length, 1);
  old.resolve({ data: [] }); await first;
  assert.equal((await context.DB.getBookings(args)).length, 1);
  assert.equal(calls, 2);
});
test('failed full-grid refresh removes selectable slots and retains held booking items', async () => {
  const elements = { courtsGrid: element(), courtTabs: element() }; let preserved = false;
  const context = { _courtsRenderRequest: 0, document: { querySelectorAll: () => [] }, $: id => elements[id], todayStr: () => '2026-09-28', selectedCourtBrowseDate: () => '2026-09-28', DB: { getCourts: async () => [], getBookings: async () => { throw Error('offline'); }, getBlockedDates: async () => [] }, loadOperatingHours: async () => {}, window: {}, clearCardSelection: options => { preserved = options.preserveBookingItems; }, console: { warn() {} } };
  elements.courtsGrid.innerHTML = '<button>Available slot</button>';
  vm.createContext(context); vm.runInContext(fn('availabilityErrorMarkup') + '\n' + fn('renderCourts'), context);
  await context.renderCourts();
  assert.match(elements.courtsGrid.innerHTML, /Unable to check availability/);
  assert.match(elements.courtsGrid.innerHTML, /Retry/);
  assert.doesNotMatch(elements.courtsGrid.innerHTML, /Available slot/);
  assert.equal(preserved, true);
});
test('a late failed card read cannot overwrite a newer successful read', async () => {
  const old = deferred(); let calls = 0;
  const grid = element(); const context = { _cardAvailabilityRequest: 0, $: id => id === 'cSlots_1' ? grid : null, clearCardSelection() {}, selectedCourtBrowseDate: () => '2026-09-28', DB: { getCourts: async () => [{ id: '1', blocked: true }], getBookings: () => ++calls === 1 ? old.promise : Promise.resolve([]), getBlockedDates: async () => [] }, loadOperatingHours: async () => {}, window: {}, console: { warn() {} } };
  vm.createContext(context); vm.runInContext(fn('availabilityErrorMarkup') + '\n' + fn('onCardDate'), context);
  const first = context.onCardDate('1', '2026-09-28');
  await context.onCardDate('1', '2026-09-28');
  assert.match(grid.innerHTML, /Under maintenance/);
  old.reject(Error('late failure')); await first;
  assert.match(grid.innerHTML, /Under maintenance/);
});
for (const method of ['cash', 'gcash']) test(method + ' save failure preserves details and receipt and allows immediate retry', async () => {
  const h = timerHarness(); const c = h.context;
  const values = { bName: 'Test Player', bPhone: '09123456789', bEmail: 'test@example.test', bPay: method, bDate: '2026-09-29' };
  for (const [id, value] of Object.entries(values)) c.$(id).value = value;
  c.$('bookingPolicyAgree').checked = true; c.$('bVoucherCode').value = ''; c.$('bGcashRef').value = method === 'gcash' ? '1234567890123' : '';
  const receipt = { name: 'receipt.png' }; c._receiptFile = receipt;
  const item = { ref: 'PB-TEST', courtId: '1', courtName: 'Court 1', date: '2026-09-29', slots: [8], total: 300, courtFee: 300, serviceFee: 0 };
  let savedDraft = 0, attempts = 0;
  Object.assign(c, { _lastSubmitAt: 0, reservedRefs: () => ['PB-TEST'], reservationSecondsLeft: () => 600, uniqueBookingSelections: x => x, activeBookingItems: () => [item], bookingItemsDate: () => item.date, ALL_PAYMENT_METHODS: [method], paymentMethods: { [method]: true }, isDigitalPayMethod: () => method === 'gcash', isGcashRefValid: () => true, getCourtRepair: () => null, window: {}, bookingItemsTotal: () => 300, bookingItemsCourtFee: () => 300, bookingItemsServiceFee: () => 0, downpaymentAmount: () => 150, activeHostSession: () => null, hostBookingIdentity: () => ({}), itemTimeLabel: () => '8-9', bookingItemsCourtLabel: () => 'Court 1', bookingItemsTimeLabel: () => '8-9', bookingItemsDuration: () => 1, DB: { updateBooking: async () => { attempts++; throw Error('offline'); } }, saveGuestBookingResume: () => savedDraft++, extractErrMsg: e => e.message });
  vm.runInContext(fn('submitBooking'), c);
  c.startSlotCountdown(); const tick = c._countdownTick;
  await c.submitBooking();
  assert.equal(attempts, 1); assert.equal(c._lastSubmitAt, 0); assert.equal(c.$('wizNextBtn').disabled, false);
  assert.equal(c._countdownTick, tick); assert.equal(savedDraft, 1); assert.equal(c.$('bName').value, 'Test Player'); assert.equal(c._receiptFile, receipt);
  await c.submitBooking(); assert.equal(attempts, 2);
});
