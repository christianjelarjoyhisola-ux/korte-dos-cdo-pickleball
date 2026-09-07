const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const adminSource = readFileSync('admin.html', 'utf8');

function extractFunction(name) {
  const start = adminSource.lastIndexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = adminSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < adminSource.length; index += 1) {
    if (adminSource[index] === '{') depth += 1;
    if (adminSource[index] === '}') depth -= 1;
    if (depth === 0) return adminSource.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function booking(ref, extra = {}) {
  return {
    ref, fullName: `Customer ${ref}`, email: `${ref}@example.test`,
    courtId: 'court-1', courtName: 'Court 1', date: '2026-09-07',
    startTime: '6:00 PM', endTime: '7:00 PM', slots: [18], duration: 1,
    createdAt: '2026-09-01T00:00:00Z', createdVia: 'customer',
    status: 'confirmed', paymentStatus: 'paid', paymentMethod: 'gcash',
    total: 100, downpayment: 100,
    ...extra,
  };
}

function mixedBookings() {
  return [
    booking('PB-GROUP-A', { groupRef: 'PB-GROUP-G' }),
    booking('PB-GROUP-B', { groupRef: 'PB-GROUP-G', courtId: 'court-2', courtName: 'Court 2', total: 200 }),
    booking('PB-STAFF', { createdVia: 'admin', createdByRole: 'staff', paymentMethod: 'cash', status: 'completed', total: 400 }),
    booking('PB-HOST', { hostBooking: true, total: 500, downpayment: 125, paymentStatus: 'downpayment_paid' }),
    booking('PB-PENDING', { status: 'verifying', paymentStatus: 'for_verification', total: 600 }),
    booking('PB-CANCELLED', { status: 'cancelled', paymentStatus: 'unpaid', total: 700 }),
    booking('PB-FORFEITED', { status: 'forfeited', paymentStatus: 'deposit_retained', total: 800, downpayment: 80 }),
    booking('MANUAL-CASH', { status: 'completed', paymentMethod: 'cash', total: 10000 }),
    booking('LEGACY-METHOD', { status: 'pending', paymentMethod: 'manual', total: 20000 }),
    booking('LEGACY-SNAKE', { status: 'cancelled', paymentMethod: undefined, payment_method: 'MANUAL', total: 30000 }),
    booking('MANUAL-HOST', { hostBooking: true, status: 'completed', total: 40000 }),
    booking('HOLD', { status: 'verifying', email: 'reserve@hold.internal', total: 50000 }),
    // Filter before grouping so an excluded child cannot inflate a real transaction.
    booking('MANUAL-GROUP', { groupRef: 'PB-GROUP-G', courtId: 'court-3', courtName: 'Court 3', total: 60000 }),
    booking('HOLD-GROUP', { groupRef: 'PB-GROUP-G', courtId: 'court-4', courtName: 'Court 4', email: 'reserve@hold.internal', total: 70000 }),
  ];
}

function loadAdmin(bookings, pendingPayments = []) {
  const nodes = new Map();
  const captured = {};
  const context = {
    console,
    Blob,
    Auth: { can: () => false },
    sess: { role: 'owner' },
    DB: {
      getBookings: async () => bookings,
      getCourts: async () => [{ id: 'court-1', name: 'Court 1' }],
      getSettings: async () => ({}),
    },
    window: {
      PB_USE_LOCAL_DATA: false,
      HostBalanceAdmin: { loadPending: async () => pendingPayments },
      BookingBalance: { paidAmount: b => b.downpayment },
    },
    $(id) {
      if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, closest: () => null });
      return nodes.get(id);
    },
    document: { createElement: () => ({ click() { captured.downloaded = true; } }) },
    URL: { createObjectURL(blob) { captured.csv = blob; return 'blob:csv'; } },
    fmt: value => Number(value).toFixed(2),
    fmtD: value => String(value),
    esc: value => String(value || ''),
    jsArg: value => String(value || ''),
    statusBdg: value => String(value || ''),
    renderMaintFee() {},
    renderDashCharts(groups) { captured.chartGroups = groups; },
    autoCompleteBookings: async () => 0,
    toast() {},
    parsePricingTiers: () => [],
    _calGetMtRulesForDate: () => [],
    renderCalendarDayPanel(date, rows, counts) { captured.calendar = { date, rows, counts }; },
    calMaintenanceRuleForHour: () => null,
    _nbIsOpenPlayHour: () => false,
    calIsPastSlot: () => false,
    _nbGetRateForHour: () => 100,
  };
  // Render the real table and navigation; stub only unrelated cell presentation.
  for (const name of [
    'mobileBookingCard', 'bookingSourceBadge', 'bookingAmountSummaryHtml',
    'duplicatePaymentRefBadge', 'bookingPayStateSelect', 'receiptBadge', 'bookingActionsHtml',
  ]) context[name] = () => '';
  vm.createContext(context);
  const helpers = [
    'isManualImportBooking', 'isPlaceholderHold', 'isCancelledBooking',
    'isScheduleActiveBooking', 'isDashboardReportBooking', 'isDashboardActiveBooking',
    'bookingStartHour', 'sortBookingsChronologically', 'bookingGroupKey',
    'normalizedPaymentRefKey', 'commonBookingPrefix', 'commonValue', 'bookingGroupStatus',
    'bookingGroupReceiptStatus', 'bookingLogicalKey', 'uniqueBookingGroupItems',
    'bookingGroupCourtLabel', 'bookingGroupDateLabel', 'bookingGroupTimeLabel',
    'bookingGroupScheduleLabel', 'groupBookings', 'receivedAccountKey', 'receivedAccountLabel',
    'paymentMethodLabel', 'isDigitalPayment', 'bookingNavigationBucket',
    'bookingPendingBalancePayments', 'attachPendingHostBalancePayments', 'bookingHasPendingReview',
    'bookingMatchesNavigation', 'bookingNavigationCounts', 'bookingViewNoun',
    'updateBookingNavCount', 'bookingFilters', 'bookingFiltersActive', 'updateBookingFilterMeta',
    'updateBookingPagination', 'calSlotState', 'calSlotCardHtml',
  ];
  vm.runInContext([
    "let _bookingType = 'all', _bookingRenderSeq = 0, _bookingPage = 1, _bookingPageSize = 50;",
    "let _balanceProcessorStarted = true, _curSection = 'bookings';",
    'let calMonth = 8, calYear = 2026, calSelectedDate = "2026-09-07";',
    'let _nbOpenHour, _nbCloseHour, _nbOpenPlayCfg, _nbMaintenanceCfg, _nbPricingTiers;',
    "const BOOKING_VIEW_NOUNS = { all: ['booking', 'bookings'] };",
    ...helpers.map(extractFunction),
    ...['renderDash', 'renderBookings', 'exportCSV', 'renderCalendar'].map(name => `async ${extractFunction(name)}`),
    'this.setView = view => { _bookingType = view; };',
  ].join('\n'), context);
  return { context, nodes, captured };
}

test('dashboard total and every booking tab use the same system-only grouped population', async () => {
  const rows = mixedBookings();
  const original = JSON.stringify(rows);
  const { context, nodes, captured } = loadAdmin(rows, [
    { paymentId: 'HOST-BALANCE', bookingRef: 'PB-HOST', status: 'pending_review' },
    { paymentId: 'LEGACY-BALANCE', bookingRef: 'MANUAL-HOST', status: 'pending_review' },
  ]);
  await context.renderDash();
  await context.renderBookings();

  assert.equal(Number(nodes.get('dTotal').textContent), 6);
  assert.equal(nodes.get('bookingCountAll').textContent, '6');
  assert.equal(Number(nodes.get('dTotal').textContent), Number(nodes.get('bookingCountAll').textContent));
  const expectedCounts = { Pending: 2, Confirmed: 1, Completed: 1, Closed: 2, Host: 1 };
  for (const [name, count] of Object.entries(expectedCounts)) {
    assert.equal(nodes.get(`bookingCount${name}`).textContent, String(count), name);
  }
  const table = nodes.get('bookBody').innerHTML;
  assert.equal((table.match(/class="booking-row"/g) || []).length, 6);
  assert.match(table, /Customer PB-STAFF/);
  assert.match(table, /Customer PB-HOST/);
  assert.match(table, /Customer PB-CANCELLED/);
  assert.doesNotMatch(table, /MANUAL-|LEGACY-|Customer HOLD|reserve@hold\.internal/);

  assert.equal(nodes.get('dRev').textContent, '1880.00', 'existing active revenue plus retained deposits is preserved');
  assert.equal(nodes.get('pCash').textContent, '400.00', 'real staff cash payments stay included');
  assert.equal(nodes.get('pGcash').textContent, '1480.00');
  assert.equal(captured.chartGroups.length, 4, 'charts retain the active-only policy');
  const group = captured.chartGroups.find(b => b.groupRef === 'PB-GROUP-G');
  assert.equal(group.items.length, 2);
  assert.equal(group.total, 300, 'excluded children must not enter grouping or revenue');

  for (const [view, count] of Object.entries({ pending: 2, confirmed: 1, completed: 1, closed: 2, host: 1 })) {
    context.setView(view);
    await context.renderBookings();
    const html = nodes.get('bookBody').innerHTML;
    assert.equal((html.match(/class="booking-row"/g) || []).length, count, view);
    assert.doesNotMatch(html, /MANUAL-|LEGACY-|Customer HOLD|reserve@hold\.internal/, view);
  }
  assert.equal(JSON.stringify(rows), original, 'display filtering must not change stored bookings');
});

test('all system statuses stay counted beyond 1,000 records while the table remains paginated', async () => {
  const rows = Array.from({ length: 1105 }, (_, index) => booking(`PB-${index}`, {
    status: index % 2 ? 'cancelled' : 'completed',
  }));
  const { context, nodes } = loadAdmin(rows);
  await context.renderDash();
  await context.renderBookings();
  assert.equal(Number(nodes.get('dTotal').textContent), 1105);
  assert.equal(nodes.get('bookingCountAll').textContent, '1105');
  assert.equal((nodes.get('bookBody').innerHTML.match(/class="booking-row"/g) || []).length, 50);
  assert.match(nodes.get('bookingPageMeta').textContent, /1-50 of 1105/);
});

test('booking CSV exports system bookings across all statuses without imports or holds', async () => {
  const { context, captured } = loadAdmin(mixedBookings());
  await context.exportCSV();
  assert.equal(captured.downloaded, true);
  const csv = await captured.csv.text();
  assert.equal(csv.split('\n').length, 7, 'header plus six grouped system reservations');
  assert.match(csv, /PB-STAFF/);
  assert.match(csv, /PB-HOST/);
  assert.match(csv, /PB-CANCELLED/);
  assert.match(csv, /PB-FORFEITED/);
  assert.doesNotMatch(csv, /MANUAL-|LEGACY-|HOLD|reserve@hold\.internal/);
});

test('calendar counts omit imported history but imported reservations still block occupied slots', async () => {
  const rows = mixedBookings();
  const { context, nodes, captured } = loadAdmin(rows);
  await context.renderCalendar();
  assert.equal(captured.calendar.counts['2026-09-07'].total, 5, 'calendar counts active system court rows');
  assert.match(nodes.get('calGrid').innerHTML, /5 bkgs/);
  assert.equal(captured.calendar.rows, rows, 'the availability board receives all occupied reservations');

  const imported = rows.find(b => b.ref === 'MANUAL-CASH');
  assert.equal(context.isScheduleActiveBooking(imported), true, 'imports must keep reserving their court slots');
  const state = context.calSlotState('2026-09-07', 18, { id: 'court-1' }, new Map([['court-1|18', imported]]));
  assert.deepEqual({ ...state }, { type: 'blocked', label: 'Unavailable', title: 'Reserved slot', meta: 'Not bookable' });
  const card = context.calSlotCardHtml('2026-09-07', 18, { id: 'court-1' }, state);
  assert.match(card, /cal-slot-card blocked/);
  assert.doesNotMatch(card, /<button|calOpenBookingSlot|MANUAL-CASH/);
  const real = rows.find(b => b.ref === 'PB-STAFF');
  const realState = context.calSlotState('2026-09-07', 18, { id: 'court-1' }, new Map([['court-1|18', real]]));
  assert.equal(realState.type, 'completed');
  assert.equal(realState.booking, real);
});
