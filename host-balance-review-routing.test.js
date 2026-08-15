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
