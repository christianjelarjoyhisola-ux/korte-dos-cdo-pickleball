import {
  mariBankExpectedRecipientName,
  mariBankRecipientReviewFlag,
  mariBankResultForFlags,
} from "./maribank-verification.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

Deno.test("MariBank uses only its provider-specific recipient name", () => {
  assertEquals(
    mariBankExpectedRecipientName({
      gcash_merchant_name: "Personal Account Holder",
      payment_merchant_name: "Another Generic Name",
    }),
    "Korte Dos",
    "generic or personal merchant names must not leak into MariBank checks",
  );
  assertEquals(
    mariBankExpectedRecipientName({
      maribank_recipient_name: "  Korte Dos CDO  ",
      gcash_merchant_name: "Personal Account Holder",
    }),
    "Korte Dos CDO",
    "the explicit MariBank setting should be used",
  );
});

Deno.test("MariBank accepts an exact destination recipient", () => {
  assertEquals(
    mariBankRecipientReviewFlag({
      recipientCheck: "match",
      exactQrAccountMatches: false,
      hasCoherentGcashRoute: true,
    }),
    null,
    "exact recipient should not create a review flag",
  );
});

Deno.test("MariBank allows an unreadable name only with exact QR and GCash route", () => {
  assertEquals(
    mariBankRecipientReviewFlag({
      recipientCheck: "unreadable",
      exactQrAccountMatches: true,
      hasCoherentGcashRoute: true,
    }),
    null,
    "exact QR destination should tolerate an unreadable display name",
  );
  assertEquals(
    mariBankRecipientReviewFlag({
      recipientCheck: "unreadable",
      exactQrAccountMatches: true,
      hasCoherentGcashRoute: false,
    }),
    "RECEIVER_NAME_UNREADABLE",
    "missing GCash route must remain pending",
  );
  assertEquals(
    mariBankRecipientReviewFlag({
      recipientCheck: "unreadable",
      exactQrAccountMatches: false,
      hasCoherentGcashRoute: true,
    }),
    "RECEIVER_NAME_UNREADABLE",
    "a route without exact QR proof must remain pending",
  );
});

Deno.test("MariBank readable wrong recipient always requires review", () => {
  assertEquals(
    mariBankRecipientReviewFlag({
      recipientCheck: "wrong",
      exactQrAccountMatches: true,
      hasCoherentGcashRoute: true,
    }),
    "RECEIVER_NAME_MISMATCH",
    "exact QR account must not hide a contradictory receiver",
  );
});

Deno.test("MariBank never automatically rejects a flagged receipt", () => {
  assertEquals(
    mariBankResultForFlags([]),
    "auto_approved",
    "clean evidence should auto-approve",
  );
  for (
    const flag of [
      "DUPLICATE_MARIBANK_TRANSACTION",
      "REF_MISMATCH",
      "AMOUNT_MISMATCH",
      "RECEIVER_NAME_MISMATCH",
      "ACCOUNT_UNREADABLE",
    ]
  ) {
    assertEquals(
      mariBankResultForFlags([flag]),
      "manual_review",
      `${flag} should stay pending`,
    );
  }
});
