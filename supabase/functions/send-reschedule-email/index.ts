const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LOGO_URL = "https://kortedoscdo.club/korte-dos-logo.png";

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
  const note = p.note?.trim()
    ? `<div style="background:#fffbea;border:1.5px solid #f0d060;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
        <div style="font-size:.82rem;color:#7a6020;line-height:1.6;">
          <strong>📝 Message from KORTE DOS:</strong><br/>${p.note}
        </div>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Booking Rescheduled — KORTE DOS</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f0;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f0;padding:32px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;width:100%;">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#2d7a2d,#1a4a1a);padding:32px 36px;text-align:center;">
        <img src="${LOGO_URL}" width="92" height="92" alt="Korte DOS logo" style="display:block;width:92px;height:92px;margin:0 auto 12px;border-radius:50%;background:#fff;padding:6px;border:3px solid rgba(255,255,255,.9);"/>
        <div style="font-family:'Bebas Neue',Georgia,serif;font-size:1.6rem;letter-spacing:3px;color:#fff;line-height:1.1;">KORTE DOS</div>
        <div style="font-size:.75rem;color:rgba(255,255,255,.7);letter-spacing:2px;text-transform:uppercase;margin-top:4px;">Bayabas, Cagayan de Oro City</div>
      </td></tr>

      <!-- Blue bar -->
      <tr><td style="background:#4a7abf;padding:14px 36px;text-align:center;">
        <div style="color:#fff;font-size:1rem;font-weight:700;letter-spacing:1px;">📅 BOOKING RESCHEDULED</div>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:32px 36px;">
        <p style="margin:0 0 20px;font-size:1rem;color:#1a2e1a;">Hi <strong>${p.fullName}</strong>,</p>
        <p style="margin:0 0 24px;font-size:.95rem;color:#4a5a4a;line-height:1.6;">
          Your booking has been <strong style="color:#4a7abf;">rescheduled</strong> to a new date and time.
          All other details remain the same — your slot is secure!
        </p>

        ${note}

        <!-- Schedule Change Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:10px;overflow:hidden;margin-bottom:24px;">
          <!-- Old schedule -->
          <tr><td style="background:#fef2f2;border:1.5px solid #fca5a5;border-bottom:none;border-radius:10px 10px 0 0;padding:14px 20px;">
            <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:#ef4444;margin-bottom:6px;font-weight:700;">❌ Old Schedule</div>
            <div style="font-size:.92rem;color:#991b1b;text-decoration:line-through;">${fmtDate(p.oldDate)}</div>
            <div style="font-size:.88rem;color:#b91c1c;text-decoration:line-through;">${p.oldStartTime} – ${p.oldEndTime}</div>
          </td></tr>
          <!-- New schedule -->
          <tr><td style="background:#f0fdf4;border:1.5px solid #86efac;border-top:none;border-radius:0 0 10px 10px;padding:14px 20px;">
            <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:#16a34a;margin-bottom:6px;font-weight:700;">✅ New Schedule</div>
            <div style="font-size:1rem;font-weight:800;color:#15803d;">${fmtDate(p.newDate)}</div>
            <div style="font-size:.92rem;font-weight:600;color:#166534;">${p.newStartTime} – ${p.newEndTime} · ${p.newDuration} hr${p.newDuration !== 1 ? "s" : ""}</div>
          </td></tr>
        </table>

        <!-- Court info -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4faf4;border:1.5px solid #b8dab8;border-radius:10px;margin-bottom:24px;">
          <tr><td style="padding:14px 22px;">
            <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#6a8a6a;margin-bottom:3px;">Court · Booking Reference</div>
            <div style="font-size:.95rem;font-weight:700;color:#1a2e1a;">${p.courtName} &nbsp;·&nbsp; <span style="font-family:monospace;color:#2d7a2d;">${p.bookingRef}</span></div>
          </td></tr>
        </table>

        <p style="margin:0;font-size:.88rem;color:#6a7a6a;line-height:1.6;">
          We apologize for the change and appreciate your understanding. See you on the new date!
        </p>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f4faf4;padding:18px 36px;text-align:center;border-top:1px solid #d8ead8;">
        <div style="font-size:.75rem;color:#8a9a8a;">KORTE DOS</div>
        <div style="font-size:.72rem;color:#aabcaa;margin-top:4px;">This is an automated notification email.</div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const resendKey = Deno.env.get("RESEND_API_KEY") || "";
    if (!resendKey) throw new Error("RESEND_API_KEY is not configured");

    const body = (await req.json()) as Payload;
    if (!body.email || !body.bookingRef) {
      return new Response(JSON.stringify({ error: "Missing email or bookingRef" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fromAddress = Deno.env.get("EMAIL_FROM") || "KORTE DOS <onboarding@resend.dev>";

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [body.email],
        subject: `📅 Booking Rescheduled — ${body.bookingRef} | KORTE DOS`,
        html: buildHtml(body),
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${JSON.stringify(json)}`);

    return new Response(JSON.stringify({ ok: true, id: json.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
