// deno-lint-ignore-file no-explicit-any

import {
  createPaymentReviewDeliveryIdempotencyKey,
  normalizePaymentReviewEmail,
  PAYMENT_REVIEW_NOTIFICATION_SETTING_KEY,
  type PaymentReviewNotification,
  sendPaymentReviewEmail,
} from "./payment-review-email.ts";

export const PAYMENT_REVIEW_NOTIFICATION_WORKER_SETTING_KEY =
  "payment_review_notification_worker_secret";

const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 50;
const MAX_CONCURRENCY = 5;

type ClaimedNotificationRow = {
  id: string;
  dedupe_key: string;
  receipt_verification_id?: number | string | null;
  booking_ref: string;
  booking_group_ref?: string | null;
  context_type: string;
  image_hash: string;
  payment_provider?: string | null;
  payment_reference_masked?: string | null;
  payload?: Record<string, unknown> | null;
  attempt_count: number;
};

export type PaymentReviewRetrySummary = {
  ok: boolean;
  disabled: boolean;
  claimed: number;
  sent: number;
  failed: number;
};

type ProcessPaymentReviewRetryOptions = {
  db: any;
  resendApiKey: string;
  fromAddress?: string;
  adminUrl?: string;
  batchSize?: unknown;
  fetcher?: typeof fetch;
};

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message.slice(0, 500);
  }
  return "Payment-review retry failed";
}

function retryDelayMinutes(attemptCount: number): number {
  if (attemptCount <= 1) return 1;
  if (attemptCount === 2) return 5;
  if (attemptCount === 3) return 15;
  return 60;
}

function isoAfterMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function normalizePaymentReviewWorkerBatchSize(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(parsed)));
}

export function paymentReviewWorkerSecretsMatch(
  providedValue: unknown,
  expectedValue: unknown,
): boolean {
  const provided = String(providedValue ?? "");
  const expected = String(expectedValue ?? "");
  if (
    provided.length < 32 ||
    expected.length < 32 ||
    provided.length > 512 ||
    expected.length > 512
  ) {
    return false;
  }

  const length = Math.max(provided.length, expected.length);
  let difference = provided.length ^ expected.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (provided.charCodeAt(index) || 0) ^
      (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function safePayload(row: ClaimedNotificationRow): Record<string, unknown> {
  return row.payload && typeof row.payload === "object" &&
      !Array.isArray(row.payload)
    ? row.payload
    : {};
}

export function paymentReviewNotificationFromClaimedRow(
  row: ClaimedNotificationRow,
): PaymentReviewNotification {
  const payload = safePayload(row);
  const receiptVerificationId = Number(row.receipt_verification_id);
  const flags = Array.isArray(payload.flags)
    ? payload.flags.map((flag) => cleanText(flag, 120)).filter(Boolean)
    : [];

  return {
    bookingRef: cleanText(row.booking_ref, 160),
    bookingGroupRef: cleanText(row.booking_group_ref, 160) || undefined,
    contextType: cleanText(
      row.context_type,
      32,
    ) as PaymentReviewNotification["contextType"],
    receiptVerificationId:
      Number.isSafeInteger(receiptVerificationId) && receiptVerificationId > 0
        ? receiptVerificationId
        : undefined,
    fullName: cleanText(payload.fullName, 160) || undefined,
    provider: cleanText(row.payment_provider || payload.provider, 48) ||
      undefined,
    // Only the already-masked audit value is available to the retry worker.
    // The email helper masks it again before rendering, so a full reference
    // can never be reconstructed or exposed by this path.
    paymentReference: cleanText(row.payment_reference_masked, 160) ||
      undefined,
    imageHash: cleanText(row.image_hash, 64).toLowerCase(),
    flags,
    expectedAmount: payload.expectedAmount as number | undefined,
    extractedAmount: payload.extractedAmount as number | undefined,
    courtLabel: cleanText(payload.courtLabel, 160) || undefined,
    scheduleLabel: cleanText(payload.scheduleLabel, 200) || undefined,
  };
}

async function markSent(
  db: any,
  row: ClaimedNotificationRow,
  recipient: string,
  providerMessageId?: string,
): Promise<void> {
  const { data, error } = await db
    .from("payment_review_notifications")
    .update({
      status: "sent",
      recipient_email: recipient,
      provider_message_id: providerMessageId || null,
      error_message: null,
      sent_at: new Date().toISOString(),
      next_attempt_at: null,
    })
    .eq("id", row.id)
    .eq("status", "sending")
    .eq("attempt_count", Number(row.attempt_count))
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Payment-review delivery lease was lost");
}

async function markFailed(
  db: any,
  row: ClaimedNotificationRow,
  recipient: string,
  error: unknown,
): Promise<void> {
  const attemptCount = Math.max(1, Number(row.attempt_count) || 1);
  const { error: updateError } = await db
    .from("payment_review_notifications")
    .update({
      status: "failed",
      recipient_email: recipient,
      error_message: errorText(error),
      next_attempt_at: isoAfterMinutes(retryDelayMinutes(attemptCount)),
    })
    .eq("id", row.id)
    .eq("status", "sending")
    .eq("attempt_count", attemptCount);
  if (updateError) {
    // A lost database update leaves the row under its sending lease. The
    // atomic claim RPC safely reclaims it after ten minutes.
    console.error("Unable to persist payment-review retry failure");
  }
}

async function processClaimedRow(
  options: ProcessPaymentReviewRetryOptions,
  recipient: string,
  row: ClaimedNotificationRow,
): Promise<boolean> {
  try {
    const notification = paymentReviewNotificationFromClaimedRow(row);
    const result = await sendPaymentReviewEmail({
      resendApiKey: options.resendApiKey,
      recipient,
      notification,
      idempotencyKey: await createPaymentReviewDeliveryIdempotencyKey(
        row.dedupe_key,
        recipient,
      ),
      fromAddress: options.fromAddress,
      adminUrl: options.adminUrl,
      fetcher: options.fetcher,
    });
    await markSent(options.db, row, recipient, result.providerMessageId);
    return true;
  } catch (error) {
    await markFailed(options.db, row, recipient, error);
    return false;
  }
}

export async function processDuePaymentReviewNotifications(
  options: ProcessPaymentReviewRetryOptions,
): Promise<PaymentReviewRetrySummary> {
  const { data: setting, error: settingError } = await options.db
    .from("private_settings")
    .select("value")
    .eq("key", PAYMENT_REVIEW_NOTIFICATION_SETTING_KEY)
    .maybeSingle();
  if (settingError) throw settingError;

  // Blank means alerts are intentionally off. Never reuse a recipient stored
  // on an older outbox row and never substitute a default address.
  const recipient = normalizePaymentReviewEmail(setting?.value);
  if (!recipient) {
    return {
      ok: true,
      disabled: true,
      claimed: 0,
      sent: 0,
      failed: 0,
    };
  }

  const batchSize = normalizePaymentReviewWorkerBatchSize(options.batchSize);
  const { data, error } = await options.db.rpc(
    "claim_due_payment_review_notifications",
    { p_limit: batchSize },
  );
  if (error) throw error;

  const rows = Array.isArray(data)
    ? data.slice(0, batchSize) as ClaimedNotificationRow[]
    : [];
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < rows.length; index += MAX_CONCURRENCY) {
    const results = await Promise.allSettled(
      rows.slice(index, index + MAX_CONCURRENCY).map((row) =>
        processClaimedRow(options, recipient, row)
      ),
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) sent += 1;
      else failed += 1;
    }
  }

  return {
    ok: failed === 0,
    disabled: false,
    claimed: rows.length,
    sent,
    failed,
  };
}
