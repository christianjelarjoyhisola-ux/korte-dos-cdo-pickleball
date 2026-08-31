const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const adminSource = fs.readFileSync('admin.html', 'utf8');
const configSource = fs.readFileSync('supabase-config.js', 'utf8');

function extractBracedBlock(source, start, label, knownBodyStart = -1) {
  const bodyStart = knownBodyStart >= 0 ? knownBodyStart : source.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `${label} body must exist`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${label}`);
}

function extractFunction(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `${name} must exist`);
  const parametersStart = source.indexOf('(', match.index);
  let depth = 0;
  let parametersEnd = -1;
  let quote = '';
  let escaped = false;
  for (let index = parametersStart; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0) {
      parametersEnd = index;
      break;
    }
  }
  assert.notEqual(parametersEnd, -1, `${name} parameters must close`);
  const bodyStart = source.indexOf('{', parametersEnd);
  return extractBracedBlock(source, match.index, name, bodyStart);
}

function extractObjectMethod(source, name) {
  const marker = `async ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  return extractBracedBlock(source, start, name);
}

function paymentHelperNames() {
  return [...adminSource.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g)]
    .map(match => match[1])
    .filter(name => /host/i.test(name) && /(payment|balance|deposit|receipt)/i.test(name))
    .filter((name, index, names) => names.indexOf(name) === index);
}

function php(value) {
  return `₱${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function loadPaymentHistoryHelpers(DB) {
  const names = paymentHelperNames();
  for (const required of ['getHostBookingPaymentHistory', 'renderHostPaymentHistory']) {
    assert.ok(names.includes(required), `${required} must remain a named helper`);
  }
  const context = {
    DB,
    console: { ...console, warn() {} },
    fmt: php,
    esc: value => String(value ?? ''),
    jsArg: value => String(value ?? ''),
    paymentMethodLabel: value => ({ gcash: 'GCash', maya: 'Maya' }[String(value || '').toLowerCase()] || String(value || '—')),
    receiptOcrProviderLabel: value => String(value || '—'),
    isDigitalPayment: value => ['gcash', 'maya', 'bpi', 'bdopay', 'maribank', 'gotyme', 'pnb'].includes(String(value || '').toLowerCase()),
    Auth: { can: () => true },
    sess: { role: 'owner' },
    window: {
      BookingBalance: {
        paidAmount(booking) {
          return String(booking?.paymentStatus || '').toLowerCase() === 'paid'
            ? Number(booking?.total || 0)
            : Number(booking?.downpayment || 0);
        },
        formatDeadline(value) {
          const date = new Date(value);
          return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext([
    ...names.map(name => extractFunction(adminSource, name)),
    `this.helpers = { ${names.join(', ')} };`,
  ].join('\n'), context);
  return context.helpers;
}

function exampleBooking(overrides = {}) {
  return {
    ref: 'PB-M57KG5PI-A',
    primaryRef: 'PB-M57KG5PI-A',
    groupRef: 'PB-M57KG5PI-G',
    displayRef: 'PB-M57KG5PI-HKAF',
    refs: ['PB-M57KG5PI-A', 'PB-M57KG5PI-B'],
    hostBooking: true,
    status: 'completed',
    paymentStatus: 'paid',
    total: 1860,
    // The settlement workflow mutates this field to the total. It is not the
    // authoritative original deposit after a balance has been approved.
    downpayment: 1860,
    paymentMethod: 'gcash',
    gcashRef: '4043440683639',
    receiptStatus: 'auto_approved',
    receiptImageUrl: 'deposit-proof.jpg',
    receiptVerifiedAt: '2026-07-30T13:45:00Z',
    paidAt: '2026-08-10T08:00:00Z',
    ...overrides,
  };
}

function exampleHistory() {
  return {
    available: true,
    manualDecision: null,
    attempts: [
      {
        id: 'balance-approved',
        paymentId: 'balance-approved',
        bookingKey: 'PB-M57KG5PI-G',
        bookingRefs: ['PB-M57KG5PI-A', 'PB-M57KG5PI-B'],
        status: 'approved',
        totalAmount: 1860,
        originalPaidAmount: 510,
        expectedAmount: 1350,
        balanceAmount: 1350,
        paidAmount: 1860,
        remainingAmount: 0,
        paymentProvider: 'maya',
        paymentReference: 'E563D5B2F189',
        receiptStatus: 'auto_approved',
        receiptVerificationId: 77,
        receiptImageHash: 'a'.repeat(64),
        submittedAt: '2026-08-10T07:59:00Z',
        approvedAt: '2026-08-10T08:00:00Z',
      },
      {
        id: 'balance-pending',
        paymentId: 'balance-pending',
        bookingKey: 'PB-M57KG5PI-G',
        status: 'pending_review',
        totalAmount: 1860,
        originalPaidAmount: 510,
        expectedAmount: 1350,
        paymentProvider: 'gcash',
        paymentReference: 'PENDING-REF-2',
        receiptStatus: 'manual_review',
        submittedAt: '2026-08-09T08:00:00Z',
      },
      {
        id: 'balance-rejected',
        paymentId: 'balance-rejected',
        bookingKey: 'PB-M57KG5PI-G',
        status: 'rejected',
        totalAmount: 1860,
        originalPaidAmount: 510,
        expectedAmount: 1350,
        paymentProvider: 'gcash',
        paymentReference: 'REJECTED-REF-1',
        receiptStatus: 'rejected',
        rejectedAt: '2026-08-08T08:00:00Z',
      },
    ],
  };
}

test('history lookup uses the canonical grouped booking key and fails soft in the UI', async () => {
  const calls = [];
  const helpers = loadPaymentHistoryHelpers({
    async getHostBookingBalancePaymentHistory(key) {
      calls.push(key);
      throw new Error('temporary history outage');
    },
  });

  const state = await helpers.getHostBookingPaymentHistory(exampleBooking());
  assert.deepEqual(calls, ['PB-M57KG5PI-G']);
  assert.equal(state.available, false);
  assert.equal(state.error, 'unavailable');
  assert.equal(Array.from(state.attempts).length, 0);
});

test('non-host booking details do not request host balance history', async () => {
  let historyReads = 0;
  const helpers = loadPaymentHistoryHelpers({
    async getHostBookingBalancePaymentHistory() {
      historyReads += 1;
      throw new Error('must not be called');
    },
  });

  const state = await helpers.getHostBookingPaymentHistory(exampleBooking({ hostBooking: false }));
  assert.equal(historyReads, 0);
  assert.equal(state.available, false);
  assert.equal(Array.from(state.attempts).length, 0);

  const openDetails = extractFunction(adminSource, 'openBookingDetails');
  assert.match(openDetails, /b\.hostBooking[\s\S]*?getHostBookingPaymentHistory\(b\)/);
  assert.match(openDetails, /<h3>Payment record<\/h3>/);
});

test('approved history reconstructs the original deposit instead of using mutated downpayment', () => {
  const helpers = loadPaymentHistoryHelpers({});
  const html = helpers.renderHostPaymentHistory(exampleBooking(), exampleHistory());

  const deposit = html.match(/data-payment-kind="deposit"[\s\S]*?(?=data-payment-kind="balance")/)?.[0] || '';
  assert.match(deposit, /₱510\.00/);
  assert.doesNotMatch(deposit, /₱1,860\.00/);
  assert.match(deposit, /4043440683639/);

  const balance = html.match(/data-payment-kind="balance"[\s\S]*?(?=<details|$)/)?.[0] || '';
  assert.match(balance, /₱1,350\.00/);
  assert.match(balance, /E563D5B2F189/);
  assert.match(balance, /data-payment-status="approved"/);
});

test('only the approved balance contributes to verified total while other attempts stay auditable', () => {
  const helpers = loadPaymentHistoryHelpers({});
  const html = helpers.renderHostPaymentHistory(exampleBooking(), exampleHistory());

  assert.match(html, /₱1,860\.00 verified of ₱1,860\.00/);
  assert.match(html, /Remaining balance confirmed\. This booking is fully paid\./);
  assert.equal((html.match(/data-payment-kind="balance"/g) || []).length, 1);

  const otherAttemptsAt = html.indexOf('booking-payment-other-attempts');
  assert.ok(otherAttemptsAt > -1, 'non-approved attempts must have a disclosure');
  assert.ok(html.indexOf('PENDING-REF-2') > otherAttemptsAt);
  assert.ok(html.indexOf('REJECTED-REF-1') > otherAttemptsAt);
  assert.ok(html.indexOf('E563D5B2F189') < otherAttemptsAt);
});

test('a submitted balance awaiting review is the primary balance event with its proof visible', () => {
  const helpers = loadPaymentHistoryHelpers({});
  const history = exampleHistory();
  history.attempts = history.attempts.filter(attempt => attempt.status !== 'approved');
  history.attempts[0] = {
    ...history.attempts[0],
    receiptVerificationId: 78,
    receiptImageHash: 'b'.repeat(64),
  };
  const html = helpers.renderHostPaymentHistory(exampleBooking({
    paymentStatus: 'downpayment_paid',
    downpayment: 510,
  }), history);

  const balance = html.match(/data-payment-kind="balance"[\s\S]*?(?=<details|$)/)?.[0] || '';
  assert.match(balance, /data-payment-status="pending_review"/);
  assert.match(balance, /Awaiting review/);
  assert.match(balance, /View submitted proof/);
  assert.match(balance, /openHostBalanceReceipt\('balance-pending'/);
  assert.match(balance, /PENDING-REF-2/);
  assert.match(html, /₱510\.00 verified of ₱1,860\.00/);
  assert.doesNotMatch(html, /Other attempts \(2\)/);
  assert.match(html, /Other attempts \(1\)/);
});

test('deposit and approved balance expose distinct proof actions', () => {
  const helpers = loadPaymentHistoryHelpers({});
  const html = helpers.renderHostPaymentHistory(exampleBooking(), exampleHistory());

  assert.equal((html.match(/booking-payment-proof-btn/g) || []).length, 2);
  assert.match(html, /openHostDepositReceipt\('PB-M57KG5PI-A'/);
  assert.match(html, /openHostBalanceReceipt\('balance-approved'/);
  assert.match(html, /GCash deposit receipt/);
  assert.match(html, /Maya remaining balance receipt/);
});

test('manual and unavailable settlements are recorded without being called verified', () => {
  const helpers = loadPaymentHistoryHelpers({});
  const booking = exampleBooking({
    receiptExtracted: { amount: 510 },
    receiptVerifiedAt: '2026-07-30T13:45:00Z',
  });
  const history = { available: true, attempts: [], manualDecision: null };
  const html = helpers.renderHostPaymentHistory(booking, history);

  assert.match(html, /₱1,860\.00 recorded paid · evidence incomplete/);
  assert.match(html, /Manually recorded — transaction details unavailable/);
  assert.match(html, /₱510\.00/);
  assert.match(html, /₱1,350\.00/);
  assert.doesNotMatch(html, /₱1,860\.00 verified/);

  const unavailable = helpers.renderHostPaymentHistory(booking, {
    available: false,
    attempts: [],
    manualDecision: null,
  });
  assert.match(unavailable, /recorded paid · evidence incomplete/);
  assert.match(unavailable, /Balance transaction history is unavailable/);
  assert.doesNotMatch(unavailable, /₱1,860\.00 verified/);
});

test('ledger mismatch requires reconciliation and never claims the booking is fully paid', () => {
  const helpers = loadPaymentHistoryHelpers({});
  const history = exampleHistory();
  history.attempts[0] = {
    ...history.attempts[0],
    totalAmount: 1800,
    originalPaidAmount: 510,
    expectedAmount: 1290,
  };
  const html = helpers.renderHostPaymentHistory(exampleBooking(), history);

  assert.match(html, /review required/i);
  assert.match(html, /Review totals/);
  assert.match(html, /Reconciliation required/);
  assert.match(html, /₱1,800\.00/);
  assert.doesNotMatch(html, /Remaining balance confirmed\. This booking is fully paid/);
});

test('unpaid or rejected expected downpayments are never shown as collected', () => {
  const helpers = loadPaymentHistoryHelpers({});
  for (const paymentStatus of ['unpaid', 'rejected']) {
    const html = helpers.renderHostPaymentHistory(exampleBooking({
      paymentStatus,
      status: paymentStatus === 'rejected' ? 'cancelled' : 'pending',
      downpayment: 510,
      receiptStatus: paymentStatus === 'rejected' ? 'rejected' : 'none',
      receiptExtracted: null,
      receiptImageUrl: null,
    }), { available: true, attempts: [], manualDecision: null });
    const deposit = html.match(/data-payment-kind="deposit"[\s\S]*?(?=data-payment-kind="balance")/)?.[0] || '';
    assert.doesNotMatch(deposit, /₱510\.00/);
    assert.match(deposit, /Not separately recorded/);
    assert.match(deposit, /No verified initial payment is counted yet/);
  }
});

test('balance settlement time never replaces the original deposit timestamp', () => {
  const helpers = loadPaymentHistoryHelpers({});
  const booking = exampleBooking({
    receiptVerifiedAt: null,
    createdAt: '2026-07-30T13:45:00Z',
    paidAt: '2026-08-10T08:00:00Z',
  });
  const html = helpers.renderHostPaymentHistory(booking, exampleHistory());
  const deposit = html.match(/data-payment-kind="deposit"[\s\S]*?(?=data-payment-kind="balance")/)?.[0] || '';
  assert.match(deposit, /2026-07-30T13:45:00\.000Z/);
  assert.doesNotMatch(deposit, /2026-08-10T08:00:00\.000Z/);
});

test('proof dialog closes through its cleanup path and preserves an original-file fallback', () => {
  assert.match(adminSource, /ov\.id==='hostBookingPaymentProofModal'\) closeHostBookingPaymentProof\(\)/);
  assert.match(adminSource, /id="hostBookingPaymentProofOriginalLink"/);
  assert.match(adminSource, /originalLink\.href = url[\s\S]*originalLink\.style\.display = 'inline-flex'/);
  assert.match(adminSource, /Use Open original proof/);
  const keydown = extractFunction(adminSource, 'hostBookingPaymentProofKeydown');
  assert.match(keydown, /!focusable\.includes\(document\.activeElement\)/);
  assert.match(keydown, /event\.shiftKey \? last : first/);
});

test('history and proof reads are explicit, ordered, and mutation-free', () => {
  const historyMethod = extractObjectMethod(configSource, 'getHostBookingBalancePaymentHistory');
  const proofMethod = extractObjectMethod(configSource, 'getHostBookingBalanceReceiptSignedUrl');
  const uiRead = extractFunction(adminSource, 'getHostBookingPaymentHistory');
  const renderer = extractFunction(adminSource, 'renderHostPaymentHistory');

  assert.match(historyMethod, /\.from\('host_booking_balance_payments'\)/);
  assert.match(historyMethod, /\.eq\('booking_key',\s*key\)/);
  assert.match(historyMethod, /\.order\('created_at',\s*\{\s*ascending:\s*true\s*\}\)/);
  assert.match(historyMethod, /\.order\('id',\s*\{\s*ascending:\s*true\s*\}\)/);
  assert.match(configSource, /HOST_BOOKING_BALANCE_PAYMENT_HISTORY_COLUMNS[\s\S]*?'original_paid_amount'/);
  assert.match(configSource, /const originalPaidAmount = hostBookingBalanceMoney/);
  assert.match(proofMethod, /action:\s*'receipt_url'/);

  const readOnlySurface = [historyMethod, proofMethod, uiRead, renderer].join('\n');
  for (const forbidden of [
    /\.insert\s*\(/,
    /\.update\s*\(/,
    /\.delete\s*\(/,
    /DB\.updateBooking\s*\(/,
    /DB\.markHostBookingGroupFullyPaid\s*\(/,
    /DB\.reviewPaymentReceipt\s*\(/,
  ]) {
    assert.doesNotMatch(readOnlySurface, forbidden);
  }
});
