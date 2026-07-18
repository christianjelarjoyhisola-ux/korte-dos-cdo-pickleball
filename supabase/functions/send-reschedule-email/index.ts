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
  oldDate: string;
  oldStartTime: string;
  oldEndTime: string;
  newDate: string;
  newStartTime: string;
  newEndTime: string;
  newDuration: number;
  note?: string;
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

function buildHtml(p: Payload): string {
  const fullName = escapeHtml(p.fullName);
  const bookingRef = escapeHtml(p.bookingRef);
  const courtName = escapeHtml(p.courtName);
  const oldStartTime = escapeHtml(p.oldStartTime);
  const oldEndTime = escapeHtml(p.oldEndTime);
  const newStartTime = escapeHtml(p.newStartTime);
  const newEndTime = escapeHtml(p.newEndTime);
  const note = p.note?.trim()
    ? `<div style="background:#142c24;background-image:linear-gradient(#142c24,#142c24);border:1.5px solid #4f7f25;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
        <div style="font-size:.82rem;color:#ddebd1;line-height:1.6;">
          <strong>Message from ${BRAND_NAME}:</strong><br/>${escapeHtml(p.note)}
        </div>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta name="color-scheme" content="dark"/>
<meta name="supported-color-schemes" content="dark"/>
<title>Booking Rescheduled - ${BRAND_NAME}</title>
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
        <div style="color:#fff;font-size:1rem;font-weight:900;letter-spacing:1px;">BOOKING RESCHEDULED</div>
      </td></tr>

      <tr><td style="padding:32px 36px;background:#0e2a45;background-image:linear-gradient(#0e2a45,#0e2a45);">
        <p style="margin:0 0 20px;font-size:1rem;color:#f6faf3;">Hi <strong>${fullName}</strong>,</p>
        <p style="margin:0 0 24px;font-size:.95rem;color:#d5e2e9;line-height:1.6;">
          Your booking has been <strong style="color:#b8de73;">rescheduled</strong> to a new date and time.
          All other details remain the same &mdash; your slot is secure.
        </p>

        ${note}

        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:10px;overflow:hidden;margin-bottom:24px;">
          <tr><td style="background:#241313;background-image:linear-gradient(#241313,#241313);border:1.5px solid #7a3732;border-bottom:none;border-radius:10px 10px 0 0;padding:14px 20px;">
            <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:#f28b82;margin-bottom:6px;font-weight:700;">Old Schedule</div>
            <div style="font-size:.92rem;color:#f1b2ae;text-decoration:line-through;">${
    fmtDate(p.oldDate)
  }</div>
            <div style="font-size:.88rem;color:#f1b2ae;text-decoration:line-through;">${oldStartTime} &ndash; ${oldEndTime}</div>
          </td></tr>
          <tr><td style="background:#0a2239;background-image:linear-gradient(#0a2239,#0a2239);border:1.5px solid #4f7f25;border-top:none;border-radius:0 0 10px 10px;padding:14px 20px;">
            <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:#b8de73;margin-bottom:6px;font-weight:700;">New Schedule</div>
            <div style="font-size:1rem;font-weight:800;color:#f6faf3;">${
    fmtDate(p.newDate)
  }</div>
            <div style="font-size:.92rem;font-weight:600;color:#d5e2e9;">${newStartTime} &ndash; ${newEndTime} &middot; ${p.newDuration} hr${
    p.newDuration !== 1 ? "s" : ""
  }</div>
          </td></tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a2239;background-image:linear-gradient(#0a2239,#0a2239);border:1.5px solid #4f7f25;border-radius:10px;margin-bottom:24px;">
          <tr><td style="padding:14px 22px;">
            <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#9fb3c4;margin-bottom:3px;">Court &middot; Booking Reference</div>
            <div style="font-size:.95rem;font-weight:700;color:#f6faf3;">${courtName} &nbsp;&middot;&nbsp; <span style="font-family:monospace;color:#b8de73;">${bookingRef}</span></div>
          </td></tr>
        </table>

        <p style="margin:0;font-size:.88rem;color:#9fb3c4;line-height:1.7;">
          We apologize for the change and appreciate your understanding. Questions? Call or text
          <a href="tel:${SUPPORT_PHONE_HREF}" style="color:#b8de73;font-weight:700;text-decoration:none">${
    escapeHtml(SUPPORT_PHONE)
  }</a>
          or message the <a href="${
    escapeHtml(FACEBOOK_URL)
  }" style="color:#b8de73;font-weight:700;text-decoration:none">Backyard Pickle Facebook page</a>.
        </p>
      </td></tr>

      <tr><td style="background:#06264f;background-image:linear-gradient(#06264f,#06264f);padding:18px 36px;text-align:center;border-top:1px solid #244a67;">
        <div style="font-size:.75rem;color:#b8de73;letter-spacing:1px;">${BRAND_NAME.toUpperCase()}</div>
        <div style="font-size:.72rem;color:#8fa4b5;margin-top:4px;">This is an automated notification email.</div>
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
      subject: `Booking Rescheduled - ${body.bookingRef} | ${BRAND_NAME}`,
      html: buildHtml(body),
      tags: {
        message_type: "booking_reschedule",
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
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
