const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const admin = fs.readFileSync('admin.html', 'utf8');
const config = fs.readFileSync('supabase-config.js', 'utf8');
const migration = fs.readFileSync(
  'supabase/migrations/20260816150000_atomic_host_full_payment_recovery.sql',
  'utf8',
);
const endOfDayMigration = fs.readFileSync(
  'supabase/migrations/20260820160000_host_balance_deadline_end_of_day_ph.sql',
  'utf8',
);

test('host full-payment selection uses one atomic database operation', () => {
  assert.match(admin, /status === 'paid' && current\.hostBooking/);
  assert.match(admin, /DB\.markHostBookingGroupFullyPaid\(ref\)/);
  assert.match(config, /rpc\('mark_host_booking_group_fully_paid'/);
  assert.match(migration, /set payment_status = 'paid',[\s\S]*downpayment = booking\.total/);
  assert.match(migration, /for update/);
  assert.match(migration, /payment\.status in \('created', 'pending_review'\)/);
  assert.match(migration, /if unpaid_count = 0 then/);
});

test('owners can close an unsubmitted online attempt when recording offline payment', () => {
  assert.match(admin, /Record Fully Paid/);
  assert.match(admin, /including a verified cash payment/);
  assert.match(endOfDayMigration, /payment\.status = 'pending_review'/);
  assert.match(endOfDayMigration, /set status = 'expired'/);
  assert.match(endOfDayMigration, /payment\.status = 'created'/);
  assert.match(endOfDayMigration, /recorded manual full payment/);
});

test('forfeiture refuses to split a mixed-payment booking group', () => {
  assert.match(migration, /where not coalesce\(inconsistent\.host_booking, false\)/);
  assert.match(migration, /inconsistent\.payment_status <> 'downpayment_paid'/);
});

test('owners can correct an accidental forfeiture without displacing another booking', () => {
  assert.match(admin, /Restore Fully Paid/);
  assert.match(config, /rpc\('restore_forfeited_host_booking_as_fully_paid'/);
  assert.match(migration, /actor_role not in \('owner', 'court_owner'\)/);
  assert.match(migration, /occupied\.slots && target\.slots/);
  assert.match(migration, /lock table public\.bookings in share row exclusive mode/);
  assert.match(migration, /Prior forfeiture state:/);
  assert.match(migration, /'FORFEITURE_CORRECTION'/);
});
