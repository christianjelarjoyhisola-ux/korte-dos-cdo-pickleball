import { sendMailerooEmail } from "../_shared/maileroo.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BRAND_NAME = Deno.env.get("BRAND_NAME") || "Backyard Pickle";
const VENUE_LOCATION = Deno.env.get("VENUE_LOCATION") ||
  "Your local pickleball court";
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

type Payload = {
  bookingRef: string;
  email: string;
  fullName: string;
  courtName: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  total: number;
  downpayment: number;
  hostBooking?: boolean;
  balanceDueAt?: string | null;
  remainingBalance?: number;
  contactNumber?: string;
  bookingItems?: Array<{
    courtName: string;
    date: string;
    startTime: string;
    endTime: string;
    duration: number;
    total: number;
    downpayment?: number;
  }>;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-PH", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function fmtPHP(n: number): string {
  return "&#8369;" +
    Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2 });
}

function fmtDeadline(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function buildHtml(p: Payload): string {
  const fullName = escapeHtml(p.fullName);
  const bookingRef = escapeHtml(p.bookingRef);
  const bookingItems =
    Array.isArray(p.bookingItems) && p.bookingItems.length > 0
      ? p.bookingItems
      : [{
        courtName: p.courtName,
        date: p.date,
        startTime: p.startTime,
        endTime: p.endTime,
        duration: p.duration,
        total: p.total,
        downpayment: p.downpayment,
      }];
  const courtName = escapeHtml(
    [...new Set(bookingItems.map((item) => item.courtName).filter(Boolean))]
      .join(", ") || p.courtName,
  );
  const dates = [
    ...new Set(bookingItems.map((item) => item.date).filter(Boolean)),
  ];
  const dateText = dates.length === 1
    ? fmtDate(dates[0])
    : dates.map(fmtDate).join("<br/>");
  const timeRows = bookingItems.map((item) =>
    `${escapeHtml(item.courtName)}: ${escapeHtml(item.startTime)} &ndash; ${
      escapeHtml(item.endTime)
    }`
  ).join("<br/>");
  const duration =
    bookingItems.reduce((sum, item) => sum + Number(item.duration || 0), 0) ||
    Number(p.duration || 0);
  const itemRows = bookingItems.length > 1
    ? bookingItems.map((item) => `
          <tr>
            <td style="padding:10px 12px;border-top:1px solid #244a67;color:#f6faf3;font-weight:700;">${
      escapeHtml(item.courtName)
    }</td>
            <td style="padding:10px 12px;border-top:1px solid #244a67;color:#d5e2e9;">${
      fmtDate(item.date)
    }</td>
            <td style="padding:10px 12px;border-top:1px solid #244a67;color:#d5e2e9;">${
      escapeHtml(item.startTime)
    } &ndash; ${escapeHtml(item.endTime)}</td>
            <td style="padding:10px 12px;border-top:1px solid #244a67;color:#f6faf3;font-weight:700;text-align:right;">${
      fmtPHP(Number(item.total || 0))
    }</td>
          </tr>`).join("")
    : "";
  const isFullPay = Number(p.downpayment || 0) >= Number(p.total || 0) - 1;
  const balance = Number(p.total || 0) - Number(p.downpayment || 0);
  const hostBalanceDeadline = p.hostBooking && !isFullPay
    ? fmtDeadline(p.balanceDueAt)
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta name="color-scheme" content="dark"/>
<meta name="supported-color-schemes" content="dark"/>
<title>Booking Confirmed - ${BRAND_NAME}</title>
</head>
<body style="margin:0;padding:0;background:#071b30;background-image:linear-gradient(#071b30,#071b30);font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#071b30;background-image:linear-gradient(#071b30,#071b30);padding:32px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#0e2a45;background-image:linear-gradient(#0e2a45,#0e2a45);border:1px solid #244a67;border-radius:14px;overflow:hidden;box-shadow:0 12px 34px rgba(0,0,0,.42);max-width:560px;width:100%;">

      <tr><td style="background:#0b356d;background-image:linear-gradient(#0b356d,#0b356d);padding:34px 36px 30px;text-align:center;border-top:6px solid #91c43c;border-bottom:1px solid #185a9d;">
        <img src="${LOGO_URL}" width="96" height="96" alt="${BRAND_NAME} logo" style="display:block;width:96px;height:96px;margin:0 auto 14px;border-radius:24px;background:#fff;padding:6px;border:4px solid #06264f;"/>
        <div style="font-family:'Bebas Neue',Georgia,serif;font-size:1.6rem;letter-spacing:3px;color:#f6faf3;line-height:1.1;font-weight:900;">${BRAND_NAME.toUpperCase()}</div>
        <div style="font-size:.75rem;color:#b6c9d6;letter-spacing:2px;text-transform:uppercase;margin-top:4px;font-weight:700;">${VENUE_LOCATION}</div>
      </td></tr>

      <tr><td style="background:#4f7f25;background-image:linear-gradient(#4f7f25,#4f7f25);padding:14px 36px;text-align:center;">
        <div style="color:#fff;font-size:1rem;font-weight:900;letter-spacing:1px;">&#10003; BOOKING CONFIRMED</div>
      </td></tr>

      <tr><td style="padding:32px 36px;background:#0e2a45;background-image:linear-gradient(#0e2a45,#0e2a45);">
        <p style="margin:0 0 20px;font-size:1rem;color:#f6faf3;">Hi <strong>${fullName}</strong>,</p>
        <p style="margin:0 0 24px;font-size:.95rem;color:#d5e2e9;line-height:1.6;">
          Great news! Your ${BRAND_NAME} booking has been <strong style="color:#b8de73;">confirmed</strong>.
          ${
    isFullPay
      ? "Your full payment has been received and your slot is locked in."
      : "Your downpayment has been received and your slot is locked in."
  } See you on the court!
        </p>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a2239;background-image:linear-gradient(#0a2239,#0a2239);border:1.5px solid #4f7f25;border-radius:10px;margin-bottom:24px;">
          <tr><td style="padding:18px 22px;border-bottom:1px solid #244a67;">
            <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#9fb3c4;margin-bottom:4px;">Booking Reference</div>
            <div style="font-size:1.1rem;font-weight:800;color:#b8de73;font-family:monospace;letter-spacing:1px;">${bookingRef}</div>
          </td></tr>
          <tr><td style="padding:14px 22px;border-bottom:1px solid #244a67;">
            <table width="100%"><tr>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#9fb3c4;margin-bottom:3px;">Court</div>
                <div style="font-size:.92rem;font-weight:700;color:#f6faf3;">${courtName}</div>
              </td>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#9fb3c4;margin-bottom:3px;">Date</div>
                <div style="font-size:.92rem;font-weight:700;color:#f6faf3;">${dateText}</div>
              </td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:14px 22px;border-bottom:1px solid #244a67;">
            <table width="100%"><tr>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#9fb3c4;margin-bottom:3px;">Time</div>
                <div style="font-size:.92rem;font-weight:700;color:#f6faf3;">${timeRows}</div>
              </td>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#9fb3c4;margin-bottom:3px;">Duration</div>
                <div style="font-size:.92rem;font-weight:700;color:#f6faf3;">${duration} hour${
    duration !== 1 ? "s" : ""
  }</div>
              </td>
            </tr></table>
          </td></tr>
          ${
    itemRows
      ? `<tr><td style="padding:0 10px 10px;border-bottom:1px solid #244a67;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:10px 12px;color:#9fb3c4;font-size:.68rem;text-transform:uppercase;letter-spacing:1px;">Court</td>
                <td style="padding:10px 12px;color:#9fb3c4;font-size:.68rem;text-transform:uppercase;letter-spacing:1px;">Date</td>
                <td style="padding:10px 12px;color:#9fb3c4;font-size:.68rem;text-transform:uppercase;letter-spacing:1px;">Time</td>
                <td style="padding:10px 12px;color:#9fb3c4;font-size:.68rem;text-transform:uppercase;letter-spacing:1px;text-align:right;">Amount</td>
              </tr>
              ${itemRows}
            </table>
          </td></tr>`
      : ""
  }
          <tr><td style="padding:14px 22px;">
            <table width="100%"><tr>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#9fb3c4;margin-bottom:3px;">Total Amount</div>
                <div style="font-size:1.05rem;font-weight:800;color:#f6faf3;">${
    fmtPHP(p.total)
  }</div>
              </td>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#9fb3c4;margin-bottom:3px;">${
    isFullPay ? "Full Payment" : "Downpayment Paid"
  }</div>
                <div style="font-size:1.05rem;font-weight:800;color:#b8de73;">&#10003; ${
    fmtPHP(p.downpayment)
  }</div>
              </td>
            </tr></table>
          </td></tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#142c24;background-image:linear-gradient(#142c24,#142c24);border:1.5px solid #4f7f25;border-radius:10px;margin-bottom:24px;">
          <tr><td style="padding:14px 18px;">
            <div style="font-size:.82rem;color:#ddebd1;line-height:1.6;">
              <strong>&#128203; Reminders:</strong><br/>
              &bull; Please arrive <strong>10 minutes early</strong> to warm up.<br/>
              &bull; Bring your booking reference: <strong>${bookingRef}</strong><br/>
              ${
    isFullPay
      ? '&bull; No remaining balance &mdash; you\'re all paid up! <strong style="color:#b8de73;">&#10003;</strong>'
      : hostBalanceDeadline
      ? `&bull; Remaining balance of <strong>${
        fmtPHP(balance)
      }</strong> is due by <strong>${
        escapeHtml(hostBalanceDeadline)
      }</strong> (five full days before Open Play).<br/>&bull; If the deadline is missed, the reservation is forfeited, the slot is released, and the payment already made remains non-refundable.`
      : `&bull; Remaining balance of <strong>${
        fmtPHP(balance)
      }</strong> is due on the day of play.`
  }
            </div>
          </td></tr>
        </table>

        <p style="margin:0;font-size:.88rem;color:#9fb3c4;line-height:1.7;">
          Questions? Call or text <a href="tel:${SUPPORT_PHONE_HREF}" style="color:#b8de73;font-weight:700;text-decoration:none">${
    escapeHtml(SUPPORT_PHONE)
  }</a>
          or message the <a href="${
    escapeHtml(FACEBOOK_URL)
  }" style="color:#b8de73;font-weight:700;text-decoration:none">Backyard Pickle Facebook page</a>.
          We're excited to see you on the court!
        </p>
      </td></tr>

      <tr><td style="background:#06264f;background-image:linear-gradient(#06264f,#06264f);padding:18px 36px;text-align:center;border-top:1px solid #244a67;">
        <div style="font-size:.75rem;color:#b8de73;letter-spacing:1px;">${BRAND_NAME.toUpperCase()}</div>
        <div style="font-size:.72rem;color:#8fa4b5;margin-top:4px;">This is an automated confirmation email.</div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
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
    const mailerooKey = Deno.env.get("MAILEROO_API_KEY") || "";
    if (!mailerooKey) throw new Error("MAILEROO_API_KEY is not configured");

    const body = (await req.json()) as Payload;
    if (!body.email || !body.bookingRef) {
      return new Response(
        JSON.stringify({ error: "Missing email or bookingRef" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const fromAddress = Deno.env.get("EMAIL_FROM") || "";
    const delivery = await sendMailerooEmail({
      apiKey: mailerooKey,
      from: fromAddress,
      to: body.email,
      toName: body.fullName,
      subject: `Booking Confirmed - ${body.bookingRef} | ${BRAND_NAME}`,
      html: buildHtml(body),
      tags: {
        message_type: "booking_confirmation",
        booking_ref: body.bookingRef,
      },
    });

    return new Response(
      JSON.stringify({ ok: true, id: delivery.referenceId }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
