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
const stagedReceiptReconciliationMigration = fs.readFileSync(
  'supabase/migrations/20260825143000_reconcile_staged_court_receipts.sql',
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

test('stored court receipts recover to owner review when verification is interrupted', () => {
  assert.match(supabaseConfig, /async recoverBookingReceipt\(payload\)/);
  assert.match(supabaseConfig, /action: 'recover_court_booking_receipt'/);
  assert.match(
    indexHtml,
    /recoverStoredBookingReceipt\(booking\.ref, \{[\s\S]*stagedReceiptPath:[\s\S]*_receiptUploadState\?\.result\?\.stagedReceiptPath/,
  );
  assert.match(indexHtml, /DB\.recoverBookingReceipt\(\{[\s\S]*stagedReceiptPath/);
  assert.match(receiptEdge, /if \(action === "recover_court_booking_receipt"\)/);
  assert.match(receiptEdge, /recoverCourtReceiptAfterFailure/);
  assert.match(receiptEdge, /VERIFICATION_PROCESSING_INCOMPLETE/);
  assert.match(
    receiptEdge,
    /status: "pending",[\s\S]*payment_status: "for_verification"/,
  );
});

test('expired recovery preserves evidence without silently reclaiming a slot', () => {
  assert.match(
    receiptEdge,
    /15-minute hold expired[\s\S]*without silently reoccupying[\s\S]*\.in\("status", \["cancelled", "forfeited"\]\)/,
  );
  assert.match(indexHtml, /bookingActive === false[\s\S]*showExpiredRecoveredReceipt/);
  assert.match(
    indexHtml,
    /showExpiredRecoveredReceipt[\s\S]*do not pay or book again/,
  );
});

test('stale hold expiry reconciles Storage evidence before cancellation', () => {
  assert.match(
    stagedReceiptReconciliationMigration,
    /join storage\.objects[\s\S]*object\.bucket_id = 'receipts'/,
  );
  assert.match(
    stagedReceiptReconciliationMigration,
    /status = 'pending'[\s\S]*payment_status = 'for_verification'[\s\S]*receipt_image_url = staged\.object_path/,
  );
  assert.match(
    stagedReceiptReconciliationMigration,
    /VERIFICATION_PROCESSING_INCOMPLETE/,
  );
  assert.match(
    stagedReceiptReconciliationMigration,
    /and not exists \([\s\S]*join storage\.objects[\s\S]*object\.name like evidence_booking\.ref \|\| '\/%'/,
  );
});

test('lost stage responses recover from the private booking prefix', () => {
  assert.match(
    receiptEdge,
    /if \(!stagedReceiptPath\)[\s\S]*\.from\("receipts"\)\.list\(bookingRef/,
  );
  assert.match(receiptEdge, /sortBy: \{ column: "updated_at", order: "desc" \}/);
  assert.match(
    supabaseConfig,
    /\.\.\.\(stagedReceiptPath \? \{ stagedReceiptPath \} : \{\}\)/,
  );
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
