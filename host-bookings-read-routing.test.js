const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const config = fs.readFileSync(path.join(root, 'supabase-config.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260811150000_host_my_bookings_rpc.sql'),
  'utf8',
);

test('host My Bookings uses its identity-scoped RPC instead of general booking reads', () => {
  assert.match(config, /async getMyHostBookings\(\)[\s\S]*?\.rpc\('get_my_host_bookings'\)/);
  assert.match(index, /const all = await DB\.getMyHostBookings\(\);/);
  assert.doesNotMatch(index, /DB\.getBookings\(\{\s*hostUserId:/);
});

test('host booking RPC derives ownership from auth uid and rejects public execution', () => {
  assert.match(migration, /caller_id uuid := auth\.uid\(\)/);
  assert.match(migration, /b\.host_user_id = caller_id/);
  assert.match(migration, /a\.role = 'host'/);
  assert.match(migration, /revoke all on function public\.get_my_host_bookings\(\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.get_my_host_bookings\(\) to authenticated/);
});

test('public homepage remains outside the general private booking surface', () => {
  assert.match(config, /const PB_PRIVATE_DATA_SURFACE = \/\^\\\/\(\?:admin\|signature-view\)/);
});
