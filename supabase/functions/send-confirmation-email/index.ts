const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
  contactNumber?: string;
};

function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function fmtPHP(n: number): string {
  return "₱" + Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2 });
}

function buildHtml(p: Payload): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Booking Confirmed — KORTE DOS</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f0;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f0;padding:32px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:560px;width:100%;">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#2d7a2d,#1a4a1a);padding:32px 36px;text-align:center;">
        <div style="font-size:2rem;margin-bottom:6px;">🏓</div>
        <div style="font-family:'Bebas Neue',Georgia,serif;font-size:1.6rem;letter-spacing:3px;color:#fff;line-height:1.1;">KORTE DOS</div>
        <div style="font-size:.75rem;color:rgba(255,255,255,.7);letter-spacing:2px;text-transform:uppercase;margin-top:4px;">Your City, Philippines</div>
      </td></tr>

      <!-- Green bar -->
      <tr><td style="background:#4a9a4a;padding:14px 36px;text-align:center;">
        <div style="color:#fff;font-size:1rem;font-weight:700;letter-spacing:1px;">✅ BOOKING CONFIRMED</div>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:32px 36px;">
        <p style="margin:0 0 20px;font-size:1rem;color:#1a2e1a;">Hi <strong>${p.fullName}</strong>,</p>
        <p style="margin:0 0 24px;font-size:.95rem;color:#4a5a4a;line-height:1.6;">
          Great news! KORTE DOS booking has been <strong style="color:#2d7a2d;">confirmed</strong>.
          ${p.downpayment >= p.total ? 'Your full payment has been received and your slot is locked in.' : 'Your downpayment has been received and your slot is locked in.'} See you on the court!
        </p>

        <!-- Booking Details Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4faf4;border:1.5px solid #b8dab8;border-radius:10px;margin-bottom:24px;">
          <tr><td style="padding:18px 22px;border-bottom:1px solid #d0e8d0;">
            <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#6a8a6a;margin-bottom:4px;">Booking Reference</div>
            <div style="font-size:1.1rem;font-weight:800;color:#2d7a2d;font-family:monospace;letter-spacing:1px;">${p.bookingRef}</div>
          </td></tr>
          <tr><td style="padding:14px 22px;border-bottom:1px solid #d0e8d0;">
            <table width="100%"><tr>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#6a8a6a;margin-bottom:3px;">Court</div>
                <div style="font-size:.92rem;font-weight:600;color:#1a2e1a;">${p.courtName}</div>
              </td>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#6a8a6a;margin-bottom:3px;">Date</div>
                <div style="font-size:.92rem;font-weight:600;color:#1a2e1a;">${fmtDate(p.date)}</div>
              </td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:14px 22px;border-bottom:1px solid #d0e8d0;">
            <table width="100%"><tr>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#6a8a6a;margin-bottom:3px;">Time</div>
                <div style="font-size:.92rem;font-weight:600;color:#1a2e1a;">${p.startTime} – ${p.endTime}</div>
              </td>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#6a8a6a;margin-bottom:3px;">Duration</div>
                <div style="font-size:.92rem;font-weight:600;color:#1a2e1a;">${p.duration} hour${p.duration !== 1 ? "s" : ""}</div>
              </td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:14px 22px;">
            <table width="100%"><tr>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#6a8a6a;margin-bottom:3px;">Total Amount</div>
                <div style="font-size:1.05rem;font-weight:800;color:#1a2e1a;">${fmtPHP(p.total)}</div>
              </td>
              <td width="50%" style="vertical-align:top;">
                <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#6a8a6a;margin-bottom:3px;">${p.downpayment >= p.total ? 'Full Payment' : 'Downpayment Paid'}</div>
                <div style="font-size:1.05rem;font-weight:800;color:#2d7a2d;">✓ ${fmtPHP(p.downpayment)}</div>
              </td>
            </tr></table>
          </td></tr>
        </table>

        <!-- Reminder -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbea;border:1.5px solid #f0d060;border-radius:10px;margin-bottom:24px;">
          <tr><td style="padding:14px 18px;">
            <div style="font-size:.82rem;color:#7a6020;line-height:1.6;">
              <strong>📋 Reminders:</strong><br/>
              • Please arrive <strong>10 minutes early</strong> to warm up.<br/>
              • Bring your booking reference: <strong>${p.bookingRef}</strong><br/>
              ${p.downpayment >= p.total ? '• No remaining balance — you\'re all paid up! ✅' : `• Remaining balance of <strong>${fmtPHP(p.total - p.downpayment)}</strong> is due on the day of play.`}
            </div>
          </td></tr>
        </table>

        <p style="margin:0;font-size:.88rem;color:#6a7a6a;line-height:1.6;">
          Questions? Contact us directly. We're excited to see you on the court!
        </p>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f4faf4;padding:18px 36px;text-align:center;border-top:1px solid #d8ead8;">
        <div style="font-size:.75rem;color:#8a9a8a;">KORTE DOS</div>
        <div style="font-size:.72rem;color:#aabcaa;margin-top:4px;">This is an automated confirmation email.</div>
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
        subject: `✅ Booking Confirmed — ${body.bookingRef} | KORTE DOS`,
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
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
