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

function extractLastFunction(name) {
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

function loadNavigationHelpers() {
  const context = {};
  vm.createContext(context);
  vm.runInContext([
    "let _bookingType = 'all';",
    extractFunction('bookingNavigationBucket'),
    extractFunction('bookingMatchesNavigation'),
    'this.helpers = { bookingNavigationBucket, bookingMatchesNavigation };',
  ].join('\n'), context);
  return context.helpers;
}

test('navigation counts grouped reservations once and assigns every top-level bucket', () => {
  const { bookingNavigationBucket } = loadNavigationHelpers();
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
  const counts = { all: groupedReservations.length, pending: 0, confirmed: 0, completed: 0, closed: 0, host: 0 };
  groupedReservations.forEach(group => { counts[bookingNavigationBucket(group)] += 1; });

  assert.deepEqual(counts, { all: 5, pending: 1, confirmed: 1, completed: 1, closed: 1, host: 1 });
  assert.match(adminSource, /const allGroups = groupBookings\(bks\);[\s\S]*?const bucket = bookingNavigationBucket\(group\);[\s\S]*?viewCounts\[bucket\]\+\+;[\s\S]*?bookingMatchesNavigation\(group, 'pending'\)/);
  assert.match(adminSource, /let filteredBookings = allGroups\.filter\(group => bookingMatchesNavigation\(group\)\);/);
});

test('host bookings stay isolated while rejected, failed, and forfeited states take closed precedence', () => {
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

test('pending balance receipts replace the misleading Balance Due controls with review actions', () => {
  const context = {
    sess: { role: 'owner' },
    quickPaymentApprovalButton: () => '',
    bookingDetailsButton: () => '<button>Details</button>',
    canRescheduleBooking: () => false,
    jsArg: value => String(value || ''),
    payStatusBdg: value => `<span>${value}</span>`,
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction('pendingHostBalanceReview'),
    extractFunction('bookingNavigationBucket'),
    extractFunction('bookingMatchesNavigation'),
    extractLastFunction('bookingPayStateSelect'),
    extractLastFunction('bookingActionsHtml'),
    'this.helpers = { bookingMatchesNavigation, bookingPayStateSelect, bookingActionsHtml };',
  ].join('\n'), context);

  const pending = {
    hostBooking: true,
    status: 'confirmed',
    paymentStatus: 'downpayment_paid',
    primaryRef: 'PB-MS989GK0-YMMS-G',
    pendingBalancePayment: {
      status: 'pending_review',
      verificationRef: 'HBAL-164B4109DE70447F92CCEC26EEE82D99',
    },
  };
  const pendingState = context.helpers.bookingPayStateSelect(pending);
  const pendingActions = context.helpers.bookingActionsHtml(pending, true);
  assert.match(pendingState, /Balance Payment Pending Review/);
  assert.doesNotMatch(pendingState, /<select/);
  assert.match(pendingActions, /Review Balance Receipt/);
  assert.match(pendingActions, /HBAL-164B4109DE70447F92CCEC26EEE82D99/);
  assert.doesNotMatch(pendingActions, /Balance Reminder/);
  assert.doesNotMatch(pendingActions, /Record Fully Paid/);
  assert.equal(context.helpers.bookingMatchesNavigation(pending, 'pending'), true);
  assert.equal(context.helpers.bookingMatchesNavigation(pending, 'host'), true);

  const due = { ...pending, pendingBalancePayment: null, email: 'player@example.com' };
  assert.match(context.helpers.bookingPayStateSelect(due), /Balance Due/);
  assert.match(context.helpers.bookingActionsHtml(due, true), /Balance Reminder/);
  assert.match(context.helpers.bookingActionsHtml(due, true), /Record Fully Paid/);
});

test('booking rows join grouped bookings to pending balance records and refresh them live', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext([
    extractFunction('attachPendingHostBalanceReviews'),
    'this.attachPendingHostBalanceReviews = attachPendingHostBalanceReviews;',
  ].join('\n'), context);
  const groups = [{
    groupRef: 'PB-MS989GK0-YMMS-G',
    refs: ['PB-MS989GK0-YMMS-1', 'PB-MS989GK0-YMMS-2'],
  }];
  const payment = {
    status: 'pending_review',
    bookingKey: 'PB-MS989GK0-YMMS-G',
    verificationRef: 'HBAL-164B4109DE70447F92CCEC26EEE82D99',
  };
  context.attachPendingHostBalanceReviews(groups, [payment]);
  assert.equal(groups[0].pendingBalancePayment, payment);
  assert.match(adminSource, /HostBalanceAdmin\?\.render\?\.\(false\)/);
  assert.match(adminSource, /table:'host_booking_balance_payments'/);
  assert.match(adminSource, /rerenderHostBalances/);
});
