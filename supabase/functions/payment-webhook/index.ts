import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { classifyStoredSessionPayment } from "../_shared/booking-payment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-payment-signature",
};

type WebhookBody = {
  session_id?: string;
  booking_ref?: string;
  provider_reference?: string;
  status?: string;
  paid_at?: string;
  raw?: unknown;
  data?: {
    id?: string;
    type?: string;
    attributes?: {
      type?: string;
      data?: {
        id?: string;
        type?: string;
        attributes?: {
          status?: string;
          paid_at?: string;
          reference_number?: string;
          metadata?: Record<string, unknown>;
        };
      };
    };
  };
};

type PaymentSessionRow = {
  id: string;
  booking_ref: string;
  provider_reference: string | null;
  amount_php: number | string;
  status: string;
};

type BookingPaymentRow = {
  ref: string;
  total: number | string | null;
  downpayment: number | string | null;
  status: string;
};

type ProviderPaymentStatus = "paid" | "failed" | "pending";

function normalizeStatus(input?: string): ProviderPaymentStatus {
  const v = (input || "").toLowerCase();
  if (["paid", "succeeded", "success", "completed"].includes(v)) return "paid";
  if (["failed", "canceled", "cancelled", "expired"].includes(v)) return "failed";
  return "pending";
}

async function verifySignature(req: Request, bodyText: string) {
  const secret = Deno.env.get("PAYMENT_WEBHOOK_SECRET");
  // Fail closed: a missing verifier secret must never make a public webhook
  // endpoint accept an unsigned payment-status update.
  if (!secret) return false;
  const given = req.headers.get("x-payment-signature") || "";
  if (!given) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return expected === given;
}

function parseWebhook(body: WebhookBody) {
  // Generic payload support
  let sessionId = body.session_id || null;
  let bookingRef = body.booking_ref || null;
  let providerRef = body.provider_reference || null;
  let normalized = normalizeStatus(body.status);
  let paidAtIso = body.paid_at || new Date().toISOString();

  // PayMongo event payload support
  const evType = body?.data?.attributes?.type || "";
  const evData = body?.data?.attributes?.data;
  if (evData) {
    providerRef = evData.id || providerRef;
    const evStatus = evData.attributes?.status || "";
    const evRef = evData.attributes?.reference_number || "";
    const evMeta = evData.attributes?.metadata || {};
    const metaRef = typeof evMeta.booking_ref === "string" ? evMeta.booking_ref : "";
    if (!bookingRef) bookingRef = evRef || metaRef || null;
    if (evStatus) normalized = normalizeStatus(evStatus);
    if (evData.attributes?.paid_at) paidAtIso = evData.attributes.paid_at;
    if (evType.toLowerCase().includes("paid")) normalized = "paid";
    if (evType.toLowerCase().includes("failed") || evType.toLowerCase().includes("expired")) normalized = "failed";
    if (!sessionId) sessionId = evData.id || null;
  }

  return { sessionId, bookingRef, providerRef, normalized, paidAtIso };
}

async function findPaymentSession(
  db: any,
  identifiers: { sessionId: string | null; providerRef: string | null; bookingRef: string | null },
): Promise<PaymentSessionRow | null> {
  const select = "id,booking_ref,provider_reference,amount_php,status";
  const checked = new Set<string>();

  for (const value of [identifiers.sessionId, identifiers.providerRef]) {
    if (!value || checked.has(value)) continue;
    checked.add(value);

    const { data: local, error: localErr } = await db
      .from("payment_sessions")
      .select(select)
      .eq("id", value)
      .maybeSingle();
    if (localErr) throw localErr;
    if (local) return local as PaymentSessionRow;

    const { data: provider, error: providerErr } = await db
      .from("payment_sessions")
      .select(select)
      .eq("provider_reference", value)
      .maybeSingle();
    if (providerErr) throw providerErr;
    if (provider) return provider as PaymentSessionRow;
  }

  // PayMongo's payment.paid event identifies the Payment resource rather than
  // the Checkout Session. Use its booking reference only when it points to one
  // unambiguous pending local session; the provider id is persisted below so
  // retries can match it directly.
  if (identifiers.bookingRef) {
    const { data, error } = await db
      .from("payment_sessions")
      .select(select)
      .eq("booking_ref", identifiers.bookingRef)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(2);
    if (error) throw error;
    if ((data || []).length > 1) throw new Error("Webhook does not identify a unique payment session");
    return data?.[0] as PaymentSessionRow || null;
  }

  return null;
}

async function loadSessionBookings(db: any, sessionId: string): Promise<BookingPaymentRow[]> {
  const { data, error } = await db
    .from("bookings")
    .select("ref,total,downpayment,status")
    .eq("payment_session_id", sessionId);
  if (error) throw error;
  return (data || []) as BookingPaymentRow[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const rawText = await req.text();
    const valid = await verifySignature(req, rawText);
    if (!valid) return new Response("Invalid signature", { status: 401, headers: corsHeaders });

    const body = JSON.parse(rawText) as WebhookBody;
    const { sessionId, bookingRef, providerRef, normalized, paidAtIso } = parseWebhook(body);

    if (!sessionId && !providerRef && !bookingRef) {
      return new Response(JSON.stringify({ error: "Missing payment session identifier" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey =
      Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      "";
    if (!serviceRoleKey) throw new Error("Missing SERVICE_ROLE_KEY");
    const db = createClient(supabaseUrl, serviceRoleKey);

    const storedSession = await findPaymentSession(db, { sessionId, providerRef, bookingRef });
    if (!storedSession) {
      return new Response(JSON.stringify({ error: "Payment session not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (bookingRef && bookingRef !== storedSession.booking_ref) {
      return new Response(JSON.stringify({ error: "Payment session does not match booking" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Never use an amount supplied by the webhook. The locally-created session
    // and the booking rows linked to that session are the payment authority.
    const sessionBookings = await loadSessionBookings(db, storedSession.id);
    let bookingPaymentStatus: "paid" | "downpayment_paid" | "failed" | "pending" = normalized;
    if (normalized === "paid") {
      if (!sessionBookings.some((row) => row.ref === storedSession.booking_ref)) {
        throw new Error("Payment session is not linked to its booking");
      }
      bookingPaymentStatus = classifyStoredSessionPayment(
        storedSession.amount_php,
        sessionBookings,
      );
    }

    const paymentUpdate: Record<string, unknown> = {
      status: normalized,
      raw_webhook: body.raw ?? body,
      updated_at: new Date().toISOString(),
    };
    if (providerRef) {
      paymentUpdate.provider_reference = providerRef;
    }
    if (normalized === "paid") paymentUpdate.paid_at = paidAtIso;

    const { error: paymentUpdateErr } = await db
      .from("payment_sessions")
      .update(paymentUpdate)
      .eq("id", storedSession.id);
    if (paymentUpdateErr) throw paymentUpdateErr;

    if (sessionBookings.length > 0) {
      const bookingUpdate: Record<string, unknown> = {
        payment_status: bookingPaymentStatus,
      };
      if (normalized === "paid") bookingUpdate.paid_at = paidAtIso;
      if (normalized === "failed") bookingUpdate.status = "cancelled";
      const { error: bookingUpdateErr } = await db
        .from("bookings")
        .update(bookingUpdate)
        .eq("payment_session_id", storedSession.id);
      if (bookingUpdateErr) throw bookingUpdateErr;
    }

    return new Response(JSON.stringify({
      ok: true,
      status: normalized,
      bookingPaymentStatus,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
