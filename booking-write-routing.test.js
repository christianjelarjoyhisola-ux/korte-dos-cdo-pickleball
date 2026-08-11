const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const configSource = readFileSync('supabase-config.js', 'utf8');
const indexSource = readFileSync('index.html', 'utf8');
const hostRlsFixSource = readFileSync(
  'supabase/migrations/20260811160000_host_booking_rls_fix.sql',
  'utf8',
);

function extractFunction(name) {
  const start = configSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  const signatureEnd = configSource.indexOf('\n', start);
  const bodyStart = configSource.lastIndexOf('{', signatureEnd);
  assert.ok(bodyStart > start, `${name} must have a function body`);

  let depth = 0;
  for (let i = bodyStart; i < configSource.length; i += 1) {
    if (configSource[i] === '{') depth += 1;
    if (configSource[i] === '}') depth -= 1;
    if (depth === 0) return configSource.slice(start, i + 1);
  }

  throw new Error(`Could not extract ${name}`);
}

function loadRoutingHelpers() {
  const context = {
    _publicBookingSb: { role: 'anon' },
    _sb: { role: 'session' },
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction('isPublicCustomerBookingWrite'),
    extractFunction('isHostBookingHoldWrite'),
    extractFunction('isBookingHoldWrite'),
    extractFunction('bookingMutationClient'),
    extractFunction('shouldDatabaseSetBookingCreatedAt'),
    'this.helpers = {',
    '  isPublicCustomerBookingWrite,',
    '  isHostBookingHoldWrite,',
    '  isBookingHoldWrite,',
    '  bookingMutationClient,',
    '  shouldDatabaseSetBookingCreatedAt,',
    '};',
  ].join('\n'), context);
  return context.helpers;
}

test('public customer writes always use the isolated anon client', () => {
  const helpers = loadRoutingHelpers();
  const guest = { createdVia: 'customer', hostBooking: false };

  assert.equal(helpers.isPublicCustomerBookingWrite(guest), true);
  assert.equal(helpers.bookingMutationClient(guest).role, 'anon');
  assert.equal(
    helpers.bookingMutationClient({}, { asPublicCustomer: true }).role,
    'anon',
  );
});

test('host and dashboard writes retain the authenticated session client', () => {
  const helpers = loadRoutingHelpers();

  assert.equal(
    helpers.bookingMutationClient({ createdVia: 'host', hostBooking: true }).role,
    'session',
  );
  assert.equal(
    helpers.bookingMutationClient({ createdVia: 'admin', hostBooking: false }).role,
    'session',
  );
});

test('customer and host holds leave created_at to the database', () => {
  const helpers = loadRoutingHelpers();
  const context = {
    receivedAccountForBooking: () => 'gcash',
    shouldDatabaseSetBookingCreatedAt:
      helpers.shouldDatabaseSetBookingCreatedAt,
  };
  vm.createContext(context);
  vm.runInContext(
    `${extractFunction('bookingToRow')}\nthis.bookingToRowResult = bookingToRow;`,
    context,
  );

  const base = {
    ref: 'PB-TEST',
    createdAt: '2026-07-25T09:00:00.000Z',
    createdVia: 'customer',
    hostBooking: false,
  };
  const guestRow = context.bookingToRowResult(base);
  const adminRow = context.bookingToRowResult({
    ...base,
    createdVia: 'admin',
  });
  const hostRow = context.bookingToRowResult({
    ...base,
    createdVia: 'host',
    hostBooking: true,
  });

  assert.equal(Object.hasOwn(guestRow, 'created_at'), false);
  assert.equal(adminRow.created_at, base.createdAt);
  assert.equal(Object.hasOwn(hostRow, 'created_at'), false);
});

test('the anonymous client cannot persist or refresh an auth session', () => {
  assert.match(configSource, /const _publicBookingSb = supabase\.createClient/);
  assert.match(configSource, /persistSession:\s*false/);
  assert.match(configSource, /autoRefreshToken:\s*false/);
  assert.match(configSource, /detectSessionInUrl:\s*false/);
});

test('booking insert, finalization, and cancellation use the safe routing', () => {
  assert.match(
    configSource,
    /async addBooking\(booking\) \{\s*const client = bookingMutationClient\(booking\);/,
  );
  assert.match(
    configSource,
    /async updateBooking\(ref, updates, options = \{\}\) \{\s*const client = bookingMutationClient\(updates, options\);/,
  );
  assert.match(indexSource, /asPublicCustomer:\s*current\.createdVia === 'customer'/);
  assert.match(indexSource, /savedHold\?\.createdAt/);
  assert.match(indexSource, /savedBooking\?\.createdAt/);
});

test('customer and host hold inserts do not request private rows back through RLS', () => {
  assert.match(
    configSource,
    /const returnInsertedBooking = !isBookingHoldWrite\(booking\);/,
  );
  assert.match(
    configSource,
    /return returnInsertedBooking\s*\? query\.select\('ref, created_at'\)\.single\(\)\s*:\s*query;/,
  );
});

test('host bookings retain authenticated routing while avoiding INSERT RETURNING', () => {
  const helpers = loadRoutingHelpers();
  const host = { createdVia: 'host', hostBooking: true };

  assert.equal(helpers.isHostBookingHoldWrite(host), true);
  assert.equal(helpers.isBookingHoldWrite(host), true);
  assert.equal(helpers.bookingMutationClient(host).role, 'session');
});

test('host booking reads are limited by RLS to the authenticated host owner', () => {
  assert.match(hostRlsFixSource, /create policy bookings_select_host_own/i);
  assert.match(hostRlsFixSource, /public\.current_account_role\(\) = 'host'/i);
  assert.match(hostRlsFixSource, /host_user_id = auth\.uid\(\)/i);
  assert.match(hostRlsFixSource, /created_by_user_id = auth\.uid\(\)/i);
  assert.doesNotMatch(hostRlsFixSource, /using\s*\(\s*true\s*\)/i);
});

test('public booking finalization and cancellation use narrow RPCs', () => {
  assert.match(
    configSource,
    /client === _publicBookingSb[\s\S]*rpc\('finalize_public_booking_hold'/,
  );
  assert.match(
    configSource,
    /client === _publicBookingSb[\s\S]*rpc\('cancel_public_booking_hold'/,
  );
});
