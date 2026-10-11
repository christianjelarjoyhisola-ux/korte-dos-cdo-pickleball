const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const admin = fs.readFileSync('admin.html', 'utf8');
const db = fs.readFileSync('supabase-config.js', 'utf8');
const sql = fs.readFileSync('supabase/migrations/20260826190000_atomic_group_reschedule.sql', 'utf8');

test('pending manual-review and confirmed grouped reservations expose Reschedule', () => {
  assert.match(admin, /function canRescheduleBooking[\s\S]*?'pending', 'confirmed'/);
  assert.match(admin, /canRescheduleBooking\(b\)[\s\S]*?openRescheduleModal/);
  assert.doesNotMatch(admin, /!grouped && !\['cancelled','forfeited'\]/);
});

test('temporary, historical, released, and mixed reservations remain ineligible', () => {
  const eligibility = admin.match(/function canRescheduleBooking\(b\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(eligibility, /verifying|completed|cancelled|forfeited|mixed/);
  assert.match(eligibility, /items\.every/);
  assert.match(eligibility, /allItems/);
});

test('grouped move uses the atomic database operation and preserves duration pricing', () => {
  assert.match(admin, /context\?\.isGroup[\s\S]*?DB\.rescheduleBookingGroup\(context\.refs, scheduleUpdates\)/);
  assert.match(admin, /id="rsDuration" disabled/);
  assert.match(admin, /different schedules[\s\S]*?cannot be flattened|different schedules[\s\S]*?preserve each paid duration/);
  assert.match(db, /rpc\('reschedule_booking_group'/);
});

test('RPC locks and validates the complete group before one schedule-only update', () => {
  assert.match(sql, /for update;/i);
  assert.match(sql, /group_count <> cardinality\(clean_refs\)/i);
  assert.match(sql, /not in \('pending', 'confirmed'\)/i);
  assert.match(sql, /update public\.bookings booking[\s\S]*?set date = p_new_date[\s\S]*?where booking\.ref = any\(clean_refs\)/i);
  assert.doesNotMatch(sql, /payment_status\s*=|receipt_image_url\s*=|\btotal\s*=|voucher_id\s*=|demand_campaign_id\s*=|billed_at\s*=/i);
});

test('local mode validates the full set and conflicts before writing', () => {
  const localMethod = db.match(/async rescheduleBookingGroup\(refs, updates\) \{[\s\S]*?return bookingRefs\.map\(ref => \(\{ ref \}\)\);[\s\S]*?\n    \},/)?.[0] || '';
  assert.match(localMethod, /found\.length !== bookingRefs\.length/);
  assert.match(localMethod, /hasSlotConflict/);
  assert.ok(localMethod.indexOf('hasSlotConflict') < localMethod.indexOf('db.bookings = db.bookings.map'));
});

test('notification context is captured and identifies every moved court', () => {
  assert.match(admin, /const context = _rescheduleContext \? \{ \.\.\._rescheduleContext, refs: \[\.\.\._rescheduleContext\.refs\] \}/);
  assert.match(admin, /courtName: context\?\.courtName \|\| bk\.courtName/);
});
const vm = require('node:vm');
function rescheduleFunction(name) {
  const source = admin.replace(/\r\n/g, '\n');
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, source.lastIndexOf('\n}', start + 1 + next) + 2);
}
function rescheduleHarness(overrides = {}) {
  const elements = {};
  const context = {
    Intl, Date, Set, Number, console,
    _rescheduleLoad: 0, _rescheduleSaving: false,
    _rescheduleContext: { ref: 'PB-A', refs: ['PB-A', 'PB-B'], isGroup: true,
      items: [{ courtId: '1' }, { courtId: '2' }], duration: 2, options: [], selectedStart: null },
    $: id => elements[id] ||= { value: '', textContent: '', innerHTML: '', disabled: false, dataset: {} },
    esc: value => String(value), toast() {}, closeModal() {}, renderBookings: async () => {}, renderDash() {},
    DB: { clearCache() {}, getSettings: async () => ({ open_hour: '8', close_hour: '24' }),
      getBookings: async () => [], getBlockedDates: async () => [],
      getCourts: async () => [{ id: '1' }, { id: '2' }], getBookingByRef: async () => null, ...overrides },
  };
  vm.createContext(context);
  vm.runInContext(['fmtHour', 'rescheduleSlotOptions', 'rescheduleManilaClock', '_nbCheckRule', 'renderRescheduleSlotChoices', 'selectRescheduleSlot', 'loadRescheduleSlots', 'saveReschedule'].map(rescheduleFunction).join('\n'), context);
  context.rescheduleManilaClock = () => ({ date: '2026-10-11', hour: 20 });
  context.$('rsNewDate').value = '2026-10-12';
  context.$('rsNote').value = '';
  return context;
}

test('two-hour slots include 10 PM to midnight with [22,23] and never run beyond closing', () => {
  const c = rescheduleHarness();
  const options = c.rescheduleSlotOptions({ date: '2026-10-12', duration: 2, openHour: 8, closeHour: 24, unavailableHours: new Set(), today: '2026-10-11', currentHour: 20 });
  const last = options.at(-1);
  assert.equal(last.start, 22);
  assert.deepEqual(Array.from(last.slots), [22, 23]);
  assert.equal(last.label, '10:00 PM – 12 midnight (next day)');
  assert.equal(last.unavailable, false);
  assert.ok(!options.some(option => option.start === 23));
  const earlierClose = c.rescheduleSlotOptions({ date: '2026-10-12', duration: 2, openHour: 8, closeHour: 22, unavailableHours: new Set(), today: '2026-10-11', currentHour: 20 });
  assert.equal(earlierClose.at(-1).start, 20);
});

test('ranges preserve a longer paid duration and filter past dates and occupied interior hours', () => {
  const c = rescheduleHarness();
  const args = { date: '2026-10-11', duration: 4, openHour: 8, closeHour: 24, unavailableHours: new Set([22]), today: '2026-10-11', currentHour: 18 };
  const options = c.rescheduleSlotOptions(args);
  assert.ok(options.find(option => option.start === 18).unavailable);
  assert.ok(options.find(option => option.start === 20).unavailable);
  assert.ok(options.every(option => option.slots.length === 4));
  assert.equal(c.rescheduleSlotOptions({ ...args, date: '2026-10-10' }).length, 0);
});

test('slot reads ignore the reservation itself but block a conflict on any grouped court', async () => {
  let rows = [{ ref: 'PB-A', courtId: '1', date: '2026-10-12', status: 'confirmed', slots: [22,23] }];
  const c = rescheduleHarness({ getBookings: async () => rows });
  await c.loadRescheduleSlots();
  assert.equal(c._rescheduleContext.options.find(option => option.start === 22).unavailable, false);
  rows.push({ ref: 'PB-OTHER', courtId: '2', date: '2026-10-12', status: 'confirmed', slots: [23] });
  await c.loadRescheduleSlots();
  assert.equal(c._rescheduleContext.options.find(option => option.start === 22).unavailable, true);
});

test('blocked dates and maintenance block midnight ranges and failed reads disable Save', async () => {
  const c = rescheduleHarness({ getSettings: async () => ({ open_hour: '8', close_hour: '24', maintenance_config: JSON.stringify({ enabled: true, dates: ['2026-10-12'], start: 23, end: 24, courtIds: ['2'] }) }) });
  await c.loadRescheduleSlots();
  assert.equal(c._rescheduleContext.options.find(option => option.start === 22).unavailable, true);
  c.DB.getBlockedDates = async () => ['2026-10-12'];
  await c.loadRescheduleSlots();
  assert.ok(c._rescheduleContext.options.every(option => option.unavailable));
  c.DB.getBookings = async () => { throw Error('offline'); };
  assert.equal(await c.loadRescheduleSlots(), false);
  assert.equal(c.$('rsSaveBtn').disabled, true);
  assert.match(c.$('rsSlots').innerHTML, /Retry/);
});

test('saving rechecks a newly occupied slot before changing any booking', async () => {
  let writes = 0;
  const c = rescheduleHarness({ rescheduleBookingGroup: async () => { writes++; } });
  await c.loadRescheduleSlots(); c.selectRescheduleSlot(22);
  c.DB.getBookings = async () => [{ ref: 'PB-OTHER', courtId: '1', date: '2026-10-12', status: 'confirmed', slots: [23] }];
  await c.saveReschedule();
  assert.equal(writes, 0); assert.equal(c._rescheduleSaving, false);
  assert.equal(c.$('rsSaveBtn').disabled, true);
});

test('group midnight save is single-flight and changes only schedule fields', async () => {
  let writes = 0, payload, finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const c = rescheduleHarness({ rescheduleBookingGroup: async (refs, updates) => { writes++; payload = updates; await wait; } });
  await c.loadRescheduleSlots(); c.selectRescheduleSlot(22);
  const first = c.saveReschedule();
  await c.saveReschedule();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), { date: '2026-10-12', startTime: '10:00 PM', endTime: '12:00 AM', duration: 2, slots: [22,23] });
  finish(); await first;
  assert.equal(c._rescheduleSaving, false);
});

test('Philippine date stays correct when UTC is still on the previous date', () => {
  const c = rescheduleHarness();
  vm.runInContext(rescheduleFunction('rescheduleManilaClock'), c);
  const clock = c.rescheduleManilaClock(new Date('2026-10-10T16:30:00Z'));
  assert.equal(clock.date, '2026-10-11'); assert.equal(clock.hour, 0);
});
