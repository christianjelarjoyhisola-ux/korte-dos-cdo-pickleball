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
