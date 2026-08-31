import {
  createPaymentReviewDeliveryIdempotencyKey,
  escapePaymentReviewHtml,
  maskPaymentReference,
  normalizePaymentReviewEmail,
  sendResendEmail,
  type PaymentReviewEmail,
} from "./payment-review-email.ts";

type BalancePaymentRow = {
  id: string;
  verification_ref: string;
  booking_ref: string;
  booking_group_ref?: string | null;
  booking_refs: string[];
  status: string;
  total_amount: number;
  expected_amount: number;
  payment_provider: string;
  payment_reference: string;
  customer_name: string;
  customer_email?: string | null;
  approved_at?: string | null;
};

type BookingRow = {
  ref: string;
  booking_group_ref?: string | null;
  full_name?: string | null;
  email?: string | null;
  court_name?: string | null;
  date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  duration?: number | null;
  total?: number | null;
  downpayment?: number | null;
  status?: string | null;
  payment_status?: string | null;
  confirmation_email_sent_at?: string | null;
  confirmation_email_last_event?: string | null;
};

export type HostBalanceConfirmationResult = {
  ok: boolean;
  sent?: boolean;
  skipped?: boolean;
  deduplicated?: boolean;
  reason?: string;
  providerMessageId?: string;
  recipient?: string;
};

function money(value: unknown): string {
  const amount = Number(value);
  return `₱${(Number.isFinite(amount) ? amount : 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function displayDate(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw || "—";
  const date = new Date(`${raw}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function cleanBookingRows(rows: unknown): BookingRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is BookingRow =>
    Boolean(row && typeof row === "object" && String((row as BookingRow).ref || "").trim())
  );
}

export function hostBalanceConfirmationEvent(paymentId: unknown): string {
  return `balance_paid:${String(paymentId ?? "").trim().toLowerCase()}`;
}

export function buildHostBalanceConfirmationEmail(
  payment: BalancePaymentRow,
  bookings: BookingRow[],
): PaymentReviewEmail {
  if (String(payment?.status || "").toLowerCase() !== "approved") {
    throw new Error("Only an approved balance payment can be confirmed");
  }
  const rows = cleanBookingRows(bookings);
  if (!rows.length) throw new Error("Approved booking details were not found");

  const bookingRef = String(
    payment.booking_group_ref || rows[0]?.booking_group_ref || payment.booking_ref || "",
  ).trim();
  const customer = String(payment.customer_name || rows[0]?.full_name || "Host").trim();
  const scheduleRows = rows.map((row) => {
    const court = escapePaymentReviewHtml(row.court_name || "Court");
    const date = escapePaymentReviewHtml(displayDate(row.date));
    const time = escapePaymentReviewHtml(
      [row.start_time, row.end_time].filter(Boolean).join(" – ") || "—",
    );
    return `<tr><td style="padding:10px 12px;border-top:1px solid #384033;color:#f7fafc;">${court}</td><td style="padding:10px 12px;border-top:1px solid #384033;color:#d7dee8;">${date}</td><td style="padding:10px 12px;border-top:1px solid #384033;color:#d7dee8;">${time}</td></tr>`;
  }).join("");
  const provider = String(payment.payment_provider || "payment").trim().toUpperCase();
  const maskedReference = maskPaymentReference(payment.payment_reference) || "Recorded";
  const safeCustomer = escapePaymentReviewHtml(customer || "Host");
  const safeBookingRef = escapePaymentReviewHtml(bookingRef);
  const balanceAmount = money(payment.expected_amount);
  const totalAmount = money(payment.total_amount);
  const approvedAt = payment.approved_at
    ? new Date(payment.approved_at).toLocaleString("en-PH", {
      timeZone: "Asia/Manila",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    : "Recorded by KORTE DOS";

  return {
    subject: `Balance Payment Confirmed - ${bookingRef} | KORTE DOS`,
    text: [
      `Hi ${customer || "Host"},`,
      "",
      `We received and approved your remaining balance payment of ${balanceAmount}.`,
      `Booking: ${bookingRef}`,
      `Total paid: ${totalAmount}`,
      `Payment: ${provider} ${maskedReference}`,
      "Status: FULLY PAID",
      "",
      "Your booking is confirmed and no remaining balance is due.",
    ].join("\n"),
    html: `<!doctype html><html><body style="margin:0;background:#15171b;font-family:Segoe UI,Arial,sans-serif;color:#f7fafc;"><table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px;background:#15171b;"><tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#202428;border:1px solid #323840;border-radius:14px;overflow:hidden;"><tr><td style="padding:28px 32px;text-align:center;background:#75330f;border-top:6px solid #f59a38;"><img src="https://kortedoscdo.club/korte-dos-logo.png" width="82" height="82" alt="KORTE DOS" style="display:block;margin:0 auto 12px;border-radius:50%;background:#fff;padding:5px;"><div style="font-size:22px;font-weight:900;letter-spacing:3px;">KORTE DOS</div></td></tr><tr><td style="padding:14px 28px;text-align:center;background:#c95a1c;color:#1d2024;font-weight:900;letter-spacing:1px;">✓ BALANCE PAYMENT CONFIRMED</td></tr><tr><td style="padding:28px 32px;"><p style="margin:0 0 16px;">Hi <strong>${safeCustomer}</strong>,</p><p style="margin:0 0 22px;color:#d7dee8;line-height:1.6;">We received and approved your remaining balance payment of <strong style="color:#f49a4a;">${escapePaymentReviewHtml(balanceAmount)}</strong>. Your booking is now <strong>fully paid</strong>.</p><table width="100%" cellpadding="0" cellspacing="0" style="background:#1d241e;border:1px solid #8b4b20;border-radius:10px;margin-bottom:20px;"><tr><td style="padding:14px 18px;"><div style="font-size:11px;color:#aab6c5;text-transform:uppercase;">Booking reference</div><div style="margin-top:4px;color:#f49a4a;font-size:17px;font-weight:800;">${safeBookingRef}</div></td></tr><tr><td style="padding:14px 18px;border-top:1px solid #384033;"><strong>Total paid:</strong> ${escapePaymentReviewHtml(totalAmount)}<br><strong>Balance payment:</strong> ${escapePaymentReviewHtml(balanceAmount)}<br><strong>Payment:</strong> ${escapePaymentReviewHtml(provider)} · ${escapePaymentReviewHtml(maskedReference)}<br><strong>Approved:</strong> ${escapePaymentReviewHtml(approvedAt)}</td></tr></table><table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;"><tr><td style="padding:8px 12px;color:#aab6c5;font-size:11px;text-transform:uppercase;">Court</td><td style="padding:8px 12px;color:#aab6c5;font-size:11px;text-transform:uppercase;">Date</td><td style="padding:8px 12px;color:#aab6c5;font-size:11px;text-transform:uppercase;">Time</td></tr>${scheduleRows}</table><div style="padding:14px 18px;background:#183528;border:1px solid #2f8158;border-radius:10px;color:#baf3d2;font-weight:800;text-align:center;">FULLY PAID · NO BALANCE DUE</div><p style="margin:22px 0 0;color:#aab6c5;line-height:1.6;">Your reservation remains confirmed. We look forward to seeing you at KORTE DOS!</p></td></tr></table></td></tr></table></body></html>`,
  };
}

export async function deliverHostBalanceConfirmation(options: {
  db: any;
  resendApiKey: string;
  paymentId: string;
  fromAddress?: string;
  fetcher?: typeof fetch;
  recipientOverride?: string;
  recordDelivery?: boolean;
}): Promise<HostBalanceConfirmationResult> {
  const paymentId = String(options.paymentId || "").trim().toLowerCase();
  const { data: payment, error: paymentError } = await options.db
    .from("host_booking_balance_payments")
    .select("id,verification_ref,booking_ref,booking_group_ref,booking_refs,status,total_amount,expected_amount,payment_provider,payment_reference,customer_name,customer_email,approved_at")
    .eq("id", paymentId)
    .maybeSingle();
  if (paymentError) throw paymentError;
  if (!payment) return { ok: false, skipped: true, reason: "Balance payment was not found" };
  if (String(payment.status || "").toLowerCase() !== "approved") {
    return { ok: false, skipped: true, reason: "Balance payment is not approved" };
  }
  const recipient = normalizePaymentReviewEmail(
    options.recipientOverride || payment.customer_email,
  );
  if (!recipient) return { ok: false, skipped: true, reason: "Host email is unavailable" };
  const refs = Array.isArray(payment.booking_refs)
    ? payment.booking_refs.map((value: unknown) => String(value || "").trim()).filter(Boolean)
    : [];
  if (!refs.length) throw new Error("Approved booking references are missing");

  const { data: bookingData, error: bookingError } = await options.db
    .from("bookings")
    .select("ref,booking_group_ref,full_name,email,court_name,date,start_time,end_time,duration,total,downpayment,status,payment_status,confirmation_email_sent_at,confirmation_email_last_event")
    .in("ref", refs);
  if (bookingError) throw bookingError;
  const bookings = cleanBookingRows(bookingData);
  if (bookings.length !== refs.length) throw new Error("Approved booking group is incomplete");
  if (bookings.some((row) => row.payment_status !== "paid")) {
    throw new Error("Booking group is not fully paid");
  }

  const event = hostBalanceConfirmationEvent(paymentId);
  const recordDelivery = options.recordDelivery !== false && !options.recipientOverride;
  if (recordDelivery && bookings.every((row) =>
    row.confirmation_email_last_event === event && row.confirmation_email_sent_at
  )) {
    return { ok: true, skipped: true, deduplicated: true, recipient };
  }

  const email = buildHostBalanceConfirmationEmail(payment, bookings);
  const idempotencyKey = await createPaymentReviewDeliveryIdempotencyKey(
    `${recordDelivery ? "host-balance-confirmation" : "host-balance-confirmation-copy"}:v1:${paymentId}`,
    recipient,
  );
  const sent = await sendResendEmail({
    resendApiKey: options.resendApiKey,
    recipient,
    idempotencyKey,
    fromAddress: options.fromAddress,
    fetcher: options.fetcher,
  }, email);
  if (recordDelivery) {
    const sentAt = new Date().toISOString();
    const { error: updateError } = await options.db
      .from("bookings")
      .update({
        confirmation_email_id: sent.providerMessageId || null,
        confirmation_email_sent_at: sentAt,
        confirmation_email_last_event: event,
      })
      .in("ref", refs);
    if (updateError) throw updateError;
  }

  return {
    ok: true,
    sent: true,
    providerMessageId: sent.providerMessageId,
    recipient,
  };
}
