const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const balancePayment = require('./host-balance-payment.js');

const eligibleBooking = {
  ref: 'BK-001',
  hostBooking: true,
  status: 'confirmed',
  paymentStatus: 'downpayment_paid',
  total: 1000,
  downpayment: 300,
  balanceDueAt: '2026-08-10T10:00:00+08:00',
};

test('offers balance payment only for a confirmed paid-down host booking before its deadline', () => {
  const result = balancePayment.eligibility(eligibleBooking, new Date('2026-08-09T09:59:00+08:00'));
  assert.equal(result.eligible, true);
  assert.equal(result.balance, 700);
  assert.equal(result.bookingKey, 'BK-001');
  assert.equal(result.bookingRef, 'BK-001');
});

test('does not offer balance payment while the initial payment is verifying', () => {
  const result = balancePayment.eligibility({
    ...eligibleBooking,
    status: 'pending',
    paymentStatus: 'for_verification',
  }, new Date('2026-08-09T09:59:00+08:00'));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_confirmed');
});

test('does not offer balance payment at or after the deadline or after forfeiture', () => {
  const overdue = balancePayment.eligibility(eligibleBooking, new Date('2026-08-10T10:00:00+08:00'));
  assert.equal(overdue.eligible, false);
  assert.equal(overdue.reason, 'deadline_passed');

  const forfeited = balancePayment.eligibility({
    ...eligibleBooking,
    status: 'forfeited',
    paymentStatus: 'deposit_retained',
  }, new Date('2026-08-09T09:59:00+08:00'));
  assert.equal(forfeited.eligible, false);
});

test('fallback deadline is 11:59 PM Philippine time on the fifth calendar day', () => {
  const booking = {
    ref: 'BK-EOD',
    date: '2026-08-25',
    startTime: '3:00 PM',
    hostBooking: true,
    status: 'confirmed',
    paymentStatus: 'downpayment_paid',
    total: 1000,
    downpayment: 250,
  };
  assert.equal(balancePayment.balanceDeadline(booking).toISOString(), '2026-08-20T15:59:59.999Z');
  assert.equal(balancePayment.eligibility(booking, new Date('2026-08-20T15:01:00Z')).eligible, true);
});

test('resolves grouped booking keys while retaining a real child ref for server lookup', () => {
  const grouped = {
    ...eligibleBooking,
    ref: 'GROUP-001',
    displayRef: 'GROUP-001',
    groupRef: 'GROUP-001',
    total: 2000,
    downpayment: 600,
    items: [
      { ...eligibleBooking, ref: 'BK-001-A', groupRef: 'GROUP-001' },
      { ...eligibleBooking, ref: 'BK-001-B', groupRef: 'GROUP-001' },
    ],
  };
  assert.equal(balancePayment.bookingKey(grouped), 'GROUP-001');
  assert.equal(balancePayment.primaryBookingRef(grouped), 'BK-001-A');
  assert.equal(balancePayment.bookingMatchesKey(grouped, 'BK-001-B'), true);
  assert.deepEqual(balancePayment.buildQuotePayload(grouped), {
    action: 'quote',
    bookingRef: 'GROUP-001',
  });
  assert.deepEqual(balancePayment.buildCreatePayload({
    bookingKey: 'GROUP-001',
  }, 'idem-001', {
    paymentMethod: 'gcash',
    paymentReference: '1234567890123',
  }), {
    action: 'create',
    bookingKey: 'GROUP-001',
    bookingRef: 'GROUP-001',
    idempotencyKey: 'idem-001',
    paymentProvider: 'gcash',
    provider: 'gcash',
    paymentReference: '1234567890123',
  });

  const groupEligibility = balancePayment.eligibility(grouped, new Date('2026-08-09T09:59:00+08:00'));
  assert.equal(groupEligibility.eligible, true);
  assert.equal(groupEligibility.balance, 1400);

  const mixedPaymentGroup = {
    ...grouped,
    items: [
      grouped.items[0],
      { ...grouped.items[1], paymentStatus: 'paid' },
    ],
  };
  assert.equal(
    balancePayment.eligibility(mixedPaymentGroup, new Date('2026-08-09T09:59:00+08:00')).eligible,
    false,
  );
});

test('builds exact-balance verification data without copying original deposit evidence', () => {
  const quote = balancePayment.normalizeQuote({
    paymentId: 'pay-123',
    verificationRef: 'HBP-VERIFY-123',
    balance: 700,
    bookingKey: 'BK-001',
    bookingRef: 'BK-001',
    verificationBookingData: {
      verification_context: 'host_booking_balance',
      balance_payment_id: 'pay-123',
      booking_ref: 'BK-001',
      booking_group_ref: null,
      full_name: 'Host Name',
      total: 700,
      downpayment: 700,
      created_at: '2026-08-01T10:00:00Z',
      payment_method: 'gcash',
      gcash_ref: '1234567890123',
    },
  }, eligibleBooking);
  const payload = balancePayment.buildVerificationBookingData(quote, {
    booking: { ...eligibleBooking, gcashRef: 'OLD-DEPOSIT-REF', receiptImageUrl: 'old.jpg' },
    paymentMethod: 'gcash',
    paymentReference: '1234567890123',
  });

  assert.equal(payload.total, 700);
  assert.equal(payload.downpayment, 700);
  assert.equal(payload.gcash_ref, '1234567890123');
  assert.equal(payload.verification_context, 'host_booking_balance');
  assert.equal(payload.balance_payment_id, 'pay-123');
  assert.equal(payload.booking_ref, 'BK-001');
  assert.equal(Object.hasOwn(payload, 'ref'), false);
  assert.equal(Object.hasOwn(payload, 'receiptImageUrl'), false);
  assert.equal(JSON.stringify(payload).includes('OLD-DEPOSIT-REF'), false);
  assert.equal(balancePayment.buildVerificationBookingData({
    ...quote,
    verificationBookingData: null,
  }, {
    paymentMethod: 'gcash',
    paymentReference: '1234567890123',
  }), null);
});

test('builds submit payload and normalizes approved, pending, and rejected states', () => {
  const quote = {
    paymentId: 'pay-123',
    bookingKey: 'GROUP-001',
    bookingRef: 'BK-001-A',
    groupRef: 'GROUP-001',
    verificationRef: 'HBP-VERIFY-123',
  };
  assert.deepEqual(balancePayment.buildSubmitPayload(quote, {
    receiptVerificationId: 42,
    receiptStatus: 'manual_review',
  }), {
    action: 'submit',
    paymentId: 'pay-123',
    receiptVerificationId: 42,
  });
  assert.equal(balancePayment.statusState({ paymentStatus: 'paid' }), 'approved');
  assert.equal(balancePayment.statusState({ status: 'manual_review' }), 'pending');
  assert.equal(balancePayment.statusState({ receipt_status: 'rejected' }), 'rejected');
  assert.deepEqual(balancePayment.buildSubmitPayload(quote, {
    receipt_verification_id: '43',
  }), {
    action: 'submit',
    paymentId: 'pay-123',
    receiptVerificationId: 43,
  });
});

test('normalizes camel/snake quote fields together with a current grouped attempt', () => {
  const normalized = balancePayment.normalizeQuote({
    quote: {
      booking_key: 'GROUP-001',
      booking_group_ref: 'GROUP-001',
      balance_amount: 1400,
      balance_due_at: '2026-08-10T02:00:00Z',
      booking_date: '2026-08-15',
      court_label: 'Court Alpha, Court Beta',
      schedule_label: '8:00 AM - 10:00 AM',
      customer_name: 'Host Name',
    },
    current_attempt: {
      id: 'attempt-1',
      verification_ref: 'HBAL-0123456789ABCDEF0123456789ABCDEF',
      expected_amount: 1400,
      payment_provider: 'gcash',
      payment_reference: '1234567890123',
      status: 'submitted',
    },
  }, eligibleBooking);

  assert.equal(normalized.paymentId, 'attempt-1');
  assert.equal(normalized.bookingKey, 'GROUP-001');
  assert.equal(normalized.groupRef, 'GROUP-001');
  assert.equal(normalized.balance, 1400);
  assert.equal(normalized.date, '2026-08-15');
  assert.equal(normalized.courtName, 'Court Alpha, Court Beta');
  assert.equal(normalized.timeLabel, '8:00 AM - 10:00 AM');
  assert.equal(normalized.fullName, 'Host Name');
  assert.equal(normalized.paymentProvider, 'gcash');
  assert.equal(normalized.paymentReference, '1234567890123');
  assert.equal(balancePayment.statusState({ current_attempt: { status: 'submitted' } }), 'pending');
});

test('invokes the existing compatibility function with a strict balance API marker', async () => {
  const calls = [];
  const response = await balancePayment.invoke({
    functions: {
      async invoke(name, options) {
        calls.push({ name, options });
        return { data: { ok: true, quote: { balanceAmount: 700 } }, error: null };
      },
    },
  }, {
    action: 'quote',
    bookingRef: 'BK-001',
  });

  assert.deepEqual(calls, [{
    name: 'integration-status',
    options: {
      body: {
        action: 'quote',
        bookingRef: 'BK-001',
        api: 'host_booking_balance_payment',
      },
    },
  }]);
  assert.equal(response.quote.balanceAmount, 700);
});

test('surfaces the Edge Function response instead of a generic non-2xx error', async () => {
  await assert.rejects(
    balancePayment.invoke({
      functions: {
        async invoke() {
          return {
            data: null,
            error: {
              message: 'Edge Function returned a non-2xx status code',
              context: {
                async json() {
                  return { error: 'The receipt was submitted after the balance deadline.' };
                },
              },
            },
          };
        },
      },
    }, { action: 'submit' }),
    /submitted after the balance deadline/,
  );
});

test('serves critical balance scripts through the current cache-busted release', () => {
  const indexHtml = fs.readFileSync('./index.html', 'utf8');
  const adminHtml = fs.readFileSync('./admin.html', 'utf8');
  const headers = fs.readFileSync('./_headers', 'utf8');
  const worker = fs.readFileSync('./_worker.js', 'utf8');

  assert.match(indexHtml, /host-balance-payment\.js\?v=20260820-host-balance-eod-v3/);
  assert.match(adminHtml, /host-balance-payment\.js\?v=20260820-host-balance-eod-v3/);
  assert.match(indexHtml, /booking-balance\.js\?v=20260820-host-balance-eod-v3/);
  assert.match(adminHtml, /booking-balance\.js\?v=20260820-host-balance-eod-v3/);
  assert.match(adminHtml, /host-balance-admin\.js\?v=20260831-balance-review-v5/);
  assert.match(headers, /\/host-balance-payment\.js\s+Cache-Control: no-cache, max-age=0, must-revalidate/);
  assert.match(headers, /\/host-balance-admin\.js\s+Cache-Control: no-cache, max-age=0, must-revalidate/);
  assert.match(worker, /"\/host-balance-payment\.js"/);
  assert.match(worker, /"\/host-balance-admin\.js"/);
  assert.match(worker, /headers\.set\("Cache-Control", "no-cache, max-age=0, must-revalidate"\)/);
});
