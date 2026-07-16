const assert = require('node:assert/strict');
const test = require('node:test');
const balance = require('./booking-balance.js');

test('one-month advance host booking allows a 25% reservation payment', () => {
  const booking = { date: '2026-08-31', startTime: '6:00 PM' };
  assert.equal(balance.depositEligible(booking, new Date('2026-08-01T10:00:00+08:00')), true);
  assert.equal(balance.balanceDeadline(booking).toISOString(), '2026-08-26T10:00:00.000Z');
});

test('full payment is required at exactly five days before start', () => {
  const booking = { date: '2026-08-31', startTime: '6:00 PM' };
  assert.equal(balance.depositEligible(booking, new Date('2026-08-26T18:00:00+08:00')), false);
});

test('forfeited bookings release their slot while retaining the verified deposit', () => {
  const booking = { status: 'forfeited', paymentStatus: 'deposit_retained', total: 1000, downpayment: 250 };
  assert.equal(balance.holdsSlot(booking), false);
  assert.equal(balance.paidAmount(booking), 250);
  assert.equal(balance.balanceAmount(booking), 750);
});

test('group deadline uses the earliest scheduled start', () => {
  const items = [
    { date: '2026-09-01', startTime: '8:00 PM' },
    { date: '2026-09-01', startTime: '6:00 PM' },
  ];
  assert.equal(balance.balanceDeadline(items).toISOString(), '2026-08-27T10:00:00.000Z');
});

test('court revenue splits a grouped booking into its actual courts', () => {
  const transactions = [{
    status: 'confirmed',
    total: 930,
    courtName: 'Court 1, Court 2, Court 3',
    items: [
      { courtName: 'Court 1', total: 310, paymentStatus: 'paid' },
      { courtName: 'Court 2', total: 310, paymentStatus: 'paid' },
      { courtName: 'Court 3', total: 310, paymentStatus: 'paid' },
    ],
  }];

  assert.deepEqual(balance.courtRevenueBreakdown(transactions), [
    ['Court 1', 310],
    ['Court 2', 310],
    ['Court 3', 310],
  ]);
});

test('court revenue counts each retained deposit against its actual court', () => {
  const transactions = [{
    status: 'forfeited',
    total: 800,
    downpayment: 200,
    paymentStatus: 'deposit_retained',
    courtName: 'Court 1, Court 2',
    items: [
      { status: 'forfeited', courtName: 'Court 1', total: 400, downpayment: 100, paymentStatus: 'deposit_retained' },
      { status: 'forfeited', courtName: 'Court 2', total: 400, downpayment: 100, paymentStatus: 'deposit_retained' },
    ],
  }];

  assert.deepEqual(balance.courtRevenueBreakdown(transactions), [
    ['Court 1', 100],
    ['Court 2', 100],
  ]);
});
