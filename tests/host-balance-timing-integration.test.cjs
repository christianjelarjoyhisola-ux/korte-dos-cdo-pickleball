const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const source = read('supabase/functions/verify-gcash-receipt/index.ts');
const server = stripTypeScriptTypes(source);
const helper = stripTypeScriptTypes(read('supabase/functions/_shared/host-balance-receipt-time.ts')).replace(/\bexport\s+/g, '');
const money = stripTypeScriptTypes(read('supabase/functions/_shared/booking-payment.ts')).replace(/\bexport\s+/g, '');
const providers = ['gcash', 'bdopay', 'maya', 'bpi', 'gotyme'];

function segment(start, end, from = 0) {
  const index = server.indexOf(start, from);
  assert.ok(index >= 0, `${start} must exist in the verifier`);
  const limit = server.indexOf(end, index + start.length);
  assert.ok(limit > index, `${end} must follow ${start}`);
  return server.slice(index, limit);
}

function bracedStatement(start) {
  const body = server.indexOf('{', start);
  let depth = 0;
  for (let index = body; index < server.length; index++) {
    if (server[index] === '{') depth++;
    if (server[index] === '}' && --depth === 0) return server.slice(start, index + 1);
  }
  throw new Error('Unclosed timing guard');
}

// Execute the production selector and each provider's guarded legacy timing
// block. OCR parsing and destination checks are outside this timing regression.
const selector = segment('const hostBalanceTimeCheck =', 'let mariBankDestinationEvidence');
const timingBlocks = [...server.matchAll(/if \(!hostBalanceTimeCheck\)\s*\{/g)].map(match => bracedStatement(match.index));
assert.equal(timingBlocks.length, providers.length, 'every affected provider keeps its guarded court-payment timing checks');
const strictAmount = segment("// A host's remaining balance is a server-locked amount.", 'if (editedBySoftware(bytes))');
const hardFlags = segment('const HARD_FLAGS =', ']);') + ']);';
const decision = segment('const hasHard = flags.some', '// Race-safe claim');
const dedupe = segment('const rawRefForDedupe =', '// ── decision routing');
const auditExpression = server.match(/hostBalanceReceiptTime:\s*([^,\r\n]+)/)?.[1];
assert.ok(auditExpression, 'the stored audit must retain the selected timing-policy evidence');

function checkContext(overrides = {}) {
  const receiptDateTime = Object.hasOwn(overrides, 'receiptDateTime')
    ? overrides.receiptDateTime : new Date('2026-09-05T21:12:00Z');
  const bookingStartedAt = overrides.bookingStartedAt || new Date('2026-08-01T02:05:00Z');
  return {
    Date,
    provider: 'gcash',
    hostBalancePayment: { id: 'BALANCE-1', expected_amount: 2362.5 },
    requestReceivedAt: new Date('2026-09-05T13:15:00Z'),
    receiptDateTime,
    receiptDate: receiptDateTime?.toISOString().slice(0, 10) || null,
    bookingStartedAt,
    bookingStartedDate: bookingStartedAt.toISOString().slice(0, 10),
    receiptAgeMinutes: receiptDateTime ? (receiptDateTime - bookingStartedAt) / 60000 : null,
    extractedAmount: 2362.5,
    expectedAmount: 2362.5,
    flags: [],
    ...overrides,
  };
}

function setup(context) {
  vm.createContext(context);
  const constants = ['PAYMENT_WINDOW_MINUTES', 'PAYMENT_EARLY_TOLERANCE_MINUTES'].map(name => {
    const statement = server.match(new RegExp(`const ${name} =[^;]+;`))?.[0];
    assert.ok(statement, `${name} must remain configured`);
    return statement;
  });
  vm.runInContext([helper, money, hardFlags, ...constants, selector].join('\n'), context);
  return context;
}

function timingResult(overrides = {}) {
  const context = setup(checkContext(overrides));
  const providerIndex = providers.indexOf(context.provider);
  vm.runInContext([
    providerIndex >= 0 ? timingBlocks[providerIndex] : '',
    strictAmount,
    decision,
    `this.outcome = { flags, result, check: hostBalanceTimeCheck, audit: ${auditExpression} };`,
  ].join('\n'), context);
  return JSON.parse(JSON.stringify(context.outcome));
}

function parseProductionReceipt(text, provider, hostBalancePayment = { id: 'BALANCE-1' }) {
  const context = { Date, ocrText: text, provider, hostBalancePayment };
  vm.createContext(context);
  vm.runInContext([
    segment('const MONTHS', 'function digitsOnly('),
    segment('const { date: receiptDate, shifted: receiptDateTime } =', 'const bookingStartedAt ='),
    'this.parsed = { date: receiptDate, shifted: receiptDateTime };',
  ].join('\n'), context);
  return context.parsed;
}

test('balance OCR parser rejects impossible dates and clock fields before upload-age evaluation', () => {
  for (const provider of ['gcash', 'bdopay', 'maya', 'bpi']) {
    for (const text of [
      'Feb 31, 2026 9:12 PM',
      'Sep 0, 2026 9:12 PM',
      'Sep 5, 2026 13:12 PM',
      'Sep 5, 2026 00:12 AM',
      'Sep 5, 2026 9:60 PM',
      'Sep 5, 2026 9:12:99 PM',
    ]) {
      const parsed = parseProductionReceipt(text, provider);
      assert.equal(parsed.shifted, null, `${provider}: ${text}`);
      const result = timingResult({ provider, receiptDateTime: parsed.shifted });
      assert.equal(result.result, 'manual_review');
      assert.deepEqual(result.flags, ['HOST_BALANCE_RECEIPT_TIME_UNREADABLE']);
    }
    const valid = parseProductionReceipt('Sep 5, 2026 9:12 PM', provider);
    assert.equal(valid.shifted.toISOString(), '2026-09-05T21:12:00.000Z');
    const result = timingResult({ provider, receiptDateTime: valid.shifted });
    assert.equal(result.audit.receiptPaidAt, '2026-09-05T13:12:00.000Z');
    assert.deepEqual(result.flags, []);

    const oldFlow = parseProductionReceipt('Sep 5, 2026 9:60 PM', provider, null);
    assert.equal(oldFlow.shifted.toISOString(), '2026-09-05T22:00:00.000Z', 'strict parsing is scoped to server-resolved balance payments');
  }
});

test('upload receipt clock is captured by the server before request parsing or asynchronous work', () => {
  const handlerStart = server.indexOf('Deno.serve(async (req) => {');
  assert.ok(handlerStart >= 0);
  const prefix = segment('Deno.serve(async (req) => {', 'if (req.method', handlerStart)
    .replace('Deno.serve(async (req) => {', '');
  assert.match(prefix, /const requestReceivedAt = new Date\(\);/);
  assert.doesNotMatch(prefix, /\bawait\b|req\.|body\./);
  assert.equal((server.match(/\brequestReceivedAt\s*=/g) || []).length, 1, 'later parsing or OCR must not replace the ingress clock');

  const capturedAt = '2026-09-05T13:15:00.000Z';
  class ServerClock extends Date { constructor() { super(capturedAt); } }
  const hostileRequest = new Proxy({}, { get() { throw new Error('untrusted client timestamp was read'); } });
  const capture = new Function('Date', 'req', `${prefix}\nreturn requestReceivedAt;`);
  assert.equal(capture(ServerClock, hostileRequest).toISOString(), capturedAt);
});

test('existing host balances use upload receipt age across all five providers and retain useful audit evidence', () => {
  for (const provider of providers) {
    const result = timingResult({ provider });
    assert.deepEqual(result.flags, [], provider);
    assert.equal(result.result, 'auto_approved', `${provider}: clean timing and exact amount pass these checks`);
    assert.equal(result.audit.receiptAgeMinutes, 3);
    assert.equal(result.audit.requestReceivedAt, '2026-09-05T13:15:00.000Z');
    assert.equal(result.audit.receiptPaidAt, '2026-09-05T13:12:00.000Z');
    assert.equal(result.audit.policy, 'host_balance_upload_24h_v1');
  }
});

test('inline host claims cannot opt new bookings or session joins into balance timing', () => {
  for (const provider of providers) {
    const result = timingResult({
      provider,
      hostBalancePayment: null,
      body: { requestReceivedAt: '2026-09-05T13:15:00Z', bookingData: { host_booking: true, verification_context: 'host_booking_balance' } },
      inlinePricingKind: 'host_session',
    });
    assert.equal(result.check, null, provider);
    assert.equal(result.audit, null);
    assert.ok(result.flags.includes('DATE_NOT_TODAY'));
    assert.ok(result.flags.includes('TIME_EXPIRED'));
    assert.equal(result.result, 'rejected');
  }
  for (const provider of ['maribank', 'pnb']) {
    const context = setup(checkContext({ provider }));
    vm.runInContext('this.selected = hostBalanceTimeCheck;', context);
    assert.equal(context.selected, null, `${provider} keeps its separate provider policy`);
  }
});

test('ordinary court timing retains its 15-minute payment window and two-minute early tolerance', () => {
  for (const provider of providers) {
    const bookingStartedAt = new Date('2026-09-05T21:00:00Z');
    for (const [minutes, expected] of [[-2, null], [15, null], [-3, 'TIME_FUTURE'], [16, 'TIME_EXPIRED']]) {
      const result = timingResult({
        provider,
        hostBalancePayment: null,
        bookingStartedAt,
        receiptDateTime: new Date(bookingStartedAt.getTime() + minutes * 60000),
      });
      assert.equal(result.check, null);
      assert.deepEqual(result.flags, expected ? [expected] : [], `${provider} at ${minutes} minutes`);
      assert.equal(result.result, expected ? 'rejected' : 'auto_approved');
    }
  }
});

test('old, future, unreadable, and invalid-clock balance evidence routes to owner review without legacy hard timing flags', () => {
  const cases = [
    [{ receiptDateTime: new Date('2026-09-04T21:14:00Z') }, 'HOST_BALANCE_RECEIPT_TOO_OLD'],
    [{ receiptDateTime: new Date('2026-09-05T21:18:00Z') }, 'HOST_BALANCE_RECEIPT_IN_FUTURE'],
    [{ receiptDateTime: null }, 'HOST_BALANCE_RECEIPT_TIME_UNREADABLE'],
    [{ requestReceivedAt: new Date('invalid') }, 'HOST_BALANCE_REQUEST_TIME_INVALID'],
  ];
  for (const provider of providers) {
    for (const [overrides, flag] of cases) {
      const result = timingResult({ provider, ...overrides });
      assert.deepEqual(result.flags, [flag], `${provider}: ${flag}`);
      assert.equal(result.result, 'manual_review');
      assert.equal(result.check.needsOwnerReview, true);
    }
  }
});

test('fresh balance timing does not relax the server-locked exact amount in either direction', () => {
  for (const provider of providers) {
    for (const extractedAmount of [2360, 2365]) {
      const payment = { id: 'BALANCE-1', expected_amount: 2362.5, original_paid_amount: 877.5 };
      const snapshot = JSON.stringify(payment);
      const result = timingResult({ provider, extractedAmount, hostBalancePayment: payment });
      assert.ok(result.flags.includes('AMOUNT_MISMATCH'), `${provider}: ${extractedAmount}`);
      assert.equal(result.result, 'rejected');
      assert.equal(JSON.stringify(payment), snapshot, 'verification checks do not adjust ledger amounts');
    }
  }
});

test('fresh balance receipts still consult the payment ledger and block reused references', async () => {
  for (const provider of providers) {
    const lookedUp = [];
    let selectedKey;
    const query = {
      select() { return this; },
      eq(_column, value) { selectedKey = value; return this; },
      async maybeSingle() { lookedUp.push(selectedKey); return { data: { booking_ref: 'ANOTHER-BOOKING' } }; },
    };
    const context = setup(checkContext({
      provider,
      db: { from(table) { assert.equal(table, 'used_gcash_refs'); return query; } },
      bookingGroupRefs: new Set(['BALANCE-1']),
      extractedRef: '1234567890123', typedRef: '1234567890123',
      extractedInvoice: 'INVOICE-1', extractedInstapayRefNo: 'INSTAPAY-1',
      extractedBpiTransactionRefNo: 'BPI-1', extractedGoTymeTraceId: '123456',
    }));
    await vm.runInContext(`(async () => { ${dedupe}\n${decision}\nthis.outcome = { flags, result }; })()`, context);
    assert.ok(lookedUp.includes(provider === 'gcash' ? '1234567890123' : `${provider}:1234567890123`));
    assert.ok(context.outcome.flags.includes('DUPLICATE_REF'));
    assert.equal(context.outcome.result, 'rejected');
    const secondary = { bdopay: 'DUPLICATE_INVOICE', maya: 'DUPLICATE_INSTAPAY_REF', bpi: 'DUPLICATE_BPI_TRANSACTION_REF', gotyme: 'DUPLICATE_GOTYME_TRACE' }[provider];
    if (secondary) assert.ok(context.outcome.flags.includes(secondary), provider);
  }
});
