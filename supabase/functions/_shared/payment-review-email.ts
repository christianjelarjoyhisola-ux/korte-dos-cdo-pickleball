// deno-lint-ignore-file no-explicit-any

export const PAYMENT_REVIEW_NOTIFICATION_SETTING_KEY =
  "payment_review_notification_email";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM_ADDRESS = "KORTE DOS <onboarding@resend.dev>";
const DEFAULT_ADMIN_URL = "https://kortedoscdo.club/admin.html";
const SENDING_LEASE_MS = 10 * 60 * 1000;

export type PaymentReviewContext =
  | "court_booking"
  | "open_play"
  | "host_session";

export type PaymentReviewNotification = {
  bookingRef: string;
  bookingGroupRef?: string;
  contextType: PaymentReviewContext;
  receiptVerificationId?: number;
  fullName?: string;
  provider?: string;
  paymentReference?: string;
  imageHash: string;
  flags: string[];
  expectedAmount?: number;
  extractedAmount?: number;
  courtLabel?: string;
  scheduleLabel?: string;
};

export type PaymentReviewDeliveryResult = {
  ok: boolean;
  sent: boolean;
  skipped: boolean;
  reason?: string;
  deliveryId?: string;
  providerMessageId?: string;
};

export type PaymentReviewEmail = {
  subject: string;
  html: string;
  text: string;
};

type SafePaymentReviewNotification = {
  bookingRef: string;
  bookingGroupRef?: string;
  contextType: PaymentReviewContext;
  receiptVerificationId?: number;
  fullName?: string;
  provider?: string;
  paymentReference?: string;
  imageHash: string;
  flags: string[];
  expectedAmount?: number;
  extractedAmount?: number;
  courtLabel?: string;
  scheduleLabel?: string;
};

type DeliveryRow = {
  id: string;
  status: "pending" | "sending" | "sent" | "failed";
  attempt_count: number;
  provider_message_id?: string | null;
  last_attempt_at?: string | null;
  next_attempt_at?: string | null;
};

export type SendPaymentReviewEmailOptions = {
  resendApiKey: string;
  recipient: string;
  notification: PaymentReviewNotification;
  idempotencyKey: string;
  fromAddress?: string;
  adminUrl?: string;
  fetcher?: typeof fetch;
};

export type SendPaymentReviewTestEmailOptions = {
  resendApiKey: string;
  recipient: string;
  idempotencyKey: string;
  fromAddress?: string;
  fetcher?: typeof fetch;
};

export type DeliverPaymentReviewNotificationOptions = {
  db: any;
  resendApiKey: string;
  fromAddress?: string;
  adminUrl?: string;
  notification: PaymentReviewNotification;
  fetcher?: typeof fetch;
};

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeOptionalText(
  value: unknown,
  maxLength: number,
): string | undefined {
  const clean = cleanText(value, maxLength);
  return clean || undefined;
}

function safeAmount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
    return undefined;
  }
  return Math.round(amount * 100) / 100;
}

function safeReceiptVerificationId(value: unknown): number | undefined {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function safeNotification(
  notification: PaymentReviewNotification,
): SafePaymentReviewNotification {
  if (!notification || typeof notification !== "object") {
    throw new Error("notification is required");
  }
  const bookingRef = cleanText(notification?.bookingRef, 160);
  if (!bookingRef) throw new Error("bookingRef is required");

  const contextType = cleanText(notification?.contextType, 32);
  if (
    !["court_booking", "open_play", "host_session"].includes(contextType)
  ) {
    throw new Error("contextType is invalid");
  }

  const imageHash = cleanText(notification?.imageHash, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(imageHash)) {
    throw new Error("imageHash must be a SHA-256 hex digest");
  }

  const flags = Array.isArray(notification?.flags)
    ? [
      ...new Set(
        notification.flags
          .map((flag) => cleanText(flag, 120))
          .filter(Boolean),
      ),
    ].slice(0, 20)
    : [];

  return {
    bookingRef,
    bookingGroupRef: safeOptionalText(notification.bookingGroupRef, 160),
    contextType: contextType as PaymentReviewContext,
    receiptVerificationId: safeReceiptVerificationId(
      notification.receiptVerificationId,
    ),
    fullName: safeOptionalText(notification.fullName, 160),
    provider: safeOptionalText(notification.provider, 48)?.toLowerCase(),
    paymentReference: safeOptionalText(notification.paymentReference, 160),
    imageHash,
    flags,
    expectedAmount: safeAmount(notification.expectedAmount),
    extractedAmount: safeAmount(notification.extractedAmount),
    courtLabel: safeOptionalText(notification.courtLabel, 160),
    scheduleLabel: safeOptionalText(notification.scheduleLabel, 200),
  };
}

export function normalizePaymentReviewEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return "";
  if (
    email.length > 254 ||
    /[\r\n,;<>()[\]\\"]/.test(email) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error("Enter a valid notification email address.");
  }
  return email;
}

export function escapePaymentReviewHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function maskPaymentReference(value: unknown): string {
  const reference = cleanText(value, 160).replace(/\s+/g, "");
  if (!reference) return "";
  if (reference.length <= 2) return "••••";
  if (reference.length <= 4) return `••••${reference.slice(-2)}`;
  return `••••${reference.slice(-4)}`;
}

function normalizeFromAddress(value: unknown): string {
  const from = String(value ?? "").trim() || DEFAULT_FROM_ADDRESS;
  if (
    from.length > 320 ||
    /[\r\n]/.test(from) ||
    !/@/.test(from)
  ) {
    throw new Error("EMAIL_FROM is invalid");
  }
  return from;
}

function normalizeAdminUrl(value: unknown): string {
  const raw = String(value ?? "").trim() || DEFAULT_ADMIN_URL;
  try {
    const parsed = new URL(raw);
    if (!["https:", "http:"].includes(parsed.protocol)) {
      throw new Error("unsupported protocol");
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return DEFAULT_ADMIN_URL;
  }
}

export function buildPaymentReviewUrl(
  adminUrl: unknown,
  bookingRef: unknown,
): string {
  const parsed = new URL(normalizeAdminUrl(adminUrl));
  parsed.hash = "";
  parsed.searchParams.set("section", "payreview");
  parsed.searchParams.set("review", cleanText(bookingRef, 160));
  return parsed.toString();
}

function contextLabel(context: PaymentReviewContext): string {
  if (context === "open_play") return "Open Play registration";
  if (context === "host_session") return "Host session registration";
  return "Court booking";
}

export function paymentReviewFlagLabel(flag: unknown): string {
  const key = cleanText(flag, 120).toUpperCase();
  const labels: Record<string, string> = {
    WRONG_GCASH_NUMBER: "Receiver number needs checking",
    AMOUNT_MISMATCH: "Payment amount needs checking",
    METHOD_MISMATCH: "Payment method does not match the selected method",
    REF_MISMATCH: "Payment reference needs checking",
    REF_FORMAT_INVALID: "Payment reference format needs checking",
    DATE_NOT_TODAY: "Receipt date needs checking",
    TIME_EXPIRED: "Payment time is outside the booking window",
    TIME_FUTURE: "Receipt time needs checking",
    IMAGE_UNREADABLE: "Receipt image could not be read",
    OCR_UNAVAILABLE: "Automatic receipt reading was unavailable",
    SUSPECTED_FAKE: "Receipt content could not be validated automatically",
    DUPLICATE_REF: "Payment reference may have been used before",
    DUPLICATE_INVOICE: "Invoice number may have been used before",
    DUPLICATE_INSTAPAY_REF: "InstaPay reference may have been used before",
    DUPLICATE_BPI_TRANSACTION_REF:
      "BPI transaction reference may have been used before",
    DUPLICATE_MARIBANK_TRANSACTION:
      "MariBank transaction may have been used before",
    BOOKING_UPDATE_FAILED: "Automatic booking confirmation did not finish",
    SESSION_CAPACITY_REVIEW:
      "The session filled while this paid receipt was being checked",
    VERIFICATION_PROCESSING_ERROR:
      "Automatic receipt verification did not finish",
  };
  if (labels[key]) return labels[key];
  if (!key) return "Receipt needs a manual decision";
  return key.toLowerCase().replace(/_/g, " ").replace(
    /\b\w/g,
    (letter) => letter.toUpperCase(),
  );
}

function moneyText(value: number | undefined): string {
  if (value === undefined) return "Not read";
  return `₱${
    value.toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

export function buildPaymentReviewEmail(
  notification: PaymentReviewNotification,
  adminUrl?: string,
): PaymentReviewEmail {
  const safe = safeNotification(notification);
  const reviewUrl = buildPaymentReviewUrl(adminUrl, safe.bookingRef);
  const maskedReference = maskPaymentReference(safe.paymentReference);
  const flags = safe.flags.length > 0
    ? safe.flags.map(paymentReviewFlagLabel)
    : ["Receipt needs a manual decision"];

  const detailRows: Array<[string, string]> = [
    ["Booking reference", safe.bookingRef],
    ["Type", contextLabel(safe.contextType)],
  ];
  if (safe.fullName) detailRows.push(["Player", safe.fullName]);
  if (safe.courtLabel) detailRows.push(["Court", safe.courtLabel]);
  if (safe.scheduleLabel) detailRows.push(["Schedule", safe.scheduleLabel]);
  if (safe.provider) {
    detailRows.push(["Payment provider", safe.provider.toUpperCase()]);
  }
  if (maskedReference) {
    detailRows.push(["Payment reference", maskedReference]);
  }
  detailRows.push(["Expected amount", moneyText(safe.expectedAmount)]);
  detailRows.push(["Amount seen", moneyText(safe.extractedAmount)]);

  const rowsHtml = detailRows.map(([label, value]) =>
    `<tr>
      <td style="padding:9px 12px;color:#94a3b8;font-size:12px;border-bottom:1px solid #263244;">${
      escapePaymentReviewHtml(label)
    }</td>
      <td style="padding:9px 12px;color:#f8fafc;font-size:14px;font-weight:700;border-bottom:1px solid #263244;">${
      escapePaymentReviewHtml(value)
    }</td>
    </tr>`
  ).join("");

  const flagsHtml = flags.map((flag) =>
    `<li style="margin:0 0 6px;color:#fecaca;">${
      escapePaymentReviewHtml(flag)
    }</li>`
  ).join("");

  const subject = `Payment receipt needs review — ${safe.bookingRef}`;
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:28px 12px;background:#0f172a;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;max-width:560px;background:#172033;border:1px solid #334155;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:24px 28px;background:#7f1d1d;border-bottom:4px solid #f97316;">
          <div style="color:#fff7ed;font-size:12px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;">Korte DOS payment review</div>
          <h1 style="margin:8px 0 0;color:#ffffff;font-size:23px;line-height:1.25;">A receipt needs your decision</h1>
        </td></tr>
        <tr><td style="padding:26px 28px;">
          <p style="margin:0 0 18px;color:#cbd5e1;line-height:1.55;">The booking remains pending. Review the stored receipt before approving or rejecting payment.</p>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #334155;border-radius:10px;overflow:hidden;">${rowsHtml}</table>
          <div style="margin:20px 0;padding:15px 18px;background:#3f1d24;border:1px solid #7f1d1d;border-radius:10px;">
            <div style="margin-bottom:8px;color:#fed7aa;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;">Review flags</div>
            <ul style="margin:0;padding-left:20px;">${flagsHtml}</ul>
          </div>
          <a href="${
    escapePaymentReviewHtml(reviewUrl)
  }" style="display:inline-block;padding:13px 20px;background:#f97316;color:#111827;text-decoration:none;font-weight:900;border-radius:8px;">Open Payment Review</a>
          <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;line-height:1.5;">Do not approve from the email alone. Open the private dashboard and compare the stored receipt with the booking.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const detailText = detailRows.map(([label, value]) => `${label}: ${value}`)
    .join("\n");
  const text = `KORTE DOS PAYMENT REVIEW

A receipt needs your decision. The booking remains pending.

${detailText}

Review flags:
${flags.map((flag) => `- ${flag}`).join("\n")}

Open Payment Review: ${reviewUrl}

Do not approve from this email alone. Review the stored receipt in the private dashboard.`;

  return { subject, html, text };
}

export function buildPaymentReviewTestEmail(): PaymentReviewEmail {
  const subject = "Test — KORTE DOS payment review alerts";
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:28px 12px;background:#0f172a;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;max-width:520px;background:#172033;border:1px solid #334155;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:24px 28px;background:#14532d;border-bottom:4px solid #22c55e;">
          <div style="color:#dcfce7;font-size:12px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;">Korte DOS payment review</div>
          <h1 style="margin:8px 0 0;color:#ffffff;font-size:23px;line-height:1.25;">Email alerts are configured</h1>
        </td></tr>
        <tr><td style="padding:26px 28px;">
          <p style="margin:0 0 12px;color:#f8fafc;font-size:16px;font-weight:700;">Your test email arrived successfully.</p>
          <p style="margin:0;color:#cbd5e1;line-height:1.6;">KORTE DOS can send a private alert to this address when a payment receipt needs manual review.</p>
          <p style="margin:20px 0 0;color:#94a3b8;font-size:12px;line-height:1.5;">This is only a configuration test. No booking exists and no action is required.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  const text = `KORTE DOS PAYMENT REVIEW ALERTS

Your test email arrived successfully.

KORTE DOS can send a private alert to this address when a payment receipt needs manual review.

This is only a configuration test. No booking exists and no action is required.`;
  return { subject, html, text };
}

export async function createPaymentReviewDedupeKey(
  notification: PaymentReviewNotification,
): Promise<string> {
  const safe = safeNotification(notification);
  const bookingIdentity = safe.contextType === "court_booking"
    ? safe.bookingGroupRef || safe.bookingRef
    : safe.bookingRef;
  const material = [
    "payment-review-v1",
    safe.contextType,
    bookingIdentity.toLowerCase(),
    safe.provider || "",
    (safe.paymentReference || "").toLowerCase(),
    safe.imageHash,
  ].join("\u0000");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `payment-review:v1:${hex}`;
}

async function sendResendEmail(
  options: {
    resendApiKey: string;
    recipient: string;
    idempotencyKey: string;
    fromAddress?: string;
    fetcher?: typeof fetch;
  },
  email: PaymentReviewEmail,
): Promise<{ providerMessageId?: string }> {
  const resendApiKey = String(options.resendApiKey ?? "").trim();
  if (
    resendApiKey.length < 10 ||
    resendApiKey.length > 512 ||
    /[\r\n]/.test(resendApiKey)
  ) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const recipient = normalizePaymentReviewEmail(options.recipient);
  if (!recipient) throw new Error("Notification recipient is not configured");

  const idempotencyKey = cleanText(options.idempotencyKey, 160);
  if (idempotencyKey.length < 16) {
    throw new Error("Email idempotency key is invalid");
  }

  const fetcher = options.fetcher || fetch;
  const request = {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: normalizeFromAddress(options.fromAddress),
      to: [recipient],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetcher(RESEND_ENDPOINT, request);
      const responseBody = await response.json().catch(() => ({}));
      if (response.ok) {
        const providerMessageId = cleanText(
          (responseBody as Record<string, unknown>)?.id,
          160,
        );
        return providerMessageId ? { providerMessageId } : {};
      }

      lastError = new Error(
        `Resend rejected the email with status ${response.status}`,
      );
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error;
    }

    if (attempt < 3) {
      await new Promise((resolve) =>
        setTimeout(resolve, attempt === 1 ? 250 : 750)
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Payment-review email delivery failed");
}

export function sendPaymentReviewEmail(
  options: SendPaymentReviewEmailOptions,
): Promise<{ providerMessageId?: string }> {
  return sendResendEmail(
    options,
    buildPaymentReviewEmail(options.notification, options.adminUrl),
  );
}

export function sendPaymentReviewTestEmail(
  options: SendPaymentReviewTestEmailOptions,
): Promise<{ providerMessageId?: string }> {
  return sendResendEmail(options, buildPaymentReviewTestEmail());
}

function isUniqueViolation(error: any): boolean {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return code === "23505" || message.includes("duplicate key");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message.slice(0, 500);
  }
  return "Unknown payment-review notification error";
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

function isRecentSendingLease(row: DeliveryRow): boolean {
  if (row.status !== "sending" || !row.last_attempt_at) return false;
  const attemptedAt = new Date(row.last_attempt_at).getTime();
  return Number.isFinite(attemptedAt) &&
    Date.now() - attemptedAt < SENDING_LEASE_MS;
}

function isInRetryBackoff(row: DeliveryRow): boolean {
  if (row.status !== "failed" || !row.next_attempt_at) return false;
  const nextAttemptAt = new Date(row.next_attempt_at).getTime();
  return Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now();
}

export async function deliverPaymentReviewNotification(
  options: DeliverPaymentReviewNotificationOptions,
): Promise<PaymentReviewDeliveryResult> {
  let deliveryId: string | undefined;
  let claimedAttempt = 0;

  try {
    const notification = safeNotification(options.notification);
    const { data: setting, error: settingError } = await options.db
      .from("private_settings")
      .select("value")
      .eq("key", PAYMENT_REVIEW_NOTIFICATION_SETTING_KEY)
      .maybeSingle();
    if (settingError) throw settingError;

    const recipient = normalizePaymentReviewEmail(setting?.value);
    if (!recipient) {
      return {
        ok: true,
        sent: false,
        skipped: true,
        reason: "recipient_not_configured",
      };
    }

    const dedupeKey = await createPaymentReviewDedupeKey(notification);
    const maskedPaymentReference = maskPaymentReference(
      notification.paymentReference,
    );
    const nowIso = new Date().toISOString();
    const safePayload = {
      bookingRef: notification.bookingRef,
      ...(notification.bookingGroupRef
        ? { bookingGroupRef: notification.bookingGroupRef }
        : {}),
      contextType: notification.contextType,
      ...(notification.receiptVerificationId
        ? { receiptVerificationId: notification.receiptVerificationId }
        : {}),
      ...(notification.fullName ? { fullName: notification.fullName } : {}),
      ...(notification.provider ? { provider: notification.provider } : {}),
      ...(maskedPaymentReference
        ? { paymentReferenceMasked: maskedPaymentReference }
        : {}),
      imageHash: notification.imageHash,
      flags: notification.flags,
      ...(notification.expectedAmount !== undefined
        ? { expectedAmount: notification.expectedAmount }
        : {}),
      ...(notification.extractedAmount !== undefined
        ? { extractedAmount: notification.extractedAmount }
        : {}),
      ...(notification.courtLabel
        ? { courtLabel: notification.courtLabel }
        : {}),
      ...(notification.scheduleLabel
        ? { scheduleLabel: notification.scheduleLabel }
        : {}),
    };

    const insertResult = await options.db
      .from("payment_review_notifications")
      .insert({
        dedupe_key: dedupeKey,
        receipt_verification_id: notification.receiptVerificationId || null,
        booking_ref: notification.bookingRef,
        booking_group_ref: notification.bookingGroupRef || null,
        context_type: notification.contextType,
        image_hash: notification.imageHash,
        payment_provider: notification.provider || null,
        payment_reference_masked: maskedPaymentReference || null,
        recipient_email: recipient,
        payload: safePayload,
        status: "sending",
        attempt_count: 1,
        last_attempt_at: nowIso,
        next_attempt_at: null,
      })
      .select(
        "id,status,attempt_count,provider_message_id,last_attempt_at,next_attempt_at",
      )
      .single();

    let claimedRow: DeliveryRow | null = insertResult.data as
      | DeliveryRow
      | null;
    if (insertResult.error) {
      if (!isUniqueViolation(insertResult.error)) throw insertResult.error;

      const existingResult = await options.db
        .from("payment_review_notifications")
        .select(
          "id,status,attempt_count,provider_message_id,last_attempt_at,next_attempt_at",
        )
        .eq("dedupe_key", dedupeKey)
        .maybeSingle();
      if (existingResult.error) throw existingResult.error;

      const existing = existingResult.data as DeliveryRow | null;
      if (!existing) throw new Error("Existing notification was not found");
      deliveryId = existing.id;

      if (existing.status === "sent") {
        return {
          ok: true,
          sent: false,
          skipped: true,
          reason: "already_sent",
          deliveryId,
          ...(existing.provider_message_id
            ? { providerMessageId: existing.provider_message_id }
            : {}),
        };
      }
      if (isRecentSendingLease(existing)) {
        return {
          ok: true,
          sent: false,
          skipped: true,
          reason: "delivery_in_progress",
          deliveryId,
        };
      }
      if (isInRetryBackoff(existing)) {
        return {
          ok: true,
          sent: false,
          skipped: true,
          reason: "retry_backoff",
          deliveryId,
        };
      }

      const nextAttempt = Number(existing.attempt_count || 0) + 1;
      const claimResult = await options.db
        .from("payment_review_notifications")
        .update({
          status: "sending",
          attempt_count: nextAttempt,
          recipient_email: recipient,
          payload: safePayload,
          error_message: null,
          last_attempt_at: nowIso,
          next_attempt_at: null,
        })
        .eq("id", existing.id)
        .eq("status", existing.status)
        .eq("attempt_count", Number(existing.attempt_count || 0))
        .select(
          "id,status,attempt_count,provider_message_id,last_attempt_at,next_attempt_at",
        )
        .maybeSingle();
      if (claimResult.error) throw claimResult.error;
      if (!claimResult.data) {
        return {
          ok: true,
          sent: false,
          skipped: true,
          reason: "delivery_in_progress",
          deliveryId,
        };
      }
      claimedRow = claimResult.data as DeliveryRow;
    }

    if (!claimedRow?.id) {
      throw new Error("Notification delivery was not claimed");
    }
    deliveryId = claimedRow.id;
    claimedAttempt = Number(claimedRow.attempt_count || 1);

    try {
      const sent = await sendPaymentReviewEmail({
        resendApiKey: options.resendApiKey,
        recipient,
        notification,
        idempotencyKey: dedupeKey,
        fromAddress: options.fromAddress,
        adminUrl: options.adminUrl,
        fetcher: options.fetcher,
      });

      const sentAt = new Date().toISOString();
      const { error: sentUpdateError } = await options.db
        .from("payment_review_notifications")
        .update({
          status: "sent",
          provider_message_id: sent.providerMessageId || null,
          error_message: null,
          sent_at: sentAt,
          next_attempt_at: null,
        })
        .eq("id", deliveryId)
        .eq("status", "sending")
        .eq("attempt_count", claimedAttempt);
      if (sentUpdateError) throw sentUpdateError;

      return {
        ok: true,
        sent: true,
        skipped: false,
        deliveryId,
        ...(sent.providerMessageId
          ? { providerMessageId: sent.providerMessageId }
          : {}),
      };
    } catch (sendError) {
      const failure = errorText(sendError);
      const { error: failedUpdateError } = await options.db
        .from("payment_review_notifications")
        .update({
          status: "failed",
          error_message: failure,
          next_attempt_at: isoAfterMinutes(
            retryDelayMinutes(claimedAttempt),
          ),
        })
        .eq("id", deliveryId)
        .eq("status", "sending")
        .eq("attempt_count", claimedAttempt);
      if (failedUpdateError) {
        console.error(
          "Unable to persist payment-review email failure:",
          errorText(failedUpdateError),
        );
      }

      return {
        ok: false,
        sent: false,
        skipped: false,
        reason: "delivery_failed",
        deliveryId,
      };
    }
  } catch (error) {
    console.error("Payment-review notification error:", errorText(error));
    return {
      ok: false,
      sent: false,
      skipped: false,
      reason: "notification_error",
      ...(deliveryId ? { deliveryId } : {}),
    };
  }
}
