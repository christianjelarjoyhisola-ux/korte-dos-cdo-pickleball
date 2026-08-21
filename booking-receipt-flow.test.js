const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const indexHtml = fs.readFileSync('index.html', 'utf8');
const adminHtml = fs.readFileSync('admin.html', 'utf8');
const supabaseConfig = fs.readFileSync('supabase-config.js', 'utf8');
const receiptEdge = fs.readFileSync('supabase/functions/verify-gcash-receipt/index.ts', 'utf8');
const reviewEdge = fs.readFileSync('supabase/functions/review-payment-receipt/index.ts', 'utf8');
const manualRestoreMigration = fs.readFileSync(
  'supabase/migrations/20260813043000_restore_cancelled_manual_payment.sql',
  'utf8',
);

function functionSource(source, name, nextName) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const end = nextName ? source.indexOf(`async function ${nextName}(`, start + 1) : source.length;
  assert.notEqual(end, -1, `${nextName} should exist after ${name}`);
  return source.slice(start, end);
}

test('guest and host court bookings notify only after receipt verification', () => {
  const legacy = functionSource(indexHtml, 'submitBookingLegacy', 'submitBooking');
  const current = functionSource(indexHtml, 'submitBooking', 'verifyUploadedReceipt');

  for (const source of [legacy, current]) {
    const verifyAt = source.indexOf('await verifyUploadedReceipt(');
    const notifyAt = source.indexOf('DB.notifyBookingSubmitted(booking)');
    assert.ok(verifyAt >= 0, 'receipt verification should run');
    assert.ok(notifyAt > verifyAt, 'owner notification must follow receipt verification');
  }
});

test('large phone PNG files reach the compression step', () => {
  assert.equal(
    (indexHtml.match(/20 \* 1024 \* 1024/g) || []).length,
    3,
    'court, Open Play, and host-session uploads should accept raw images up to 20 MB',
  );
});

test('mobile multipart transport failures retry through the Base64 path', () => {
  assert.match(
    supabaseConfig,
    /catch \(transportError\)[\s\S]*timed out[\s\S]*_pbVerifyReceiptBase64Fallback\(fnUrl, payload, imageFile\)/,
  );
});

test('court receipt selection uploads before Continue and verification reuses it', () => {
  assert.match(indexHtml, /function onReceiptPicked[\s\S]*beginAutomaticReceiptUpload\(f\)/);
  assert.match(indexHtml, /Uploading receipt\.\.\. Please wait\./);
  assert.match(indexHtml, /Upload complete\. Tap Continue to verify your payment\./);
  assert.match(indexHtml, /Continue — Verify Payment/);
  assert.match(indexHtml, /_receiptUploadState\?\.status === 'uploaded'[\s\S]*Verifying payment\.\.\./);
  assert.match(indexHtml, /stagedReceiptPath: staged\.stagedReceiptPath/);
  assert.match(supabaseConfig, /async stageBookingReceipt\(payload\)/);
  assert.match(receiptEdge, /if \(action === "stage"\)/);
  assert.match(receiptEdge, /private storage checkpoint/);
  assert.match(receiptEdge, /from\("receipts"\)\.download\(stagedReceiptPath\)/);
});

test('payment review queue requires stored receipt evidence', () => {
  assert.match(
    adminHtml,
    /Payment Review contains stored evidence only[\s\S]*Boolean\(String\(b\.receiptImageUrl \|\| ''\)\.trim\(\)\)/,
  );
  assert.match(
    adminHtml,
    /The guest has not completed the receipt upload yet[\s\S]*temporary 15-minute slot hold/,
  );
});

test('cancelled digital bookings can be restored only through audited provider confirmation', () => {
  assert.match(adminHtml, /booking === 'cancelled' && payment === 'rejected'/);
  assert.match(adminHtml, /Received in Provider — Restore/);
  assert.match(adminHtml, /manualProviderConfirmation: state\.manualProviderConfirmation/);
  assert.match(supabaseConfig, /manualProviderConfirmation: options\?\.manualProviderConfirmation === true/);
  assert.match(reviewEdge, /restore_cancelled_booking_after_manual_payment/);
  assert.match(manualRestoreMigration, /earliest_start is null or earliest_start <= now\(\)/);
  assert.match(manualRestoreMigration, /Duplicate payment reference: this reference belongs to another payment/);
  assert.match(manualRestoreMigration, /MANUAL_PROVIDER_VERIFICATION/);
  assert.match(manualRestoreMigration, /payment_review_decisions/);
});

test('mobile booking actions offer a guarded one-step payment confirmation', () => {
  assert.match(
    adminHtml,
    /function quickPaymentApprovalButton\(b\)[\s\S]*paymentReviewDecisionState\(b, \{ imageAvailable: hasReceipt \}\)[\s\S]*if \(!state\.canApprove\) return ''/,
  );
  assert.match(adminHtml, /state\.manualProviderConfirmation \? 'Restore & Confirm' : 'Confirm Payment'/);
  assert.match(adminHtml, /function bookingActionsHtml\(b, canDelete\)[\s\S]*quickPaymentApprovalButton\(b\)/);
  assert.match(
    adminHtml,
    /async function quickConfirmPayment\(ref, button\)[\s\S]*DB\.getReceiptSignedUrl\(booking\.ref\)[\s\S]*paymentReviewDecisionState\(booking, \{ imageAvailable \}\)/,
  );
  assert.match(
    adminHtml,
    /async function quickConfirmPayment\(ref, button\)[\s\S]*manualReason\.length < 10[\s\S]*DB\.reviewPaymentReceipt\(ref, 'approve', manualReason, \{[\s\S]*manualProviderConfirmation: state\.manualProviderConfirmation/,
  );
});
