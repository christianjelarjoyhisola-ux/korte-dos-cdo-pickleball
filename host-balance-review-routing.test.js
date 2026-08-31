const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const migration = fs.readFileSync(
  './supabase/migrations/20260815123000_host_balance_reviewable_receipts.sql',
  'utf8',
);
const verifier = fs.readFileSync(
  './supabase/functions/verify-gcash-receipt/index.ts',
  'utf8',
);
const balanceHandler = fs.readFileSync(
  './supabase/functions/host-booking-balance-payment/index.ts',
  'utf8',
);
const notificationMigration = fs.readFileSync(
  './supabase/migrations/20260831113000_host_balance_payment_review_notifications.sql',
  'utf8',
);
const paymentReviewEmail = fs.readFileSync(
  './supabase/functions/_shared/payment-review-email.ts',
  'utf8',
);
const admin = fs.readFileSync('./admin.html', 'utf8');
const balanceAdmin = fs.readFileSync('./host-balance-admin.js', 'utf8');

test('routes reviewable host balance verification failures to owner review', () => {
  assert.match(migration, /verificationContext'\s*,\s*''\)\s*=\s*\n?\s*'host_booking_balance'/);
  assert.match(migration, /new\.result\s*=\s*'rejected'/);
  assert.match(migration, /new\.result\s*:=\s*'manual_review'/);
  assert.match(migration, /'automaticResult',\s*'rejected'/);
  assert.match(migration, /'reviewRouting',\s*'pending_owner_review'/);
});

test('keeps duplicate payment evidence and unreadable images blocked', () => {
  for (const flag of [
    'DUPLICATE_REF',
    'DUPLICATE_INVOICE',
    'DUPLICATE_INSTAPAY_REF',
    'DUPLICATE_BPI_TRANSACTION_REF',
    'DUPLICATE_MARIBANK_TRANSACTION',
    'IMAGE_UNREADABLE',
  ]) {
    assert.match(migration, new RegExp(`'${flag}'`));
  }
  assert.match(migration, /not coalesce\(new\.flags, array\[\]::text\[\]\) && v_blocking_flags/);
});

test('requires an exact OCR amount before a host balance can auto-approve', () => {
  assert.match(
    verifier,
    /hostBalancePayment && extractedAmount != null &&\s*!closeMoney\(extractedAmount, expectedAmount\)/,
  );
  assert.match(verifier, /flags\.push\("AMOUNT_MISMATCH"\)/);
});

test('pending host balances create owner-review notifications with supported schema context', () => {
  assert.match(notificationMigration, /'host_booking_balance'/);
  assert.match(notificationMigration, /where payment\.status = 'pending_review'/);
  assert.match(notificationMigration, /on conflict \(dedupe_key\) do nothing/);
  assert.match(paymentReviewEmail, /\| "host_booking_balance"/);
  assert.match(balanceHandler, /deliverPaymentReviewNotification\(\{/);
  assert.match(balanceHandler, /contextType: "host_booking_balance"/);
  assert.match(balanceHandler, /payment\.status === "pending_review"/);
  assert.match(balanceHandler, /dispatchTelegramBalanceReview/);
  assert.match(balanceHandler, /event: "balance_payment_review_needed"/);
  assert.match(balanceHandler, /type: "host_booking_balance"/);
});

test('balance review alert deep links open the dedicated receipt reviewer', () => {
  assert.match(admin, /\^HBAL-\[A-F0-9\]\{32\}\$/);
  assert.match(admin, /HostBalanceAdmin\?\.openByReference/);
  assert.match(balanceAdmin, /async function openByReference\(reference\)/);
  assert.match(balanceAdmin, /await openModal\(payment\)/);
});

test('booking rows expose pending balance reviews without treating them as paid', () => {
  assert.match(admin, /Balance Payment Pending Review/);
  assert.match(admin, /Review Balance Receipt/);
  assert.match(admin, /Balance receipt submitted · Awaiting owner review/);
  assert.match(admin, /const canRecordManualPayment = hasBalance && !pendingBalance/);
  assert.match(balanceAdmin, /typeof global\.renderBookings === 'function'/);
});

test('loaded balance receipt proof is made visible before approval', () => {
  assert.match(balanceAdmin, /image\.addEventListener\('load',[\s\S]*?image\.style\.display = 'block';[\s\S]*?state\.receiptLoaded = true|image\.addEventListener\('load',[\s\S]*?state\.receiptLoaded = true;[\s\S]*?image\.style\.display = 'block';/);
  assert.match(balanceAdmin, /image\.addEventListener\('error',[\s\S]*?image\.style\.display = 'none';/);
  assert.match(balanceAdmin, /!state\.receiptLoaded/);
});

test('balance review summary stays a compact three-column grid on mobile', () => {
  assert.match(balanceAdmin, /\.hba-summary\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(balanceAdmin, /@media\(max-width:560px\)[\s\S]*?\.hba-summary\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\);gap:6px\}/);
  assert.doesNotMatch(balanceAdmin, /\.hba-meta,\.hba-summary\{grid-template-columns:1fr\}/);
});
