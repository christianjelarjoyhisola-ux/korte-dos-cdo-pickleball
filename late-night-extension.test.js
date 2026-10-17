const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n');
function fn(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const end = html.indexOf('\n}', start);
  return html.slice(start, end + 2);
}
function harness({ blocked = [], bookings = [], maintenance = false, openPlay = false, repair = false, fail = false } = {}) {
  const context = { Date, window: { BookingBalance: require('./booking-balance.js') }, isHeldVerifying: () => false,
    getCourtRepair: () => repair, isMaintenanceHour: () => maintenance,
    isOpenPlayHour: () => openPlay,
    DB: { getBlockedDates: async () => blocked, getBookings: async () => { if (fail) throw Error('Unavailable'); return bookings; } } };
  vm.createContext(context);
  for (const name of ['normalizedSlots', 'addDaysYmd', 'bookingHoldsSlot', 'selectedLateNightCourts', 'isLateNightExtensionAvailable', 'lateNightExtensionCandidate']) vm.runInContext(fn(name), context);
  return context;
}
const selections = (slots = [22, 23]) => ['1','2'].map(courtId => ({ courtId, courtName: 'Court ' + courtId, date: '2026-10-31', slots }));
test('two courts qualify with any duration that includes the hour ending at midnight', () => {
  const h = harness();
  assert.equal(h.selectedLateNightCourts(selections()), true);
  assert.equal(h.selectedLateNightCourts(selections([21,22,23])), true);
  assert.equal(h.selectedLateNightCourts(selections([23,22,22])), true);
  assert.equal(h.selectedLateNightCourts(selections([23])), true);
  assert.equal(h.selectedLateNightCourts(selections([21,23])), true);
  assert.equal(h.selectedLateNightCourts([selections([21,22,23])[0], selections([23])[1]]), true);
});
test('one court or a court without the midnight-ending hour does not qualify', () => {
  const h = harness();
  for (const rows of [[], selections([21,22]), selections().slice(0,1), [selections()[0], {...selections()[1], slots:[22]}], [selections()[0], selections()[0]]]) assert.equal(h.selectedLateNightCourts(rows), false);
});
test('extension adds hour zero on the next calendar day to each court without modifying selections', async () => {
  const rows = selections([21,22,23]); const h = harness(); const candidate = await h.lateNightExtensionCandidate(rows);
  assert.equal(candidate.nextDate, '2026-11-01');
  assert.deepEqual(JSON.parse(JSON.stringify(candidate.selections)), rows.map(row => ({ ...row, date:'2026-11-01', slots:[0] })));
  assert.deepEqual(rows, selections([21,22,23]));
  assert.equal(await h.lateNightExtensionCandidate([rows[0], {...rows[1],date:'2026-11-01'}]), null);
});
test('blocked dates, repairs, open play, maintenance, and occupied midnight slots suppress the offer', async () => {
  for (const options of [{blocked:['2026-11-01']}, {repair:true}, {openPlay:true}, {maintenance:true},
    {bookings:[{courtId:'2', date:'2026-11-01',slots:[0],status:'confirmed'}]}]) {
    assert.equal(await harness(options).lateNightExtensionCandidate(selections()), null);
  }
});
test('availability failures do not produce an extension offer', async () => {
  await assert.rejects(harness({fail:true}).lateNightExtensionCandidate(selections()), /Unavailable/);
});
