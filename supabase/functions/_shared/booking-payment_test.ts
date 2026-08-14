import {
  calculateCourtPayment,
  classifyStoredSessionPayment,
} from "./booking-payment.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

const base = {
  slots: [17, 18],
  courtRate: 400,
  feeRate: 20,
  feeType: "per_hour",
  paymentAcceptanceMode: "both",
};

Deno.test("regular booking keeps the existing 50% downpayment", () => {
  const amounts = calculateCourtPayment({ ...base, storedDownpayment: 420 });
  assertEquals(amounts.courtTotal, 800, "court total");
  assertEquals(amounts.serviceFee, 40, "service fee");
  assertEquals(amounts.total, 840, "booking total");
  assertEquals(amounts.due, 420, "regular downpayment");
});

Deno.test("regular booking still permits full payment", () => {
  const amounts = calculateCourtPayment({ ...base, storedDownpayment: 840 });
  assertEquals(amounts.due, 840, "full payment");
});

Deno.test("voucher reduces only the court charge and keeps the booking fee", () => {
  const amounts = calculateCourtPayment({
    ...base,
    storedTotal: 740,
    storedDownpayment: 390,
    voucherDiscountAmount: 100,
    bookingFeeSnapshot: 40,
  });
  assertEquals(amounts.courtTotal, 700, "discounted court total");
  assertEquals(amounts.serviceFee, 40, "protected booking fee");
  assertEquals(amounts.total, 740, "net booking total");
  assertEquals(amounts.due, 390, "fee plus half of discounted court charge");
});

Deno.test("voucher cannot discount more than the court charge", () => {
  assertThrows(
    () => calculateCourtPayment({
      ...base,
      storedTotal: 20,
      storedDownpayment: 20,
      voucherDiscountAmount: 820,
      bookingFeeSnapshot: 40,
    }),
    "voucher must not consume the booking fee",
  );
});

Deno.test("host due is 25% of court charges plus the full service fee", () => {
  const amounts = calculateCourtPayment({
    ...base,
    storedDownpayment: 240,
    hostBooking: true,
  });
  assertEquals(amounts.due, 240, "host downpayment");
});

Deno.test("host booking still permits full payment when stored that way", () => {
  const amounts = calculateCourtPayment({
    ...base,
    storedDownpayment: 840,
    hostBooking: true,
  });
  assertEquals(amounts.due, 840, "host full payment");
});

Deno.test("host voucher reduces the court charge while keeping the full booking fee", () => {
  const amounts = calculateCourtPayment({
    ...base,
    storedTotal: 740,
    storedDownpayment: 215,
    voucherDiscountAmount: 100,
    bookingFeeSnapshot: 40,
    hostBooking: true,
  });
  assertEquals(amounts.courtTotal, 700, "discounted host court total");
  assertEquals(amounts.serviceFee, 40, "protected host booking fee");
  assertEquals(amounts.total, 740, "net host booking total");
  assertEquals(amounts.due, 215, "fee plus 25% of discounted court charge");
});

Deno.test("a full court voucher still leaves the host booking fee due", () => {
  const amounts = calculateCourtPayment({
    ...base,
    storedTotal: 40,
    storedDownpayment: 40,
    voucherDiscountAmount: 800,
    bookingFeeSnapshot: 40,
    hostBooking: true,
  });
  assertEquals(amounts.courtTotal, 0, "fully discounted court total");
  assertEquals(amounts.serviceFee, 40, "booking fee remains payable");
  assertEquals(amounts.total, 40, "only the booking fee remains");
  assertEquals(amounts.due, 40, "host must still pay the booking fee");
});

Deno.test("booking fee aliases are treated as one flat fee", () => {
  const amounts = calculateCourtPayment({
    ...base,
    feeType: "per_booking",
    storedDownpayment: 220,
    hostBooking: true,
  });
  assertEquals(amounts.serviceFee, 20, "flat booking fee");
  assertEquals(amounts.due, 220, "host due with flat booking fee");
});

Deno.test("host stored downpayment must match the recomputed host due", () => {
  assertThrows(
    () =>
      calculateCourtPayment({
        ...base,
        // This is 25% of the grand total, not the valid host formula.
        storedDownpayment: 210,
        hostBooking: true,
      }),
    "invalid host downpayment should be rejected",
  );
});

Deno.test("grouped host dues add the full fee for every booking row", () => {
  const first = calculateCourtPayment({
    ...base,
    slots: [17, 18],
    storedDownpayment: 240,
    hostBooking: true,
  });
  const second = calculateCourtPayment({
    ...base,
    slots: [19],
    storedDownpayment: 120,
    hostBooking: true,
  });
  assertEquals(first.due + second.due, 360, "group host due");
  assertEquals(first.total + second.total, 1260, "group total");
});

Deno.test("stored partial checkout becomes downpayment paid", () => {
  const status = classifyStoredSessionPayment(240, [{
    total: 840,
    downpayment: 240,
  }]);
  assertEquals(status, "downpayment_paid", "partial checkout status");
});

Deno.test("stored full checkout becomes fully paid", () => {
  const status = classifyStoredSessionPayment(840, [{
    total: 840,
    downpayment: 840,
  }]);
  assertEquals(status, "paid", "full checkout status");
});

Deno.test("stored grouped checkout sums every active booking row", () => {
  const status = classifyStoredSessionPayment(360, [
    { total: 840, downpayment: 240 },
    { total: 420, downpayment: 120 },
  ]);
  assertEquals(status, "downpayment_paid", "group checkout status");
});

Deno.test("webhook payment cannot override the stored session amount", () => {
  assertThrows(
    () =>
      classifyStoredSessionPayment(210, [{
        total: 840,
        downpayment: 240,
      }]),
    "mismatched session amount should be rejected",
  );
});
