import {
  evaluateHostBalanceReceiptTime,
  HOST_BALANCE_RECEIPT_FUTURE_TOLERANCE_MINUTES,
  HOST_BALANCE_RECEIPT_MAX_AGE_MINUTES,
  HOST_BALANCE_RECEIPT_TIME_POLICY,
} from "./host-balance-receipt-time.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

// PH Sep 6, 2026 at 3:24 PM, represented as an actual UTC instant.
const REQUEST_RECEIVED_AT = new Date("2026-09-06T07:24:00.000Z");
const MINUTE_MS = 60_000;
const PH_OFFSET_MS = 8 * 60 * MINUTE_MS;

function evaluateAgeMinutes(ageMinutes: number) {
  return evaluateHostBalanceReceiptTime({
    receiptWallClock: new Date(
      REQUEST_RECEIVED_AT.getTime() - ageMinutes * MINUTE_MS + PH_OFFSET_MS,
    ),
    requestReceivedAt: REQUEST_RECEIVED_AT,
  });
}

for (const ageMinutes of [0, 3, 10, 60, 12 * 60, 23 * 60 + 59]) {
  Deno.test(`host balance accepts a receipt paid ${ageMinutes} minutes before upload`, () => {
    const result = evaluateAgeMinutes(ageMinutes);
    assertEquals(result.timestampVerified, true);
    assertEquals(result.needsOwnerReview, false);
    assertEquals(result.flags, []);
    assertEquals(result.audit.receiptAgeMinutes, ageMinutes);
  });
}

Deno.test("host balance accepts the inclusive 24-hour oldest receipt boundary", () => {
  const result = evaluateAgeMinutes(24 * 60);
  assertEquals(result.timestampVerified, true);
  assertEquals(result.needsOwnerReview, false);
  assertEquals(result.flags, []);
  assertEquals(result.audit.receiptAgeMinutes, 1440);
});

Deno.test("host balance routes a receipt one millisecond older than 24 hours to owner review", () => {
  const result = evaluateAgeMinutes(24 * 60 + 1 / MINUTE_MS);
  assertEquals(result.timestampVerified, false);
  assertEquals(result.needsOwnerReview, true);
  assertEquals(result.flags, ["HOST_BALANCE_RECEIPT_TOO_OLD"]);
});

for (const ageMinutes of [-1, -2]) {
  Deno.test(`host balance tolerates a receipt ${-ageMinutes} minutes ahead of server time`, () => {
    const result = evaluateAgeMinutes(ageMinutes);
    assertEquals(result.timestampVerified, true);
    assertEquals(result.needsOwnerReview, false);
    assertEquals(result.flags, []);
    assertEquals(result.audit.receiptAgeMinutes, ageMinutes);
  });
}

Deno.test("host balance routes a receipt one millisecond beyond future tolerance to owner review", () => {
  const result = evaluateAgeMinutes(-2 - 1 / MINUTE_MS);
  assertEquals(result.timestampVerified, false);
  assertEquals(result.needsOwnerReview, true);
  assertEquals(result.flags, ["HOST_BALANCE_RECEIPT_IN_FUTURE"]);
});

Deno.test("host balance accepts payment before Philippine midnight and upload after midnight", () => {
  const result = evaluateHostBalanceReceiptTime({
    receiptWallClock: new Date("2026-09-05T23:58:00.000Z"),
    requestReceivedAt: new Date("2026-09-05T16:03:00.000Z"),
  });
  assertEquals(result.timestampVerified, true);
  assertEquals(result.audit.receiptAgeMinutes, 5);
  assertEquals(result.audit.receiptPaidAt, "2026-09-05T15:58:00.000Z");
  assertEquals(result.audit.requestReceivedAt, "2026-09-05T16:03:00.000Z");
});

Deno.test("host balance accepts receipts across Philippine month and year boundaries", () => {
  for (
    const [receipt, request] of [
      ["2026-08-31T23:55:00.000Z", "2026-08-31T16:05:00.000Z"],
      ["2026-12-31T23:55:00.000Z", "2026-12-31T16:05:00.000Z"],
    ]
  ) {
    const result = evaluateHostBalanceReceiptTime({
      receiptWallClock: new Date(receipt),
      requestReceivedAt: new Date(request),
    });
    assertEquals(result.timestampVerified, true);
    assertEquals(result.audit.receiptAgeMinutes, 10);
  }
});

Deno.test("host balance converts PH wall clock once without an eight-hour age error", () => {
  const result = evaluateHostBalanceReceiptTime({
    receiptWallClock: new Date("2026-09-06T15:14:00.000Z"),
    requestReceivedAt: REQUEST_RECEIVED_AT,
  });
  assertEquals(result, {
    timestampVerified: true,
    needsOwnerReview: false,
    flags: [],
    audit: {
      policy: "host_balance_upload_24h_v1",
      requestReceivedAt: "2026-09-06T07:24:00.000Z",
      receiptPaidAt: "2026-09-06T07:14:00.000Z",
      receiptAgeMinutes: 10,
      maxAgeMinutes: 1440,
      futureToleranceMinutes: 2,
    },
  });
});

Deno.test("host balance accepts equivalent explicit timezone offsets for the server instant", () => {
  const result = evaluateHostBalanceReceiptTime({
    receiptWallClock: new Date("2026-09-06T15:14:00.000Z"),
    requestReceivedAt: new Date("2026-09-06T15:24:00.000+08:00"),
  });
  assertEquals(result.timestampVerified, true);
  assertEquals(result.audit.receiptAgeMinutes, 10);
  assertEquals(
    result.audit.requestReceivedAt,
    REQUEST_RECEIVED_AT.toISOString(),
  );
});

for (const receiptWallClock of [null, new Date(Number.NaN)]) {
  Deno.test(`host balance routes ${receiptWallClock === null ? "missing" : "invalid"} receipt time to owner review`, () => {
    const result = evaluateHostBalanceReceiptTime({
      receiptWallClock,
      requestReceivedAt: REQUEST_RECEIVED_AT,
    });
    assertEquals(result.timestampVerified, false);
    assertEquals(result.needsOwnerReview, true);
    assertEquals(result.flags, ["HOST_BALANCE_RECEIPT_TIME_UNREADABLE"]);
    assertEquals(result.audit.receiptPaidAt, null);
    assertEquals(result.audit.receiptAgeMinutes, null);
  });
}

Deno.test("host balance fails closed when converting a receipt exceeds the Date range", () => {
  const result = evaluateHostBalanceReceiptTime({
    receiptWallClock: new Date(-8_640_000_000_000_000),
    requestReceivedAt: REQUEST_RECEIVED_AT,
  });
  assertEquals(result.timestampVerified, false);
  assertEquals(result.needsOwnerReview, true);
  assertEquals(result.flags, ["HOST_BALANCE_RECEIPT_TIME_UNREADABLE"]);
  assertEquals(result.audit.receiptPaidAt, null);
});

Deno.test("host balance fails closed when the trusted request timestamp is invalid", () => {
  const result = evaluateHostBalanceReceiptTime({
    receiptWallClock: new Date("2026-09-06T15:14:00.000Z"),
    requestReceivedAt: new Date(Number.NaN),
  });
  assertEquals(result.timestampVerified, false);
  assertEquals(result.needsOwnerReview, true);
  assertEquals(result.flags, ["HOST_BALANCE_REQUEST_TIME_INVALID"]);
  assertEquals(result.audit.requestReceivedAt, null);
  assertEquals(result.audit.receiptAgeMinutes, null);
});

Deno.test("host balance preserves both review reasons when both timestamps are invalid", () => {
  const result = evaluateHostBalanceReceiptTime({
    receiptWallClock: null,
    requestReceivedAt: new Date(Number.NaN),
  });
  assertEquals(result.timestampVerified, false);
  assertEquals(result.needsOwnerReview, true);
  assertEquals(result.flags, [
    "HOST_BALANCE_REQUEST_TIME_INVALID",
    "HOST_BALANCE_RECEIPT_TIME_UNREADABLE",
  ]);
  assertEquals(result.audit.requestReceivedAt, null);
  assertEquals(result.audit.receiptPaidAt, null);
  assertEquals(result.audit.receiptAgeMinutes, null);
});

Deno.test("host balance timing is deterministic and does not mutate either timestamp", () => {
  const receiptWallClock = new Date("2026-09-06T15:14:00.000Z");
  const requestReceivedAt = new Date(REQUEST_RECEIVED_AT);
  const input = { receiptWallClock, requestReceivedAt };
  const first = evaluateHostBalanceReceiptTime(input);
  assertEquals(evaluateHostBalanceReceiptTime(input), first);
  assertEquals(receiptWallClock.toISOString(), "2026-09-06T15:14:00.000Z");
  assertEquals(requestReceivedAt.toISOString(), "2026-09-06T07:24:00.000Z");
});

Deno.test("host balance audit declares the policy and limits used for review", () => {
  const result = evaluateAgeMinutes(25 * 60);
  assertEquals(result.needsOwnerReview, true);
  assertEquals(result.audit.policy, HOST_BALANCE_RECEIPT_TIME_POLICY);
  assertEquals(
    result.audit.maxAgeMinutes,
    HOST_BALANCE_RECEIPT_MAX_AGE_MINUTES,
  );
  assertEquals(
    result.audit.futureToleranceMinutes,
    HOST_BALANCE_RECEIPT_FUTURE_TOLERANCE_MINUTES,
  );
  assertEquals(result.audit.receiptAgeMinutes, 1500);
});
