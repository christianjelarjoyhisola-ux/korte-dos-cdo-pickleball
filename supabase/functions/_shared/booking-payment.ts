export type RateTier = {
  from: unknown;
  to: unknown;
  rate: unknown;
};

export type CourtPaymentInput = {
  slots: unknown;
  courtRate: unknown;
  courtRateSchedule?: unknown;
  fallbackRateSchedule?: unknown;
  feeRate?: unknown;
  feeType?: unknown;
  storedDownpayment: unknown;
  hostBooking?: unknown;
  paymentAcceptanceMode?: unknown;
};

export type CourtPaymentAmounts = {
  courtTotal: number;
  serviceFee: number;
  total: number;
  due: number;
};

export type StoredBookingPayment = {
  total: unknown;
  downpayment: unknown;
};

export function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function closeMoney(a: number, b: number): boolean {
  return Math.abs(roundMoney(a) - roundMoney(b)) <= 0.01;
}

export function parseRateTiers(raw: unknown): RateTier[] {
  if (Array.isArray(raw)) return raw as RateTier[];
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as RateTier[] : [];
  } catch {
    return [];
  }
}

function rateForHour(
  hour: number,
  tiers: RateTier[],
  fallbackRate: number,
): number {
  for (const tier of tiers) {
    const from = toNumber(tier.from);
    const to = toNumber(tier.to);
    const rate = toNumber(tier.rate, fallbackRate);
    const inRange = from < to
      ? hour >= from && hour < to
      : hour >= from || hour < to;
    if (inRange) return rate;
  }
  return tiers.length > 0
    ? Math.min(...tiers.map((tier) => toNumber(tier.rate, fallbackRate)))
    : fallbackRate;
}

function isFlatFeeType(value: unknown): boolean {
  return ["flat", "booking", "per_booking", "per_transaction"].includes(
    String(value || "").toLowerCase(),
  );
}

export function chooseExpectedDue(
  total: number,
  storedDownpayment: number,
  paymentAcceptanceMode: unknown,
): number {
  const half = roundMoney(total / 2);
  const mode = String(paymentAcceptanceMode || "both");
  if (mode === "full_payment_only") return total;
  if (mode === "downpayment_only") return half;
  if (closeMoney(storedDownpayment, total)) return total;
  if (closeMoney(storedDownpayment, half)) return half;
  throw new Error("Stored payment amount does not match current pricing");
}

export function calculateCourtPayment(
  input: CourtPaymentInput,
): CourtPaymentAmounts {
  const slots = Array.isArray(input.slots)
    ? input.slots.map(Number).filter(Number.isFinite)
    : [];
  if (slots.length === 0) throw new Error("Booking has no billable slots");

  const courtRate = toNumber(input.courtRate);
  const courtTiers = parseRateTiers(input.courtRateSchedule);
  const fallbackTiers = parseRateTiers(input.fallbackRateSchedule);
  const tiers = courtTiers.length
    ? courtTiers
    : fallbackTiers.length
    ? fallbackTiers
    : [{ from: 0, to: 24, rate: courtRate }];
  const courtTotal = roundMoney(
    slots.reduce((sum, hour) => sum + rateForHour(hour, tiers, courtRate), 0),
  );

  const feeRate = toNumber(input.feeRate);
  const serviceFee = roundMoney(
    isFlatFeeType(input.feeType) ? feeRate : feeRate * slots.length,
  );
  const total = roundMoney(courtTotal + serviceFee);
  const storedDownpayment = toNumber(input.storedDownpayment, -1);

  if (input.hostBooking === true) {
    // Hosts pay a quarter of the court charges, but the booking/service fee is
    // always collected in full. This is deliberately not 25% of the total.
    // A host may still elect to pay the complete booking total.
    const hostDue = roundMoney(courtTotal * 0.25 + serviceFee);
    if (closeMoney(storedDownpayment, hostDue)) {
      return { courtTotal, serviceFee, total, due: hostDue };
    }
    if (closeMoney(storedDownpayment, total)) {
      return { courtTotal, serviceFee, total, due: total };
    }
    throw new Error(
      "Stored host payment amount does not match current pricing",
    );
  }

  const due = chooseExpectedDue(
    total,
    storedDownpayment,
    input.paymentAcceptanceMode,
  );
  return { courtTotal, serviceFee, total, due };
}

function storedMoney(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Stored booking ${label} is invalid`);
  }
  return roundMoney(parsed);
}

export function classifyStoredSessionPayment(
  sessionAmount: unknown,
  bookings: StoredBookingPayment[],
): "paid" | "downpayment_paid" {
  if (!Array.isArray(bookings) || bookings.length === 0) {
    throw new Error("Payment session has no active booking rows");
  }

  const paidAmount = storedMoney(sessionAmount, "payment session amount");
  const expectedTotal = roundMoney(
    bookings.reduce(
      (sum, booking) => sum + storedMoney(booking.total, "total"),
      0,
    ),
  );
  const expectedDue = roundMoney(
    bookings.reduce(
      (sum, booking) => sum + storedMoney(booking.downpayment, "downpayment"),
      0,
    ),
  );

  if (expectedDue > expectedTotal + 0.01) {
    throw new Error("Stored booking payment exceeds the booking total");
  }
  if (!closeMoney(paidAmount, expectedDue)) {
    throw new Error(
      "Stored payment session amount does not match the booking amount due",
    );
  }
  return closeMoney(paidAmount, expectedTotal) ? "paid" : "downpayment_paid";
}
