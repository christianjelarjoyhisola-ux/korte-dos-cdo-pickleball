const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const admin = fs.readFileSync('admin.html', 'utf8');
const db = fs.readFileSync('supabase-config.js', 'utf8');
const sql = fs.readFileSync('supabase/migrations/20261013120000_reschedule_court_and_slot.sql', 'utf8');

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

test('per-court reschedule uses the atomic per-court database operation', () => {
  assert.match(admin, /DB\.rescheduleBookingItems\(moves\)/);
  assert.match(db, /rpc\('reschedule_booking_items'/);
  assert.match(db, /async rescheduleBookingItems\(moves\) \{[\s\S]*?hasSlotConflict[\s\S]*?writeDb\(db\)/);
  assert.doesNotMatch(admin, /different schedules[\s\S]{0,80}individually/);
});

test('RPC locks and validates the complete group before one protected schedule update', () => {
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

test('single-court reschedule still allows a different court', () => {
  assert.match(admin, /id="rsCourt\$\{index\}"/);
  assert.match(admin, /courtId: String\(row\.newCourtId\) !== String\(row\.courtId\) \? String\(row\.newCourtId\) : null/);
  assert.match(sql, /court_id = case when target_court_id is not null then target_court_id/);
});

test('server rejects occupied slots on the newly selected court', () => {
  assert.match(sql, /occupied\.court_id = case[\s\S]*?target_court_id[\s\S]*?occupied\.slots && new_slots/i);
  assert.match(sql, /time slots are already booked for the selected court/i);
});
const vm = require('node:vm');
function rescheduleFunction(name) {
  const source = admin.replace(/\r\n/g, '\n');
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, source.lastIndexOf('\n}', start + 1 + next) + 2);
}

const RESCHEDULE_FUNCTIONS = ['fmtHour', 'rescheduleSlotOptions', 'rescheduleManilaClock', '_nbCheckRule',
  'bookingStartHour', 'sortBookingsChronologically', 'bookingLogicalKey', 'canRescheduleBooking',
  'rescheduleClosedHours', 'rescheduleFinalPlacement', 'rescheduleRowOptions', 'rescheduleRefreshOptions',
  'loadRescheduleData', 'loadRescheduleSlots', 'renderRescheduleRows', 'rescheduleReady', 'updateRescheduleSummary',
  'setRescheduleRowMode', 'setRescheduleRowDate', 'setRescheduleRowCourt', 'selectRescheduleSlot',
  'applyRescheduleDateToAll', 'openRescheduleModal', 'saveReschedule'];

// Host reservation: 3 courts, different times.
const HOST_ROWS = [
  { ref: 'H-01', groupRef: 'H-G', courtId: '1', courtName: 'Court 1', date: '2026-11-02', slots: [17, 18], startTime: '5:00 PM', endTime: '7:00 PM', duration: 2, status: 'confirmed', fullName: 'Host', email: 'h@x' },
  { ref: 'H-02', groupRef: 'H-G', courtId: '2', courtName: 'Court 2', date: '2026-11-02', slots: [19, 20], startTime: '7:00 PM', endTime: '9:00 PM', duration: 2, status: 'confirmed', fullName: 'Host', email: 'h@x' },
  { ref: 'H-03', groupRef: 'H-G', courtId: '3', courtName: 'Court 3', date: '2026-11-02', slots: [17, 18, 19, 20], startTime: '5:00 PM', endTime: '9:00 PM', duration: 4, status: 'confirmed', fullName: 'Host', email: 'h@x' },
];

function harness({ items = HOST_ROWS, bookings = [], dbOverrides = {} } = {}) {
  const elements = {};
  const calls = { moves: null, toasts: [] };
  const context = {
    Intl, Date, Set, Map, Number, String, JSON, Math, Array, Object, console, Promise,
    _rescheduleContext: null, _rescheduleLoad: 0, _rescheduleSaving: false,
    $: id => elements[id] ||= { value: '', textContent: '', innerHTML: '', disabled: false, hidden: false, min: '', dataset: {}, classList: { add() {} } },
    esc: value => String(value), fmtD: value => String(value),
    toast: (msg, kind) => calls.toasts.push([msg, kind]), closeModal() {}, renderBookings: async () => {}, renderDash() {},
    notifyBookingUpdateSafe: async () => {},
    getBookingGroupByRef: async () => ({ items, allItems: items, fullName: items[0].fullName, email: items[0].email }),
    DB: {
      clearCache() {}, getSettings: async () => ({ open_hour: '6', close_hour: '24' }),
      getBlockedDates: async () => [], getCourts: async () => [{ id: '1', name: 'Court 1' }, { id: '2', name: 'Court 2' }, { id: '3', name: 'Court 3' }],
      getBookings: async ({ date } = {}) => bookings.filter(b => b.date === date),
      getBookingByRef: async () => null, sendRescheduleEmail: async () => ({ ok: true }),
      rescheduleBookingItems: async moves => { calls.moves = moves; return { ok: true, changes: [] }; },
      ...dbOverrides,
    },
  };
  vm.createContext(context);
  vm.runInContext(RESCHEDULE_FUNCTIONS.map(rescheduleFunction).join('\n'), context);
  context.rescheduleManilaClock = () => ({ date: '2026-10-29', hour: 22 });
  return { c: context, calls };
}

test('opening a 3-court host reservation shows all 3 courts, each kept by default', async () => {
  const { c } = harness();
  await c.openRescheduleModal('H-01');
  const rows = c._rescheduleContext.rows;
  assert.equal(rows.length, 3);
  assert.deepEqual([...rows.map(r => r.courtName)], ['Court 1', 'Court 3', 'Court 2']);
  assert.ok(rows.every(r => r.mode === 'keep'));
  assert.equal(c.$('rsAllBar').hidden, false);
  assert.match(c.$('rsRows').innerHTML, /Court 1[\s\S]*Court 3[\s\S]*Court 2/);
  assert.equal(c.$('rsSaveBtn').disabled, true);
});

test('"use for all courts" moves every court to the new date at its own time and saves all 3', async () => {
  const { c, calls } = harness();
  await c.openRescheduleModal('H-01');
  c.$('rsAllDate').value = '2026-11-06';
  await c.applyRescheduleDateToAll();
  const rows = c._rescheduleContext.rows;
  assert.deepEqual([...rows.map(r => r.selectedStart)], [17, 17, 19]);
  assert.equal(c.$('rsSaveBtn').disabled, false);
  await c.saveReschedule();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.moves)), [
    { ref: 'H-01', date: '2026-11-06', startHour: 17, courtId: null },
    { ref: 'H-03', date: '2026-11-06', startHour: 17, courtId: null },
    { ref: 'H-02', date: '2026-11-06', startHour: 19, courtId: null },
  ]);
});

test('when a court\'s usual time is taken on the new date, only that court asks for another time', async () => {
  const other = { ref: 'X', courtId: '2', date: '2026-11-06', slots: [20], status: 'confirmed' };
  const { c, calls } = harness({ bookings: [other] });
  await c.openRescheduleModal('H-01');
  c.$('rsAllDate').value = '2026-11-06';
  await c.applyRescheduleDateToAll();
  const court2 = c._rescheduleContext.rows.find(r => r.courtName === 'Court 2');
  assert.equal(court2.selectedStart, null);
  assert.match(court2.notice, /usual time is taken/);
  assert.equal(c.$('rsSaveBtn').disabled, true);
  c.selectRescheduleSlot(c._rescheduleContext.rows.indexOf(court2), 21);
  assert.equal(c.$('rsSaveBtn').disabled, false);
  await c.saveReschedule();
  assert.equal(calls.moves.find(m => m.ref === 'H-02').startHour, 21);
});

test('one court can move to a different court and time while the others keep their schedule', async () => {
  const { c, calls } = harness();
  await c.openRescheduleModal('H-01');
  const i = c._rescheduleContext.rows.findIndex(r => r.courtName === 'Court 2');
  c.setRescheduleRowMode(i, 'move');
  await new Promise(r => setImmediate(r));
  c.setRescheduleRowDate(i, '2026-11-02');
  await new Promise(r => setImmediate(r));
  c.setRescheduleRowCourt(i, '1');
  await new Promise(r => setImmediate(r));
  const row = c._rescheduleContext.rows[i];
  // Court 1 at 5-7 PM is held by this reservation's own Court 1 entry that stays.
  assert.equal(row.options.find(o => o.start === 17).unavailable, true);
  assert.equal(row.options.find(o => o.start === 19).unavailable, false);
  c.selectRescheduleSlot(i, 19);
  await c.saveReschedule();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.moves)), [{ ref: 'H-02', date: '2026-11-02', startHour: 19, courtId: '1' }]);
});

test('two courts of the same reservation cannot pick the same court and hour', async () => {
  const { c } = harness();
  await c.openRescheduleModal('H-01');
  c.$('rsAllDate').value = '2026-11-06';
  await c.applyRescheduleDateToAll();
  const rows = c._rescheduleContext.rows;
  const court2 = rows.findIndex(r => r.courtName === 'Court 2');
  c.setRescheduleRowCourt(court2, '1');
  await new Promise(r => setImmediate(r));
  const options = c._rescheduleContext.rows[court2].options;
  assert.equal(options.find(o => o.start === 16).unavailable, true); // overlaps Court 1 entry at 17-18
  assert.equal(options.find(o => o.start === 19).unavailable, false);
});

test('single-court booking opens ready to move, with tomorrow preselected', async () => {
  const single = [{ ref: 'S-1', courtId: '2', courtName: 'Court 2', date: '2026-11-02', slots: [8, 9], startTime: '8:00 AM', endTime: '10:00 AM', duration: 2, status: 'pending', fullName: 'A' }];
  const { c, calls } = harness({ items: single });
  await c.openRescheduleModal('S-1');
  const row = c._rescheduleContext.rows[0];
  assert.equal(row.mode, 'move');
  assert.equal(row.newDate, '2026-10-30');
  assert.equal(c.$('rsAllBar').hidden, true);
  c.setRescheduleRowCourt(0, '3');
  await new Promise(r => setImmediate(r));
  c.selectRescheduleSlot(0, 22);
  await c.saveReschedule();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.moves)), [{ ref: 'S-1', date: '2026-10-30', startHour: 22, courtId: '3' }]);
});

test('saving rechecks availability and refuses a slot taken meanwhile', async () => {
  const bookings = [];
  const { c, calls } = harness({ bookings });
  await c.openRescheduleModal('H-01');
  c.$('rsAllDate').value = '2026-11-06';
  await c.applyRescheduleDateToAll();
  bookings.push({ ref: 'LATE', courtId: '3', date: '2026-11-06', slots: [18], status: 'confirmed' });
  await c.saveReschedule();
  assert.equal(calls.moves, null);
  assert.equal(c._rescheduleSaving, false);
  assert.match(calls.toasts.at(-1)[0], /no longer available/);
});

test('failed availability check disables Save and offers Retry', async () => {
  const { c } = harness({ dbOverrides: { getBookings: async () => { throw Error('offline'); } } });
  await c.openRescheduleModal('H-01');
  c.setRescheduleRowMode(0, 'move');
  await new Promise(r => setImmediate(r));
  assert.match(c.$('rsRows').innerHTML, /Retry/);
  assert.equal(c.$('rsSaveBtn').disabled, true);
});

test('slot ranges keep the paid duration, end at midnight, and skip past hours', () => {
  const { c } = harness();
  const options = c.rescheduleSlotOptions({ date: '2026-10-29', duration: 2, openHour: 8, closeHour: 24, unavailableHours: new Set([22]), today: '2026-10-29', currentHour: 18 });
  assert.equal(options.at(-1).start, 22);
  assert.equal(options.at(-1).label, '10:00 PM – 12 midnight (next day)');
  assert.ok(options.find(o => o.start === 18).unavailable);
  assert.ok(options.find(o => o.start === 21).unavailable);
  assert.ok(options.every(o => o.slots.length === 2));
});

test('Philippine date stays correct when UTC is still on the previous date', () => {
  const { c } = harness();
  vm.runInContext(rescheduleFunction('rescheduleManilaClock'), c);
  const clock = c.rescheduleManilaClock(new Date('2026-10-10T16:30:00Z'));
  assert.equal(clock.date, '2026-10-11'); assert.equal(clock.hour, 0);
});
