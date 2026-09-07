const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');

function bookingRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    ref: `PB-${String(index).padStart(6, '0')}`,
    created_at: '2026-09-01T00:00:00.000Z',
    full_name: `Booking ${index}`,
    email: index % 7 === 0 ? 'reserve@hold.internal' : 'customer@example.test',
    date: index % 2 === 0 ? '2026-09-07' : '2026-09-08',
    court_id: String(index % 3),
    host_user_id: index % 4 === 0 ? 'host-a' : 'host-b',
    status: index % 5 === 0 ? 'cancelled' : index % 11 === 0 ? 'forfeited' : 'confirmed',
    payment_status: 'paid',
    total: 300,
    slots: ['18'],
  }));
}

function loadDB(rows, { cap = 1000, pathname = '/admin', authenticated = true, beforePage } = {}) {
  const requests = [];
  const rpcRequests = [];
  const errors = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session: authenticated ? { access_token: 'test-session' } : null } }),
    },
    from(table) {
      assert.equal(table, 'bookings');
      const request = { filters: [], orders: [], range: null, count: undefined };
      const query = {
        select(columns, options = {}) {
          assert.equal(columns, '*');
          request.count = options.count;
          return query;
        },
        order(column, options) { request.orders.push({ column, ...options }); return query; },
        eq(column, value) { request.filters.push({ column, value, operator: 'eq' }); return query; },
        neq(column, value) { request.filters.push({ column, value, operator: 'neq' }); return query; },
        range(from, to) { request.range = [from, to]; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            requests.push(request);
            const error = beforePage?.(requests.length, rows);
            if (error) return { data: null, count: null, error };
            const matching = rows.filter(row => request.filters.every(filter =>
              filter.operator === 'eq'
                ? row[filter.column] === filter.value
                : row[filter.column] !== filter.value));
            matching.sort((a, b) => {
              for (const { column, ascending } of request.orders) {
                const comparison = String(a[column]).localeCompare(String(b[column]));
                if (comparison) return ascending ? comparison : -comparison;
              }
              return 0;
            });
            const [from, to] = request.range || [0, cap - 1];
            // An out-of-bounds page must not be needed to discover the row cap.
            if (from > 0 && from >= matching.length) {
              return { data: null, error: { code: 'PGRST103', message: 'Range out of bounds' }, count: null };
            }
            return {
              data: matching.slice(from, Math.min(to + 1, from + cap)),
              count: request.count === 'exact' ? matching.length : null,
              error: null,
            };
          }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) {
      rpcRequests.push({ name, args: { ...args } });
      return { data: [{ court_id: '2', date: args.p_date, slots: ['18'], status: 'confirmed' }], error: null };
    },
  };
  const context = {
    console: { error: (...args) => errors.push(args) },
    location: { hostname: 'kortedoscdo.club', pathname, search: '' },
    localStorage: { getItem: () => null, removeItem() {} },
    supabase: { createClient: () => client },
    structuredClone,
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'supabase-config.js' });
  return { DB: context.DB, requests, rpcRequests, errors };
}

test('private bookings include complete history beyond the response cap, including split groups', async () => {
  const rows = bookingRows(1307);
  for (const index of [306, 307]) {
    rows[index].booking_group_ref = 'PB-MULTI-COURT';
    rows[index].status = 'confirmed';
    rows[index].email = 'customer@example.test';
  }
  const { DB, requests } = loadDB(rows);
  const bookings = await DB.getBookings();

  assert.equal(bookings.length, rows.length);
  assert.deepEqual(bookings.map(booking => booking.ref), rows.map(row => row.ref).reverse());
  assert.equal(bookings.at(-1).fullName, 'Booking 0', 'older records must retain the normal row mapping');
  assert.ok(bookings.some(booking => booking.status === 'cancelled'));
  assert.ok(bookings.some(booking => booking.email === 'reserve@hold.internal'));
  const group = bookings.filter(booking => booking.groupRef === 'PB-MULTI-COURT');
  assert.equal(group.length, 2, 'a grouped reservation can straddle the 1,000-row boundary');
  assert.equal(group.reduce((total, booking) => total + booking.total, 0), 600);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.orders, [
      { column: 'created_at', ascending: false },
      { column: 'ref', ascending: false },
    ]);
  }
});

test('smaller backend caps advance by returned rows and cache the complete mapped result', async () => {
  const { DB, requests } = loadDB(bookingRows(325), { cap: 125 });
  const bookings = await DB.getBookings();
  assert.equal(bookings.length, 325);
  assert.deepEqual(requests.map(request => request.range[0]), [0, 125, 250]);
  assert.deepEqual(requests.map(request => request.count), ['exact', undefined, undefined]);
  bookings.pop();
  assert.equal((await DB.getBookings()).length, 325, 'caller mutations must not corrupt cached history');
  assert.equal(requests.length, 3, 'the existing cache must cover all pages');
});

test('empty histories and exact page boundaries do not request an out-of-bounds page', async () => {
  for (const count of [0, 999, 1000, 1001, 2000]) {
    const { DB, requests, errors } = loadDB(bookingRows(count));
    assert.equal((await DB.getBookings()).length, count);
    assert.equal(requests.length, Math.max(1, Math.ceil(count / 1000)));
    assert.equal(errors.length, 0);
  }
});

test('all private filters apply before counting and to every page', async () => {
  const rows = bookingRows(250);
  for (const filters of [
    { date: '2026-09-07' },
    { courtId: 2 },
    { hostUserId: 'host-a' },
    { activeOnly: true },
    { date: '2026-09-07', courtId: 2, hostUserId: 'host-a', activeOnly: true },
  ]) {
    const { DB, requests, errors } = loadDB(rows, { cap: 3 });
    const bookings = await DB.getBookings(filters);
    const expected = rows.filter(row =>
      (!filters.date || row.date === filters.date)
      && (!filters.courtId || row.court_id === String(filters.courtId))
      && (!filters.hostUserId || row.host_user_id === filters.hostUserId)
      && (!filters.activeOnly || !['cancelled', 'forfeited'].includes(row.status)));
    assert.deepEqual(bookings.map(booking => booking.ref), expected.map(row => row.ref).reverse());
    assert.ok(requests.length > 1);
    for (const request of requests) assert.deepEqual(request.filters, requests[0].filters);
    assert.equal(errors.length, 0);
  }
});

test('new bookings between pages do not duplicate older reservations', async () => {
  for (const count of [4, 5]) {
    const rows = bookingRows(count);
    const { DB } = loadDB(rows, {
      cap: 2,
      beforePage(page, currentRows) {
        if (page === 2) currentRows.push({ ...currentRows[0], ref: 'PB-NEW', created_at: '2026-09-02T00:00:00.000Z' });
      },
    });
    const bookings = await DB.getBookings();
    assert.deepEqual(bookings.map(booking => booking.ref), bookingRows(count).map(row => row.ref).reverse());
  }
});

test('a later-page failure discards partial data and retains host error propagation', async () => {
  const failure = { code: '42501', message: 'Permission denied' };
  const normal = loadDB(bookingRows(5), { cap: 2, beforePage: page => page === 2 ? failure : null });
  assert.deepEqual(await normal.DB.getBookings(), []);
  assert.equal(normal.errors.length, 1);

  const host = loadDB(bookingRows(12), { cap: 2, beforePage: page => page === 2 ? failure : null });
  await assert.rejects(host.DB.getBookings({ hostUserId: 'host-a' }), error => error === failure);
  assert.equal(host.errors.length, 1);
  assert.equal((await host.DB.getBookings({ hostUserId: 'host-a' })).length, 3,
    'failed host requests must be removed from the cache so a retry can succeed');
});

test('public pages and unauthenticated admin pages retain date-scoped slot RPC reads', async () => {
  for (const options of [{ pathname: '/' }, { authenticated: false }]) {
    const { DB, requests, rpcRequests } = loadDB(bookingRows(1307), options);
    assert.equal((await DB.getBookings()).length, 0);
    const slots = await DB.getBookings({ date: '2026-09-07', courtId: 2 });
    assert.equal(slots.length, 1);
    assert.equal(slots[0].courtId, '2');
    assert.equal(requests.length, 0);
    assert.deepEqual(rpcRequests, [{
      name: 'public_booking_slots',
      args: { p_date: '2026-09-07', p_court_id: '2' },
    }]);
  }
});
