// deno-lint-ignore-file no-explicit-any

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  PAYMENT_REVIEW_NOTIFICATION_WORKER_SETTING_KEY,
  paymentReviewWorkerSecretsMatch,
  processDuePaymentReviewNotifications,
} from "../_shared/payment-review-worker.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

async function loadWorkerSecret(db: any): Promise<string> {
  const { data, error } = await db
    .from("private_settings")
    .select("value")
    .eq("key", PAYMENT_REVIEW_NOTIFICATION_WORKER_SETTING_KEY)
    .maybeSingle();
  if (error) throw error;
  return String((data as { value?: unknown } | null)?.value ?? "");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 4_096) {
    return json({ ok: false, error: "Request too large" }, 413);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Worker is unavailable" }, 503);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  try {
    const expectedSecret = await loadWorkerSecret(db);
    const providedSecret = req.headers.get("x-payment-review-worker-secret") ||
      "";
    if (!paymentReviewWorkerSecretsMatch(providedSecret, expectedSecret)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({})) as {
      batchSize?: unknown;
    };
    const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";

    const summary = await processDuePaymentReviewNotifications({
      db,
      resendApiKey,
      fromAddress: Deno.env.get("EMAIL_FROM") || undefined,
      adminUrl: Deno.env.get("PAYMENT_REVIEW_ADMIN_URL") || undefined,
      batchSize: body.batchSize,
    });

    // Only aggregate delivery counts leave the trusted worker. Booking
    // references, recipients, hashes, and delivery IDs remain private.
    return json(summary, summary.ok ? 200 : 207);
  } catch {
    console.error("Payment-review notification worker failed");
    return json({ ok: false, error: "Worker run failed" }, 500);
  }
});
