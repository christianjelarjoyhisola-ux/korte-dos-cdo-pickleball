import {
  bookingOutcomeForReceipt,
  customerStatusForProcessedBooking,
} from "./receipt-review-policy.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

Deno.test("an automatically approved full payment confirms the booking", () => {
  assertEquals(bookingOutcomeForReceipt("auto_approved", 720, 720), {
    status: "confirmed",
    paymentStatus: "paid",
    customerStatus: "auto_approved",
    needsOwnerReview: false,
  });
});

Deno.test("an automatically approved downpayment confirms the booking", () => {
  assertEquals(bookingOutcomeForReceipt("auto_approved", 300, 720), {
    status: "confirmed",
    paymentStatus: "downpayment_paid",
    customerStatus: "auto_approved",
    needsOwnerReview: false,
  });
});

for (const verdict of ["manual_review", "rejected"] as const) {
  Deno.test(`${verdict} stays pending for the owner instead of cancelling`, () => {
    assertEquals(bookingOutcomeForReceipt(verdict, 100, 720), {
      status: "pending",
      paymentStatus: "for_verification",
      customerStatus: "manual_review",
      needsOwnerReview: true,
    });
  });
}

Deno.test("a human-approved payment overrides its preserved OCR verdict", () => {
  for (const receiptStatus of ["manual_review", "rejected"]) {
    assertEquals(
      customerStatusForProcessedBooking(
        receiptStatus,
        "confirmed",
        "downpayment_paid",
      ),
      "auto_approved",
    );
  }
});

Deno.test("a cancelled or rejected payment remains rejected", () => {
  assertEquals(
    customerStatusForProcessedBooking("manual_review", "cancelled", "paid"),
    "rejected",
  );
  assertEquals(
    customerStatusForProcessedBooking("manual_review", "pending", "rejected"),
    "rejected",
  );
});
