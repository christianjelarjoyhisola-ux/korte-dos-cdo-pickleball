export type TelegramAlertEvent =
  | "new_booking"
  | "payment_review_needed"
  | "balance_payment_review_needed";

export type AuthoritativeTelegramAlert = {
  eventKey: string;
  message: string;
  payloadDigest: string;
  bookingRef: string;
};

type BookingRow = Record<string, unknown>;

export const LIVE_TELEGRAM_ADMIN_URL = "https://kortedoscdo.club/admin";

const TERMINAL_BOOKING_STATUSES = new Set([
  "cancelled",
  "completed",
  "forfeited",
]);

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function lower(value: unknown): string {
  return text(value).toLowerCase();
}

function amount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter(Boolean);
}

export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isRecord(value: unknown): value is BookingRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeTelegramAlertEvent(
  body: unknown,
): TelegramAlertEvent | null {
  if (!isRecord(body)) return null;
  const type = lower(body.type);
  const event = lower(body.event);
  if (event === "balance_payment_review_needed") {
    return !type || type === "host_booking_balance" ? event : null;
  }
  if (type && type !== "booking" && type !== "booking_update") return null;
  if (event === "new_booking" || event === "payment_review_needed") {
    return event;
  }
  return null;
}

function normalizedBookingRows(rows: unknown): BookingRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(isRecord)
    .filter((row) => !TERMINAL_BOOKING_STATUSES.has(lower(row.status)))
    .sort((left, right) => {
      const leftKey = [
        text(left.date),
        text(left.start_time),
        text(left.court_name),
        text(left.ref),
      ].join("|");
      const rightKey = [
        text(right.date),
        text(right.start_time),
        text(right.court_name),
        text(right.ref),
      ].join("|");
      return leftKey.localeCompare(rightKey);
    });
}

function authoritativeIdentity(rows: BookingRow[]): string {
  const identities = new Set(
    rows.map((row) => text(row.booking_group_ref) || text(row.ref)),
  );
  if (identities.size !== 1) return "";
  const identity = [...identities][0];
  return /^[A-Za-z0-9_-]{3,128}$/.test(identity) ? identity : "";
}

function validBookingRow(row: BookingRow): boolean {
  return /^[A-Za-z0-9_-]{3,128}$/.test(text(row.ref)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(text(row.date)) &&
    Boolean(text(row.full_name)) &&
    lower(row.status) === "pending";
}

function validReviewEvidence(row: BookingRow): boolean {
  const receiptStatus = lower(row.receipt_status);
  return lower(row.payment_status) === "for_verification" &&
    (receiptStatus === "manual_review" || receiptStatus === "rejected") &&
    Boolean(text(row.receipt_image_url)) &&
    /^[a-f0-9]{64}$/i.test(text(row.receipt_image_hash));
}

function paymentMethodLabel(value: unknown): string {
  const method = lower(value);
  const labels: Record<string, string> = {
    gcash: "GCash",
    bdopay: "BDO Pay",
    maya: "Maya",
    bpi: "BPI",
    maribank: "MariBank",
    gotyme: "GoTyme to GCash",
    pnb: "PNB",
    cash: "Cash",
  };
  return labels[method] || (text(value) || "Not specified");
}

function php(value: number): string {
  return `₱${value.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function bookingDate(value: unknown): string {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw || "Date unavailable";
  const date = new Date(`${raw}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function scheduleLine(row: BookingRow): string {
  const court = text(row.court_name) || text(row.court_id) || "Court";
  const start = text(row.start_time);
  const end = text(row.end_time);
  const time = start && end ? `${start} - ${end}` : start || end;
  return [
    `<b>${escapeTelegramHtml(court)}</b>`,
    escapeTelegramHtml(bookingDate(row.date)),
    time ? escapeTelegramHtml(time) : "",
  ].filter(Boolean).join(" | ");
}

function safeAdminReviewUrl(baseUrl: string, bookingRef: string): string {
  const liveAdmin = new URL(LIVE_TELEGRAM_ADMIN_URL);
  try {
    const configured = new URL(baseUrl);
    if (configured.origin !== liveAdmin.origin) {
      throw new Error("Only the live admin origin is allowed");
    }
  } catch {
    // Ignore stale Pages previews and invalid environment overrides.
  }
  liveAdmin.searchParams.set("section", "payreview");
  liveAdmin.searchParams.set("review", bookingRef);
  return liveAdmin.toString();
}

function canonicalRows(rows: BookingRow[]): string {
  return JSON.stringify(rows.map((row) => ({
    ref: text(row.ref),
    groupRef: text(row.booking_group_ref),
    fullName: text(row.full_name),
    contactNumber: text(row.contact_number),
    courtId: text(row.court_id),
    courtName: text(row.court_name),
    date: text(row.date),
    slots: stringArray(row.slots).sort(),
    startTime: text(row.start_time),
    endTime: text(row.end_time),
    duration: amount(row.duration),
    total: amount(row.total),
    downpayment: amount(row.downpayment),
    paymentMethod: lower(row.payment_method),
    paymentStatus: lower(row.payment_status),
    paymentProvider: lower(row.payment_provider),
    paymentReference: text(row.gcash_ref),
    status: lower(row.status),
    receiptStatus: lower(row.receipt_status),
    receiptHash: lower(row.receipt_image_hash),
    receiptFlags: stringArray(row.receipt_flags).sort(),
  })));
}

function messageForAlert(
  rows: BookingRow[],
  event: TelegramAlertEvent,
  bookingRef: string,
  adminUrl: string,
): string {
  const first = rows[0];
  const total = rows.reduce((sum, row) => sum + amount(row.total), 0);
  const submitted = rows.reduce(
    (sum, row) => sum + amount(row.downpayment),
    0,
  );
  const schedule = rows.map(scheduleLine).join("\n");
  const paymentReference = text(first.gcash_ref);
  const flags = [...new Set(
    rows.flatMap((row) => stringArray(row.receipt_flags)),
  )].slice(0, 8);
  const reviewUrl = safeAdminReviewUrl(adminUrl, bookingRef);
  const title = event === "payment_review_needed"
    ? "PAYMENT NEEDS VERIFICATION"
    : "PENDING BOOKING — VERIFY";

  return [
    `<b>${title}</b>`,
    "------------------",
    `<b>${escapeTelegramHtml(first.full_name)}</b>`,
    text(first.contact_number)
      ? escapeTelegramHtml(first.contact_number)
      : "",
    "",
    schedule,
    "",
    `Payment: <b>${
      escapeTelegramHtml(paymentMethodLabel(first.payment_method))
    }</b>`,
    paymentReference
      ? `Payment ref: <code>${escapeTelegramHtml(paymentReference)}</code>`
      : "",
    `Total: ${php(total)}`,
    `Submitted: <b>${php(submitted)}</b>`,
    flags.length
      ? `Review flags: <code>${escapeTelegramHtml(flags.join(", "))}</code>`
      : "",
    "",
    `Booking ref: <code>${escapeTelegramHtml(bookingRef)}</code>`,
    "------------------",
    `<a href="${escapeTelegramHtml(reviewUrl)}">Open admin panel to verify.</a>`,
  ].filter((line, index, all) => {
    if (line !== "") return true;
    return index > 0 && all[index - 1] !== "";
  }).join("\n");
}

export async function buildAuthoritativeTelegramAlert(
  sourceRows: unknown,
  event: TelegramAlertEvent,
  adminUrl: string,
): Promise<AuthoritativeTelegramAlert | null> {
  const rows = normalizedBookingRows(sourceRows);
  if (!rows.length || rows.some((row) => !validBookingRow(row))) return null;

  const identity = authoritativeIdentity(rows);
  if (!identity) return null;

  if (
    event === "new_booking" &&
    rows.some((row) =>
      lower(row.payment_status) === "for_verification" ||
      ["manual_review", "rejected"].includes(lower(row.receipt_status))
    )
  ) {
    return null;
  }

  if (
    event === "payment_review_needed" &&
    rows.some((row) => !validReviewEvidence(row))
  ) {
    return null;
  }

  const bookingRef = text(rows[0].ref);
  const canonical = `${event}\n${canonicalRows(rows)}`;
  const payloadDigest = await sha256Hex(canonical);
  const eventKey = event === "new_booking"
    ? `telegram:pending-booking:v1:${identity}`
    : `telegram:payment-review:v1:${identity}:${
      await sha256Hex(
        [...new Set(rows.map((row) => lower(row.receipt_image_hash)))]
          .sort()
          .join("|"),
      )
    }`;

  return {
    eventKey,
    message: messageForAlert(rows, event, bookingRef, adminUrl),
    payloadDigest,
    bookingRef,
  };
}

function maskedPaymentReference(value: unknown): string {
  const cleaned = text(value).replace(/\s+/g, "");
  if (!cleaned) return "";
  return `••••${cleaned.slice(-4)}`;
}

export async function buildAuthoritativeTelegramBalanceAlert(
  source: unknown,
  adminUrl: string,
): Promise<AuthoritativeTelegramAlert | null> {
  if (!isRecord(source)) return null;
  const verificationRef = text(source.verification_ref);
  const paymentId = text(source.id);
  const imageHash = lower(source.receipt_image_hash);
  const receiptVerificationId = Number(source.receipt_verification_id);
  const expectedAmount = amount(source.expected_amount);
  if (
    lower(source.status) !== "pending_review" ||
    !/^HBAL-[A-F0-9]{32}$/i.test(verificationRef) ||
    !/^[0-9a-f-]{36}$/i.test(paymentId) ||
    !/^[a-f0-9]{64}$/.test(imageHash) ||
    !Number.isSafeInteger(receiptVerificationId) ||
    receiptVerificationId <= 0 ||
    expectedAmount <= 0
  ) return null;

  const flags = [...new Set(stringArray(source.receipt_flags))].slice(0, 8);
  const paymentReference = maskedPaymentReference(source.payment_reference);
  const reviewUrl = safeAdminReviewUrl(adminUrl, verificationRef);
  const message = [
    "<b>BALANCE PAYMENT NEEDS REVIEW</b>",
    "------------------",
    `<b>${escapeTelegramHtml(text(source.customer_name) || "Host customer")}</b>`,
    `Booking: <code>${escapeTelegramHtml(text(source.booking_group_ref) || text(source.booking_key) || text(source.booking_ref))}</code>`,
    text(source.schedule_label)
      ? `Schedule: ${escapeTelegramHtml(source.schedule_label)}`
      : "",
    text(source.court_label)
      ? `Court: ${escapeTelegramHtml(source.court_label)}`
      : "",
    "",
    `Payment: <b>${escapeTelegramHtml(paymentMethodLabel(source.payment_provider))}</b>`,
    paymentReference
      ? `Payment ref: <code>${escapeTelegramHtml(paymentReference)}</code>`
      : "",
    `Booking total: ${php(amount(source.total_amount))}`,
    `Deposit verified: ${php(amount(source.original_paid_amount))}`,
    `Balance submitted: <b>${php(expectedAmount)}</b>`,
    flags.length
      ? `Review flags: <code>${escapeTelegramHtml(flags.join(", "))}</code>`
      : "",
    "",
    `Review ref: <code>${escapeTelegramHtml(verificationRef)}</code>`,
    "------------------",
    `<a href="${escapeTelegramHtml(reviewUrl)}">Open the balance receipt to review.</a>`,
  ].filter((line, index, all) => {
    if (line !== "") return true;
    return index > 0 && all[index - 1] !== "";
  }).join("\n");
  const canonical = JSON.stringify({
    id: paymentId,
    verificationRef,
    status: lower(source.status),
    bookingKey: text(source.booking_key),
    expectedAmount,
    provider: lower(source.payment_provider),
    reference: text(source.payment_reference),
    receiptVerificationId,
    imageHash,
    flags: [...flags].sort(),
  });
  return {
    eventKey: `telegram:balance-payment-review:v1:${paymentId}:${imageHash}`,
    message,
    payloadDigest: await sha256Hex(canonical),
    bookingRef: verificationRef,
  };
}
