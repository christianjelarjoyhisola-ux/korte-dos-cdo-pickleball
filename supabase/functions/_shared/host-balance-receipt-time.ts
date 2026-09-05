const MINUTE_MS = 60_000;
const PHILIPPINE_UTC_OFFSET_MS = 8 * 60 * MINUTE_MS;

export const HOST_BALANCE_RECEIPT_MAX_AGE_MINUTES = 24 * 60;
export const HOST_BALANCE_RECEIPT_FUTURE_TOLERANCE_MINUTES = 2;
export const HOST_BALANCE_RECEIPT_TIME_POLICY = "host_balance_upload_24h_v1";

export type HostBalanceReceiptTimeFlag =
  | "HOST_BALANCE_RECEIPT_TIME_UNREADABLE"
  | "HOST_BALANCE_RECEIPT_TOO_OLD"
  | "HOST_BALANCE_RECEIPT_IN_FUTURE"
  | "HOST_BALANCE_REQUEST_TIME_INVALID";

export type HostBalanceReceiptTimeResult = {
  timestampVerified: boolean;
  needsOwnerReview: boolean;
  flags: HostBalanceReceiptTimeFlag[];
  audit: {
    policy: typeof HOST_BALANCE_RECEIPT_TIME_POLICY;
    requestReceivedAt: string | null;
    receiptPaidAt: string | null;
    receiptAgeMinutes: number | null;
    maxAgeMinutes: number;
    futureToleranceMinutes: number;
  };
};

/**
 * Timing policy only for an existing host booking's remaining-balance payment.
 * A passing timestamp is not sufficient to approve a receipt: the caller must
 * still verify its recipient, amount, reference, and duplicate-payment checks.
 *
 * receiptWallClock is the receipt parser's representation of Philippine local
 * time in UTC fields (e.g. a receipt showing 9 PM is represented as 21:00Z).
 * requestReceivedAt is an actual UTC instant captured by the server at request
 * entry, before uploads/OCR. It must never come from client input or the time
 * at which OCR completes. This helper converts the receipt to actual UTC once.
 *
 * Both limits are inclusive. Older/future/unreadable receipts require owner
 * review; timing alone never rejects a balance payment or cancels a booking.
 * Do not use this policy for new-booking or session-join payment holds.
 */
export function evaluateHostBalanceReceiptTime({
  receiptWallClock,
  requestReceivedAt,
}: {
  receiptWallClock: Date | null;
  requestReceivedAt: Date;
}): HostBalanceReceiptTimeResult {
  const flags: HostBalanceReceiptTimeFlag[] = [];
  const requestMs = requestReceivedAt.getTime();
  const receiptMs = receiptWallClock === null
    ? Number.NaN
    : new Date(receiptWallClock.getTime() - PHILIPPINE_UTC_OFFSET_MS).getTime();
  const requestValid = Number.isFinite(requestMs);
  const receiptValid = Number.isFinite(receiptMs);

  if (!requestValid) flags.push("HOST_BALANCE_REQUEST_TIME_INVALID");
  if (!receiptValid) flags.push("HOST_BALANCE_RECEIPT_TIME_UNREADABLE");

  const receiptAgeMinutes = requestValid && receiptValid
    ? (requestMs - receiptMs) / MINUTE_MS
    : null;

  if (receiptAgeMinutes !== null) {
    if (receiptAgeMinutes > HOST_BALANCE_RECEIPT_MAX_AGE_MINUTES) {
      flags.push("HOST_BALANCE_RECEIPT_TOO_OLD");
    } else if (
      receiptAgeMinutes < -HOST_BALANCE_RECEIPT_FUTURE_TOLERANCE_MINUTES
    ) {
      flags.push("HOST_BALANCE_RECEIPT_IN_FUTURE");
    }
  }

  return {
    timestampVerified: flags.length === 0,
    needsOwnerReview: flags.length > 0,
    flags,
    audit: {
      policy: HOST_BALANCE_RECEIPT_TIME_POLICY,
      requestReceivedAt: requestValid ? requestReceivedAt.toISOString() : null,
      receiptPaidAt: receiptValid ? new Date(receiptMs).toISOString() : null,
      receiptAgeMinutes,
      maxAgeMinutes: HOST_BALANCE_RECEIPT_MAX_AGE_MINUTES,
      futureToleranceMinutes: HOST_BALANCE_RECEIPT_FUTURE_TOLERANCE_MINUTES,
    },
  };
}
