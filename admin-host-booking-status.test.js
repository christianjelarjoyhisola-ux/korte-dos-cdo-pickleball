const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const adminSource = readFileSync('admin.html', 'utf8');

function extractFunction(name) {
  const start = adminSource.indexOf(`function ${name}(`);
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

function loadNavigationHelpers() {
  const context = {};
  vm.createContext(context);
  vm.runInContext([
    "let _bookingType = 'all';",
    "const BOOKING_VIEW_VALUES = new Set(['all','pending','confirmed','completed','closed','host']);",
    extractFunction('bookingPendingBalancePayments'),
    extractFunction('attachPendingHostBalancePayments'),
    extractFunction('bookingHasPendingReview'),
    extractFunction('bookingNavigationBucket'),
    extractFunction('bookingMatchesNavigation'),
    extractFunction('bookingNavigationCounts'),
    'this.helpers = { bookingPendingBalancePayments, attachPendingHostBalancePayments, bookingHasPendingReview, bookingNavigationBucket, bookingMatchesNavigation, bookingNavigationCounts };',
  ].join('\n'), context);
  return context.helpers;
}

test('navigation counts grouped reservations once in each applicable view', () => {
  const { bookingNavigationCounts } = loadNavigationHelpers();
  const groupedReservations = [
    {
      displayRef: 'PB-MULTI',
      isGroup: true,
      refs: ['PB-MULTI-A', 'PB-MULTI-B', 'PB-MULTI-C'],
      items: [{}, {}, {}],
      status: 'confirmed',
      paymentStatus: 'paid',
      hostBooking: false,
    },
    { displayRef: 'PB-PENDING', status: 'verifying', paymentStatus: 'for_verification', hostBooking: false },
    { displayRef: 'PB-COMPLETE', status: 'completed', paymentStatus: 'paid', hostBooking: false },
    { displayRef: 'PB-CLOSED', status: 'cancelled', paymentStatus: 'unpaid', hostBooking: false },
    { displayRef: 'PB-HOST', status: 'confirmed', paymentStatus: 'paid', hostBooking: true },
  ];
  const counts = bookingNavigationCounts(groupedReservations);

  assert.deepEqual({ ...counts }, { all: 5, pending: 1, confirmed: 1, completed: 1, closed: 1, host: 1 });
  assert.match(adminSource, /bookingNavigationCounts\(allGroups\)/);
  assert.match(adminSource, /let filteredBookings = allGroups\.filter\(group => bookingMatchesNavigation\(group\)\);/);
});

test('host bookings keep their host view while regular rejected, failed, and forfeited states take closed precedence', () => {
  const { bookingNavigationBucket, bookingMatchesNavigation } = loadNavigationHelpers();

  for (const booking of [
    { hostBooking: true, status: 'pending', paymentStatus: 'unpaid' },
    { hostBooking: true, status: 'confirmed', paymentStatus: 'rejected' },
    { hostBooking: true, status: 'completed', paymentStatus: 'failed' },
    { hostBooking: true, status: 'forfeited', paymentStatus: 'deposit_retained' },
  ]) {
    assert.equal(bookingNavigationBucket(booking), 'host');
    assert.equal(bookingMatchesNavigation(booking, 'host'), true);
    assert.equal(bookingMatchesNavigation(booking, 'closed'), false);
  }

  assert.equal(bookingNavigationBucket({ status: 'confirmed', paymentStatus: 'rejected' }), 'closed');
  assert.equal(bookingNavigationBucket({ status: 'completed', paymentStatus: 'failed' }), 'closed');
  assert.equal(bookingNavigationBucket({ status: 'forfeited', paymentStatus: 'paid' }), 'closed');
  assert.equal(bookingNavigationBucket({ status: 'confirmed', paymentStatus: 'deposit_retained' }), 'closed');
  assert.equal(bookingNavigationBucket({ status: 'confirmed', paymentStatus: 'paid' }), 'confirmed');
  assert.equal(bookingNavigationBucket({ status: 'completed', paymentStatus: 'paid' }), 'completed');
  assert.equal(bookingNavigationBucket({ status: 'verifying', paymentStatus: 'for_verification' }), 'pending');
  assert.equal(bookingMatchesNavigation({ hostBooking: true }, 'all'), true);
});

test('confirmed host reservations awaiting balance review appear in Pending and Open Host without changing payment totals', () => {
  const { attachPendingHostBalancePayments, bookingNavigationBucket, bookingMatchesNavigation, bookingNavigationCounts } = loadNavigationHelpers();
  const booking = {
    ref: 'HOST-A',
    primaryRef: 'HOST-A',
    groupRef: 'HOST-GROUP',
    displayRef: 'HOST-DISPLAY',
    refs: ['HOST-A', 'HOST-B'],
    items: [{ ref: 'HOST-A' }, { ref: 'HOST-B' }],
    isGroup: true,
    hostBooking: true,
    status: 'confirmed',
    paymentStatus: 'downpayment_paid',
    total: 3240,
    downpayment: 877.5,
  };
  const payment = { paymentId: 'BALANCE-1', bookingKey: 'HOST-GROUP', status: 'pending_review', expectedAmount: 2362.5 };
  const snapshot = JSON.stringify(booking);
  const groups = attachPendingHostBalancePayments([booking], [payment, { ...payment, paymentId: 'BALANCE-2' }]);

  assert.equal(groups.length, 1, 'a multi-slot reservation remains one displayed group');
  assert.equal(groups[0].pendingBalancePayments.length, 2);
  assert.equal(bookingNavigationBucket(groups[0]), 'host');
  assert.equal(bookingMatchesNavigation(groups[0], 'pending'), true);
  assert.equal(bookingMatchesNavigation(groups[0], 'host'), true);
  assert.equal(bookingMatchesNavigation(groups[0], 'confirmed'), false);
  assert.deepEqual({ ...bookingNavigationCounts(groups) }, { all: 1, pending: 1, confirmed: 0, completed: 0, closed: 0, host: 1 });
  for (const key of ['status', 'paymentStatus', 'total', 'downpayment']) {
    assert.equal(groups[0][key], booking[key], `${key} must remain unchanged until approval`);
  }
  assert.equal(JSON.stringify(booking), snapshot, 'joining the review queue must not mutate the reservation');
});

test('balance queue joins canonical keys and member references and excludes settled or unrelated attempts', () => {
  const { attachPendingHostBalancePayments, bookingPendingBalancePayments, bookingMatchesNavigation } = loadNavigationHelpers();
  const booking = {
    ref: 'HOST-A', primaryRef: 'HOST-A', groupRef: 'HOST-GROUP', displayRef: 'HOST-DISPLAY',
    refs: ['HOST-A', 'HOST-B'], items: [{ ref: 'HOST-C' }],
    hostBooking: true, status: 'confirmed', paymentStatus: 'downpayment_paid', total: 3240, downpayment: 877.5,
  };
  for (const identity of [
    { bookingKey: 'HOST-GROUP' },
    { bookingGroupRef: 'HOST-GROUP' },
    { bookingRef: 'HOST-A' },
    { bookingKey: 'HOST-DISPLAY' },
    { bookingRefs: ['HOST-B'] },
    { bookingRefs: ['HOST-C'] },
  ]) {
    const payment = { paymentId: 'PENDING', status: 'pending_review', ...identity };
    const [joined] = attachPendingHostBalancePayments([booking], [payment]);
    assert.equal(bookingPendingBalancePayments(joined).length, 1, JSON.stringify(identity));
    assert.equal(bookingMatchesNavigation(joined, 'pending'), true);
  }
  const [withoutPending] = attachPendingHostBalancePayments([booking], [
    { paymentId: 'APPROVED', status: 'approved', bookingKey: 'HOST-GROUP' },
    { paymentId: 'REJECTED', status: 'rejected', bookingKey: 'HOST-GROUP' },
    { paymentId: 'EXPIRED', status: 'expired', bookingKey: 'HOST-GROUP' },
    { paymentId: 'UNRELATED', status: 'pending_review', bookingKey: 'ANOTHER-GROUP' },
  ]);
  assert.equal(bookingPendingBalancePayments(withoutPending).length, 0);
  assert.equal(bookingMatchesNavigation(withoutPending, 'pending'), false);
});

test('initial host deposits awaiting review also appear in Pending but approved balances leave that queue', () => {
  const { bookingMatchesNavigation, bookingPendingBalancePayments } = loadNavigationHelpers();
  for (const state of [
    { status: 'pending', paymentStatus: 'unpaid' },
    { status: 'verifying', paymentStatus: 'for_verification' },
    { status: 'confirmed', paymentStatus: 'for_verification' },
  ]) {
    const booking = { hostBooking: true, ...state };
    assert.equal(bookingMatchesNavigation(booking, 'pending'), true);
    assert.equal(bookingMatchesNavigation(booking, 'host'), true);
  }
  const settled = {
    hostBooking: true, status: 'confirmed', paymentStatus: 'paid',
    pendingBalancePayments: [{ paymentId: 'PAID', status: 'approved' }],
  };
  assert.equal(bookingPendingBalancePayments(settled).length, 0);
  assert.equal(bookingMatchesNavigation(settled, 'pending'), false);
  assert.equal(bookingMatchesNavigation(settled, 'host'), true);
});

test('a failed balance queue read shows a retry state instead of claiming Pending is empty', async () => {
  const nodes = { bookBody: {}, bookingCountPending: { textContent: '0' }, bookingFilterMeta: {} };
  const queueReads = [];
  const context = {
    Auth: { can: () => true },
    sess: { role: 'owner' },
    DB: { getBookings: async () => [] },
    window: {
      HostBalanceAdmin: {
        async loadPending(force) {
          queueReads.push(force);
          throw new Error('balance queue unavailable');
        },
      },
    },
    console: { error() {} },
    $: id => nodes[id],
    updateBookingFilterMeta() {},
    bookingFilters: () => ({}),
  };
  vm.createContext(context);
  vm.runInContext([
    'let _bookingRenderSeq = 0;',
    `async ${extractFunction('renderBookings')}`,
    'this.renderBookings = renderBookings;',
  ].join('\n'), context);

  await context.renderBookings();

  assert.deepEqual(queueReads, [true], 'the booking list must request current pending balances');
  assert.equal(nodes.bookingCountPending.textContent, '?');
  assert.match(nodes.bookingFilterMeta.textContent, /could not be loaded/i);
  assert.match(nodes.bookBody.innerHTML, /Could not load bookings or pending balance payments/);
  assert.match(nodes.bookBody.innerHTML, /Retry/);
  assert.doesNotMatch(nodes.bookBody.innerHTML, /No pending bookings/);
});

test('changing a booking view resets pagination and synchronizes pressed state', () => {
  let renderCount = 0;
  const buttons = ['all', 'pending', 'confirmed', 'completed', 'closed', 'host'].map(type => ({
    dataset: { bookingType: type },
    active: false,
    attributes: {},
    classList: { toggle(_name, active) { this.owner.active = active; } },
    setAttribute(name, value) { this.attributes[name] = value; },
  }));
  buttons.forEach(button => { button.classList.owner = button; });
  const nav = { scrollWidth: 100, clientWidth: 100 };
  const context = {
    document: { querySelectorAll: () => buttons },
    requestAnimationFrame: callback => callback(),
    renderBookings: () => { renderCount += 1; },
    $(id) { return id === 'bookingTypeTabs' ? nav : null; },
  };
  vm.createContext(context);
  vm.runInContext([
    "let _bookingType = 'all';",
    'let _bookingPage = 7;',
    "const BOOKING_VIEW_VALUES = new Set(['all','pending','confirmed','completed','closed','host']);",
    extractFunction('setBookingType'),
    'this.setBookingType = setBookingType;',
    'this.navigationState = () => ({ type: _bookingType, page: _bookingPage });',
  ].join('\n'), context);

  context.setBookingType('completed');
  assert.equal(context.navigationState().type, 'completed');
  assert.equal(context.navigationState().page, 1);
  assert.equal(buttons.find(button => button.dataset.bookingType === 'completed').attributes['aria-pressed'], 'true');
  assert.equal(buttons.find(button => button.dataset.bookingType === 'all').attributes['aria-pressed'], 'false');

  context.setBookingType('not-a-view');
  assert.equal(context.navigationState().type, 'all');
  assert.equal(context.navigationState().page, 1);
  assert.equal(renderCount, 2);
});

test('booking view control is accessible, single-line on mobile, and replaces the status select', () => {
  const navMarkup = adminSource.match(/<div class="booking-type-tabs" id="bookingTypeTabs"[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(navMarkup, /role="group" aria-label="Booking views"/);
  assert.doesNotMatch(navMarkup, /role="tablist"/);
  assert.equal((navMarkup.match(/class="booking-type-tab(?:\s|")/g) || []).length, 6);
  assert.equal((navMarkup.match(/type="button"/g) || []).length, 6);
  assert.equal((navMarkup.match(/aria-pressed="(?:true|false)"/g) || []).length, 6);
  assert.equal((navMarkup.match(/aria-hidden="true"/g) || []).length, 6);
  for (const view of ['all', 'pending', 'confirmed', 'completed', 'closed', 'host']) {
    assert.match(navMarkup, new RegExp(`data-booking-type="${view}"`));
  }
  assert.match(adminSource, /function updateBookingNavCount[\s\S]*?button\.setAttribute\('aria-label'/);
  assert.match(adminSource, /id="bookingFilterMeta" aria-live="polite"/);

  const railCss = adminSource.match(/\.booking-type-tabs\s*\{[^}]+\}/)?.[0] || '';
  const buttonCss = adminSource.match(/\.booking-type-tab\s*\{[^}]+\}/)?.[0] || '';
  assert.match(railCss, /display:flex/);
  assert.match(railCss, /overflow-x:auto/);
  assert.match(railCss, /scroll-snap-type:x proximity/);
  assert.match(buttonCss, /flex:0 0 auto/);
  assert.match(buttonCss, /white-space:nowrap/);
  assert.match(buttonCss, /min-height:40px/);
  assert.match(adminSource, /@media \(max-width: 700px\)[\s\S]*?#sec-bookings \.booking-type-tab \{ min-height:44px;/);

  assert.doesNotMatch(adminSource, /\bid="fStatus"/);
  assert.doesNotMatch(adminSource, /\bfor="fStatus"/);
  assert.doesNotMatch(adminSource, /aria-label="Filter bookings by status"/);
});
