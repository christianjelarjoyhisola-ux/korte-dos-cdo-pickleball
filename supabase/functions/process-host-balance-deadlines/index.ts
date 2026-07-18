import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMailerooEmail } from "../_shared/maileroo.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };
const BRAND_NAME = Deno.env.get("BRAND_NAME") || "Backyard Pickle";
const APP_BASE_URL =
  (Deno.env.get("APP_BASE_URL") || "https://backyard-pickle.example").replace(
    /\/+$/,
    "",
  );
const LOGO_URL = Deno.env.get("BRAND_LOGO_URL") ||
  `${APP_BASE_URL}/backyardpicklelogo.jpg`;
const SUPPORT_PHONE = Deno.env.get("SUPPORT_PHONE") || "0915 393 4597";
const SUPPORT_PHONE_DIGITS = SUPPORT_PHONE.replace(/\D/g, "");
const SUPPORT_PHONE_HREF = SUPPORT_PHONE_DIGITS.startsWith("0")
  ? `+63${SUPPORT_PHONE_DIGITS.slice(1)}`
  : `+${SUPPORT_PHONE_DIGITS}`;
const FACEBOOK_URL = Deno.env.get("FACEBOOK_URL") ||
  "https://web.facebook.com/profile.php?id=61590034812771";
const DAY_MS = 86_400_000;

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
  forfeited_at: string | null;
  status: string;
  payment_status: string;
};

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}

function php(value: number): string {
  return `&#8369;${
    Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

function phDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00+08:00`));
}

function groupRows(rows: BookingRow[]): BookingRow[][] {
  const groups = new Map<string, BookingRow[]>();
  for (const row of rows) {
    const key = row.booking_group_ref || row.ref;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return [...groups.values()];
}

function summary(rows: BookingRow[]) {
  const first = rows[0];
  const key = first.booking_group_ref || first.ref;
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const paid = rows.reduce((sum, row) => sum + Number(row.downpayment || 0), 0);
  const deadline =
    rows.map((row) => row.balance_due_at).filter(Boolean).sort()[0];
  const courts = [...new Set(rows.map((row) => row.court_name).filter(Boolean))]
    .join(", ");
  const schedules = rows.map((row) =>
    `${dateLabel(row.date)} &middot; ${esc(row.start_time)}&ndash;${
      esc(row.end_time)
    }`
  ).filter((v, i, all) => all.indexOf(v) === i).join("<br>");
  return {
    key,
    ref: first.ref,
    name: first.host_name || first.full_name || "Host",
    email: first.host_email || first.email,
    total,
    paid,
    balance: Math.max(0, total - paid),
    deadline,
    courts,
    schedules,
  };
}

function noticeCopy(eventType: string, balance: number, deadline: string) {
  if (eventType === "forfeited") {
    return {
      subject: "Reservation forfeited - slot released",
      heading: "RESERVATION FORFEITED",
      accent: "#c2413a",
      message:
        `Your reservation was forfeited because the remaining balance of <strong>${
          php(balance)
        }</strong> was not paid by the deadline. The court slot has been released and the payment already made remains non-refundable.`,
    };
  }
  const days = eventType === "reminder_3d"
    ? 3
    : eventType === "reminder_2d"
    ? 2
    : 1;
  return {
    subject: days === 1
      ? "Final balance reminder - 24 hours remaining"
      : `${days} days remaining to settle your balance`,
    heading: days === 1 ? "FINAL BALANCE REMINDER" : `${days} DAYS REMAINING`,
    accent: days === 1 ? "#c2413a" : "#185a9d",
    message: `Your remaining balance of <strong>${
      php(balance)
    }</strong> must be paid by <strong>${esc(phDateTime(deadline))}</strong>. ${
      days === 1
        ? "If payment is not completed within 24 hours, the reservation will be forfeited and the slot will be released."
        : "Please settle the balance before the deadline to keep your reservation."
    }`,
  };
}

function emailHtml(
  info: ReturnType<typeof summary>,
  eventType: string,
): string {
  const copy = noticeCopy(eventType, info.balance, info.deadline);
  return `<!doctype html><html><body style="margin:0;background:#edf3ea;font-family:Arial,sans-serif;color:#102a43">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
  <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#fff;border:1px solid #d6e1d1;border-radius:18px;overflow:hidden;box-shadow:0 14px 40px rgba(11,53,109,.12)">
    <tr><td style="background:#0b356d;padding:24px 30px;text-align:center;border-top:6px solid #91c43c"><img src="${LOGO_URL}" width="72" height="72" alt="${BRAND_NAME}" style="border-radius:18px;background:#fff;padding:4px;border:3px solid #06264f"><div style="color:#fff;font-weight:900;letter-spacing:2px;margin-top:10px">${BRAND_NAME.toUpperCase()}</div></td></tr>
    <tr><td style="height:5px;background:${copy.accent}"></td></tr>
    <tr><td style="padding:30px">
      <div style="font-size:12px;font-weight:900;letter-spacing:1.4px;color:${copy.accent}">${copy.heading}</div>
      <h1 style="font-size:24px;line-height:1.2;margin:8px 0 18px">Open Play court reservation</h1>
      <p style="font-size:15px;line-height:1.65;margin:0 0 20px">Hi <strong>${
    esc(info.name)
  }</strong>,</p>
      <p style="font-size:15px;line-height:1.65;margin:0 0 22px">${copy.message}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f1;border:1px solid #d6e1d1;border-radius:12px">
        <tr><td style="padding:15px 18px;border-bottom:1px solid #d6e1d1"><small style="color:#5f6f7c">Booking reference</small><br><strong>${
    esc(info.key)
  }</strong></td></tr>
        <tr><td style="padding:15px 18px;border-bottom:1px solid #d6e1d1"><small style="color:#5f6f7c">Court and schedule</small><br><strong>${
    esc(info.courts)
  }</strong><br>${info.schedules}</td></tr>
        <tr><td style="padding:15px 18px"><table width="100%"><tr><td><small style="color:#5f6f7c">Paid</small><br><strong>${
    php(info.paid)
  }</strong></td><td><small style="color:#5f6f7c">Remaining balance</small><br><strong style="color:${copy.accent}">${
    php(info.balance)
  }</strong></td></tr></table></td></tr>
      </table>
      ${
    eventType === "forfeited"
      ? ""
      : `<p style="font-size:13px;line-height:1.65;color:#5f6f7c;margin:20px 0 0">All payments are final and non-refundable. To settle the balance or ask for help, call or text <a href="tel:${SUPPORT_PHONE_HREF}" style="color:#0b356d;font-weight:700;text-decoration:none">${
        esc(SUPPORT_PHONE)
      }</a> or message the <a href="${
        esc(FACEBOOK_URL)
      }" style="color:#0b356d;font-weight:700;text-decoration:none">Backyard Pickle Facebook page</a>.</p>`
  }
    </td></tr>
    <tr><td style="background:#e8f0e4;padding:16px 30px;text-align:center;color:#5f6f7c;font-size:12px">Automated account notice from ${BRAND_NAME}</td></tr>
  </table></td></tr></table></body></html>`;
}

async function assertAdmin(req: Request, db: any) {
  const token = (req.headers.get("authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!token) throw new Error("Admin sign-in required");
  const { data: userData } = await db.auth.getUser(token);
  const userId = userData.user?.id;
  if (!userId) throw new Error("Admin sign-in required");
  const { data: accountData } = await db.from("accounts").select("role,status")
    .eq("id", userId).single();
  const account = accountData as { role?: string; status?: string } | null;
  if (
    !account || account.status !== "active" ||
    !["owner", "court_owner", "staff"].includes(String(account.role || ""))
  ) {
    throw new Error("Admin access required");
  }
}

async function sendNotice(
  db: any,
  mailerooKey: string,
  rows: BookingRow[],
  eventType: string,
  force = false,
) {
  const info = summary(rows);
  if (!info.email || !info.deadline || info.balance <= 0) {
    return { skipped: true, reason: "No recipient or balance" };
  }

  const { data: existing } = await db.from("booking_balance_notifications")
    .select("id,status,attempt_count,last_attempt_at").eq(
      "booking_key",
      info.key,
    ).eq("event_type", eventType).maybeSingle();
  if (!force && existing?.status === "sent") {
    return { skipped: true, reason: "Already sent" };
  }
  if (
    !force && existing?.status === "pending" && existing.last_attempt_at &&
    Date.now() - new Date(existing.last_attempt_at).getTime() < 10 * 60_000
  ) {
    return { skipped: true, reason: "Already processing" };
  }

  const attemptCount = Number(existing?.attempt_count || 0) + 1;
  const log = {
    booking_key: info.key,
    booking_ref: info.ref,
    event_type: eventType,
    recipient_email: info.email,
    status: "pending",
    attempt_count: attemptCount,
    last_attempt_at: new Date().toISOString(),
    error_message: null,
  };
  const { data: claimed, error: claimError } = await db.from(
    "booking_balance_notifications",
  )
    .upsert(log, { onConflict: "booking_key,event_type" }).select("id")
    .single();
  if (claimError) throw claimError;

  const copy = noticeCopy(eventType, info.balance, info.deadline);
  try {
    const delivery = await sendMailerooEmail({
      apiKey: mailerooKey,
      from: Deno.env.get("EMAIL_FROM") || "",
      to: info.email,
      subject: `${copy.subject} | ${BRAND_NAME}`,
      html: emailHtml(info, eventType),
      tags: { message_type: eventType, booking_ref: info.ref },
    });
    await db.from("booking_balance_notifications").update({
      status: "sent",
      sent_at: new Date().toISOString(),
      provider_message_id: delivery.referenceId,
    }).eq("id", claimed.id);
    return { sent: true, eventType, bookingKey: info.key };
  } catch (error) {
    await db.from("booking_balance_notifications").update({
      status: "failed",
      error_message: error instanceof Error ? error.message : String(error),
    }).eq("id", claimed.id);
    throw error;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }
  try {
    const url = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const mailerooKey = Deno.env.get("MAILEROO_API_KEY") || "";
    if (!url || !serviceKey || !mailerooKey || !Deno.env.get("EMAIL_FROM")) {
      throw new Error("Balance processor environment is incomplete");
    }
    const db = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
    const body = await req.json().catch(() => ({}));

    if (body.action === "manual") {
      await assertAdmin(req, db);
      const ref = String(body.bookingRef || "");
      const { data: seed } = await db.from("bookings").select(
        "booking_group_ref",
      ).eq("ref", ref).single();
      const key = seed?.booking_group_ref || ref;
      const { data: manualRows, error } = await db.from("bookings").select("*")
        .or(`ref.eq.${key},booking_group_ref.eq.${key}`);
      if (error || !manualRows?.length) {
        throw error || new Error("Booking not found");
      }
      const eventType = manualRows.some((row: BookingRow) =>
          row.status === "forfeited"
        )
        ? "forfeited"
        : String(body.eventType || "reminder_1d");
      const result = await sendNotice(
        db,
        mailerooKey,
        manualRows as BookingRow[],
        eventType,
        true,
      );
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: JSON_HEADERS,
      });
    }

    const { data, error } = await db.from("bookings").select("*")
      .eq("host_booking", true).eq("status", "confirmed").eq(
        "payment_status",
        "downpayment_paid",
      )
      .not("balance_due_at", "is", null);
    if (error) throw error;

    const results = [];
    const now = Date.now();
    for (const rows of groupRows((data || []) as BookingRow[])) {
      const info = summary(rows);
      const remaining = new Date(info.deadline).getTime() - now;
      if (remaining <= 0) {
        const { data: forfeiture, error: forfeitError } = await db.rpc(
          "forfeit_overdue_host_booking",
          { p_booking_key: info.key },
        );
        if (forfeitError) throw forfeitError;
        if (Number(forfeiture?.changed || 0) > 0) {
          results.push(await sendNotice(db, mailerooKey, rows, "forfeited"));
        }
      } else if (remaining <= DAY_MS) {
        results.push(await sendNotice(db, mailerooKey, rows, "reminder_1d"));
      } else if (remaining <= 2 * DAY_MS) {
        results.push(await sendNotice(db, mailerooKey, rows, "reminder_2d"));
      } else if (remaining <= 3 * DAY_MS) {
        results.push(await sendNotice(db, mailerooKey, rows, "reminder_3d"));
      }
    }

    // A status change must not suppress a forfeiture email retry. Failed logs
    // are retried on the next cron pass; sent logs remain idempotent.
    const { data: forfeitedData, error: forfeitedError } = await db.from(
      "bookings",
    ).select("*")
      .eq("host_booking", true).eq("status", "forfeited").eq(
        "payment_status",
        "deposit_retained",
      )
      .not("balance_due_at", "is", null);
    if (forfeitedError) throw forfeitedError;
    for (const rows of groupRows((forfeitedData || []) as BookingRow[])) {
      results.push(await sendNotice(db, mailerooKey, rows, "forfeited"));
    }
    return new Response(
      JSON.stringify({ ok: true, processed: results.length, results }),
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
});
