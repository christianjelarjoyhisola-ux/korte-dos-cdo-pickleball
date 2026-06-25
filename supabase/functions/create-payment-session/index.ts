import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type CreatePayload = {
  bookingRef: string;
  amountPhp: number;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  metadata?: Record<string, string>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function extractErrMsg(err: unknown) {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const maybe = err as Record<string, unknown>;
    if (typeof maybe.message === "string") return maybe.message;
    if (typeof maybe.error === "string") return maybe.error;
  }
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

async function createPayMongoCheckoutSession(input: {
  secretKey: string;
  amountPhp: number;
  bookingRef: string;
  customer: { name: string; email: string; phone: string };
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}) {
  const amountCents = Math.round(input.amountPhp * 100);
  const auth = btoa(`${input.secretKey}:`);

  const body = {
    data: {
      attributes: {
        send_email_receipt: false,
        show_description: true,
        show_line_items: true,
        payment_method_types: ["qrph", "paymaya"],
        line_items: [
          {
            currency: "PHP",
            amount: amountCents,
            name: `Booking ${input.bookingRef}`,
            quantity: 1,
            description: `Downpayment for booking ${input.bookingRef}`,
          },
        ],
        reference_number: input.bookingRef,
        description: `Downpayment for ${input.bookingRef}`,
        metadata: input.metadata,
        billing: {
          name: input.customer.name,
          email: input.customer.email,
          phone: input.customer.phone,
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
    },
  };

  const res = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayMongo error ${res.status}: ${extractErrMsg(json)}`);

  const sessionId = json?.data?.id || null;
  const checkoutUrl = json?.data?.attributes?.checkout_url || null;
  if (!sessionId || !checkoutUrl) throw new Error("PayMongo response missing session id or checkout_url");

  return { sessionId, checkoutUrl };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey =
      Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      "";
    if (!serviceRoleKey) throw new Error("Missing SERVICE_ROLE_KEY");
    const provider = (Deno.env.get("PAYMENT_PROVIDER") || "paymongo").toLowerCase();
    const db = createClient(supabaseUrl, serviceRoleKey);

    const body = (await req.json()) as CreatePayload;
    if (!body.bookingRef || !Number.isFinite(body.amountPhp) || body.amountPhp <= 0) {
      return new Response(JSON.stringify({ error: "Invalid payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sessionId = crypto.randomUUID();
    const amountPhp = Number(body.amountPhp.toFixed(2));
    const bookingRef = body.bookingRef;
    const customer = {
      name: body.customer?.name || "Customer",
      email: body.customer?.email || "",
      phone: body.customer?.phone || "",
    };
    const metadata = { ...(body.metadata || {}), booking_ref: bookingRef };

    let checkoutUrl = "";
    let providerSessionId = sessionId;
    let providerName = provider;

    if (provider !== "paymongo") throw new Error("Only PAYMENT_PROVIDER=paymongo is supported");

    const secretKey = Deno.env.get("PAYMONGO_SECRET_KEY") || "";
    const successUrl = Deno.env.get("PAYMENT_SUCCESS_URL") || "";
    const cancelUrl = Deno.env.get("PAYMENT_CANCEL_URL") || "";
    if (!secretKey) throw new Error("PAYMONGO_SECRET_KEY is missing");
    if (!successUrl || !cancelUrl) throw new Error("PAYMENT_SUCCESS_URL or PAYMENT_CANCEL_URL is missing");

    const out = await createPayMongoCheckoutSession({
      secretKey,
      amountPhp,
      bookingRef,
      customer,
      successUrl,
      cancelUrl,
      metadata,
    });
    providerSessionId = out.sessionId;
    checkoutUrl = out.checkoutUrl;
    providerName = "paymongo";

    const nowIso = new Date().toISOString();
    const paymentRow = {
      id: sessionId,
      booking_ref: bookingRef,
      provider: providerName,
      provider_reference: providerSessionId,
      amount_php: amountPhp,
      status: "pending",
      checkout_url: checkoutUrl,
      raw_request: body,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const { error: sessErr } = await db.from("payment_sessions").insert(paymentRow);
    if (sessErr) throw sessErr;

    const { error: bErr } = await db.from("bookings").update({
      payment_status: "pending",
      payment_provider: providerName,
      payment_session_id: sessionId,
      payment_checkout_url: checkoutUrl,
    }).eq("ref", bookingRef);
    if (bErr) throw bErr;

    return new Response(JSON.stringify({
      ok: true,
      provider: providerName,
      sessionId: sessionId,
      providerSessionId,
      checkoutUrl,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: extractErrMsg(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
