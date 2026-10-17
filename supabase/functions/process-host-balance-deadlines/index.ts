import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { paymentReviewWorkerSecretsMatch, PAYMENT_REVIEW_NOTIFICATION_WORKER_SETTING_KEY } from "../_shared/payment-review-worker.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };
const LOGO_URL = "https://kortedoscdo.club/korte-dos-logo.png";
const BOOKING_FIELDS = "ref,booking_group_ref,full_name,email,host_name,host_email,court_name,date,start_time,end_time,total,downpayment,balance_due_at,status,payment_status";

type BookingRow = {
  ref: string;
  booking_group_ref: string | null;
  full_name: string;
  email: string;
  host_name: string | null;
  host_email: string | null;
  court_name: string;
  date: string;
  start_time: string;
  end_time: string;
  total: number;
  downpayment: number;
  balance_due_at: string;
  status: string;
  payment_status: string;
};

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch] || ch));
}

function php(value: number): string {
  return `&#8369;${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function phDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila", weekday: "long", month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(value));
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", year: "numeric",
  }).format(new Date(`${value}T00:00:00+08:00`));
}

function summary(rows: BookingRow[]) {
  const first = rows[0];
  const key = first.booking_group_ref || first.ref;
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const paid = rows.reduce((sum, row) => sum + Number(row.downpayment || 0), 0);
  const deadline = rows.map((row) => row.balance_due_at).filter(Boolean).sort()[0];
  const courts = [...new Set(rows.map((row) => row.court_name).filter(Boolean))].join(", ");
  const schedules = rows.map((row) => `${dateLabel(row.date)} &middot; ${esc(row.start_time)}&ndash;${esc(row.end_time)}`).filter((v, i, all) => all.indexOf(v) === i).join("<br>");
  return {
    key, ref: first.ref, name: first.host_name || first.full_name || "Host",
    email: first.host_email || first.email, total, paid, balance: Math.max(0, total - paid),
    deadline, courts, schedules,
  };
}

function noticeCopy(eventType: string, balance: number, deadline: string) {
  if (eventType === "forfeited") return {
    subject: "Reservation forfeited - slot released",
    heading: "RESERVATION FORFEITED",
    accent: "#c83d26",
    message: `Your reservation was forfeited because the remaining balance of <strong>${php(balance)}</strong> was not paid by the deadline. The court slot has been released and the payment already made remains non-refundable.`,
  };
  const days = eventType === "reminder_3d" ? 3 : eventType === "reminder_2d" ? 2 : 1;
  return {
    subject: days === 1 ? "Final balance reminder - 24 hours remaining" : `${days} days remaining to settle your balance`,
    heading: days === 1 ? "FINAL BALANCE REMINDER" : `${days} DAYS REMAINING`,
    accent: days === 1 ? "#c83d26" : "#b7791f",
    message: `Your remaining balance of <strong>${php(balance)}</strong> must be paid by <strong>${esc(phDateTime(deadline))}</strong>. ${days === 1 ? "If payment is not completed within 24 hours, the reservation will be forfeited and the slot will be released." : "Please settle the balance before the deadline to keep your reservation."}`,
  };
}

function emailHtml(info: ReturnType<typeof summary>, eventType: string): string {
  const copy = noticeCopy(eventType, info.balance, info.deadline);
  return `<!doctype html><html><body style="margin:0;background:#eef3f6;font-family:Arial,sans-serif;color:#0f2438">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
  <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#fff;border:1px solid #d7e0e6;border-radius:18px;overflow:hidden;box-shadow:0 14px 40px rgba(20,61,99,.12)">
    <tr><td style="background:#0b2744;padding:24px 30px;text-align:center"><img src="${LOGO_URL}" width="72" height="72" alt="Korte DOS" style="border-radius:50%;background:#fff;padding:4px"><div style="color:#fff;font-weight:900;letter-spacing:2px;margin-top:10px">KORTE DOS</div></td></tr>
    <tr><td style="height:5px;background:${copy.accent}"></td></tr>
    <tr><td style="padding:30px">
      <div style="font-size:12px;font-weight:900;letter-spacing:1.4px;color:${copy.accent}">${copy.heading}</div>
      <h1 style="font-size:24px;line-height:1.2;margin:8px 0 18px">Open Play court reservation</h1>
      <p style="font-size:15px;line-height:1.65;margin:0 0 20px">Hi <strong>${esc(info.name)}</strong>,</p>
      <p style="font-size:15px;line-height:1.65;margin:0 0 22px">${copy.message}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f8;border:1px solid #d7e0e6;border-radius:12px">
        <tr><td style="padding:15px 18px;border-bottom:1px solid #d7e0e6"><small style="color:#657486">Booking reference</small><br><strong>${esc(info.key)}</strong></td></tr>
        <tr><td style="padding:15px 18px;border-bottom:1px solid #d7e0e6"><small style="color:#657486">Court and schedule</small><br><strong>${esc(info.courts)}</strong><br>${info.schedules}</td></tr>
        <tr><td style="padding:15px 18px"><table width="100%"><tr><td><small style="color:#657486">Paid</small><br><strong>${php(info.paid)}</strong></td><td><small style="color:#657486">Remaining balance</small><br><strong style="color:${copy.accent}">${php(info.balance)}</strong></td></tr></table></td></tr>
      </table>
      ${eventType === "forfeited" ? "" : `<p style="font-size:13px;line-height:1.6;color:#657486;margin:20px 0 0">All payments are final and non-refundable. Contact Korte DOS or follow your original payment instructions to settle the balance.</p>`}
    </td></tr>
    <tr><td style="background:#eaf0f3;padding:16px 30px;text-align:center;color:#657486;font-size:12px">Automated account notice from Korte DOS</td></tr>
  </table></td></tr></table></body></html>`;
}

async function assertAdmin(req: Request, db: any) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Admin sign-in required");
  const { data: userData } = await db.auth.getUser(token);
  const userId = userData.user?.id;
  if (!userId) throw new Error("Admin sign-in required");
  const { data: accountData } = await db.from("accounts").select("role,status").eq("id", userId).single();
  const account = accountData as { role?: string; status?: string } | null;
  if (!account || account.status !== "active" || !["owner", "court_owner", "staff"].includes(String(account.role || ""))) {
    throw new Error("Admin access required");
  }
}

async function sendNotice(db: any, resendKey: string, rows: BookingRow[], eventType: string, force = false,
  fetcher: typeof fetch = fetch, fromAddress = "KORTE DOS <onboarding@resend.dev>") {
  const info = summary(rows);
  if (!info.email || !info.deadline || info.balance <= 0) return { skipped: true, reason: "No recipient or balance" };

  const { data: claims, error: claimError } = await db.rpc("claim_host_balance_notification", {
    p_booking_key: info.key, p_booking_ref: info.ref, p_event_type: eventType,
    p_recipient_email: info.email, p_force: force,
  });
  if (claimError) throw claimError;
  const claimed = claims?.[0];
  if (!claimed) return { skipped: true, reason: "Already sent or processing" };

  const updateClaim = (values: Record<string, unknown>) => db.from("booking_balance_notifications").update(values)
    .eq("id", claimed.id).eq("attempt_count", claimed.attempt_count).eq("delivery_id", claimed.delivery_id).eq("status", "pending");

  const copy = noticeCopy(eventType, info.balance, info.deadline);
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json",
        "Idempotency-Key": `host-balance:${claimed.delivery_id}` },
      body: JSON.stringify({
        from: fromAddress,
        to: [info.email], subject: `${copy.subject} | KORTE DOS`, html: emailHtml(info, eventType),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Email provider rejected notice (${response.status})`);
    const saved = await updateClaim({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: result.id || null });
    if (saved.error) throw saved.error;
    return { sent: true, eventType, bookingKey: info.key };
  } catch (error) {
    await updateClaim({ status: "failed", error_message: error instanceof Error ? error.message.slice(0, 500) : "Notice delivery failed" });
    throw error;
  }
}

export async function handle(req: Request, db: any, env = (key: string) => Deno.env.get(key), fetcher: typeof fetch = fetch) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  try {
    const raw = await req.text();
    if (raw.length > 4096) return new Response(JSON.stringify({ ok: false, error: "Request too large" }), { status: 413, headers: JSON_HEADERS });
    let body;
    try { body = JSON.parse(raw); } catch { return new Response(JSON.stringify({ ok: false, error: "Invalid request" }), { status: 400, headers: JSON_HEADERS }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return new Response(JSON.stringify({ ok: false, error: "Invalid request" }), { status: 400, headers: JSON_HEADERS });
    const resendKey = env("RESEND_API_KEY") || "";
    const fromAddress = env("EMAIL_FROM") || "KORTE DOS <onboarding@resend.dev>";

    if (body.action === "manual") {
      await assertAdmin(req, db);
      if (!resendKey) throw new Error("Balance processor environment is incomplete");
      const ref = String(body.bookingRef || "");
      const { data: seed, error: seedError } = await db.from("bookings").select("booking_group_ref").eq("ref", ref).single();
      if (seedError || !seed) throw seedError || new Error("Booking not found");
      const query = db.from("bookings").select(BOOKING_FIELDS);
      const { data: manualRows, error } = await (seed.booking_group_ref ? query.eq("booking_group_ref", seed.booking_group_ref) : query.eq("ref", ref)).order("ref");
      if (error || !manualRows?.length) throw error || new Error("Booking not found");
      const eventType = manualRows.some((row: BookingRow) => row.status === "forfeited") ? "forfeited" : String(body.eventType || "reminder_1d");
      if (!["reminder_3d", "reminder_2d", "reminder_1d", "forfeited", "manual"].includes(eventType)) throw new Error("Invalid notice type");
      const result = await sendNotice(db, resendKey, manualRows as BookingRow[], eventType, true, fetcher, fromAddress);
      return new Response(JSON.stringify({ ok: true, result }), { headers: JSON_HEADERS });
    }

    const { data: setting, error: settingError } = await db.from("private_settings").select("value")
      .eq("key", PAYMENT_REVIEW_NOTIFICATION_WORKER_SETTING_KEY).maybeSingle();
    if (settingError) throw settingError;
    if (!paymentReviewWorkerSecretsMatch(req.headers.get("x-payment-review-worker-secret"), setting?.value)) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
    }
    if (!resendKey) throw new Error("Balance processor environment is incomplete");
    const { data, error } = await db.rpc("due_host_balance_notification_groups", { p_limit: 100 });
    if (error) throw error;

    let sent = 0, skipped = 0, failed = 0;
    for (const group of data || []) {
      let stage = group.needs_forfeiture ? "forfeiture" : "notice";
      try {
        if (group.needs_forfeiture) {
          const { data: forfeiture, error: forfeitError } = await db.rpc("forfeit_overdue_host_booking", { p_booking_key: group.booking_key });
          if (forfeitError) throw forfeitError;
          // The authoritative mutation rechecks payment/review state under
          // locks. A concurrently settled or protected group sends no notice.
          if (Number(forfeiture?.changed || 0) === 0) { skipped++; continue; }
        }
        stage = "notice";
        const result = await sendNotice(db, resendKey, group.bookings, group.event_type, false, fetcher, fromAddress);
        if (result.sent) sent++; else skipped++;
      } catch (error) {
        failed++;
        // Retain useful failure diagnostics without logging a host, reference,
        // receipt, recipient, provider response, or rendered email.
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        const providerStatus = error instanceof Error ? error.message.match(/^Email provider rejected notice \((\d{3})\)$/)?.[1] : null;
        console.error("Host balance processing failed", { stage,
          code: /^[A-Z0-9_]{1,20}$/.test(code) ? code : providerStatus ? `HTTP_${providerStatus}` : "DELIVERY_OR_DATABASE_ERROR" });
      }
    }
    return new Response(JSON.stringify({ ok: failed === 0, processed: sent + skipped + failed, sent, skipped, failed }), { status: failed ? 207 : 200, headers: JSON_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 500, headers: JSON_HEADERS });
  }
}

if (import.meta.main) Deno.serve(req => handle(req, createClient(
  Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  { auth: { persistSession: false } },
)));
