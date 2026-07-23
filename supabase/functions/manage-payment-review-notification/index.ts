// deno-lint-ignore-file no-explicit-any

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  normalizePaymentReviewEmail,
  PAYMENT_REVIEW_NOTIFICATION_SETTING_KEY,
  sendPaymentReviewTestEmail,
} from "../_shared/payment-review-email.ts";

type Action = "get" | "save" | "test";

type RequestBody = {
  action?: Action;
  email?: unknown;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return "Unknown error";
}

async function requirePaymentReviewOwner(
  req: Request,
  db: any,
): Promise<
  | { userId: string; role: "owner" | "court_owner" }
  | { error: Response }
> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: json({ ok: false, error: "Unauthorized" }, 401) };

  const { data: userData, error: userError } = await db.auth.getUser(token);
  if (userError || !userData?.user) {
    return { error: json({ ok: false, error: "Unauthorized" }, 401) };
  }

  const { data: accountData, error: accountError } = await db
    .from("accounts")
    .select("role,status")
    .eq("id", userData.user.id)
    .maybeSingle();
  const account = accountData as {
    role?: string;
    status?: string;
  } | null;
  const role = String(account?.role || "");
  if (
    accountError ||
    account?.status !== "active" ||
    !["owner", "court_owner"].includes(role)
  ) {
    return {
      error: json({
        ok: false,
        error:
          "Only an active system owner or court owner can manage payment-review email.",
      }, 403),
    };
  }

  return {
    userId: userData.user.id,
    role: role as "owner" | "court_owner",
  };
}

async function loadSavedEmail(
  db: any,
): Promise<string> {
  const { data, error } = await db
    .from("private_settings")
    .select("value")
    .eq("key", PAYMENT_REVIEW_NOTIFICATION_SETTING_KEY)
    .maybeSingle();
  if (error) throw error;
  return normalizePaymentReviewEmail(
    (data as { value?: unknown } | null)?.value,
  );
}

async function testEmailIdempotencyKey(
  actorUserId: string,
  recipient: string,
): Promise<string> {
  const minuteBucket = new Date().toISOString().slice(0, 16);
  const material =
    `payment-review-test-v1\u0000${actorUserId}\u0000${recipient}\u0000${minuteBucket}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `payment-review-test:v1:${hex}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 32_768) {
    return json({ ok: false, error: "Request too large" }, 413);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({
      ok: false,
      error: "Supabase service credentials are missing",
    }, 500);
  }

  const db = createClient(supabaseUrl, serviceRoleKey);
  const actor = await requirePaymentReviewOwner(req, db);
  if ("error" in actor) return actor.error;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  try {
    if (body.action === "get") {
      const email = await loadSavedEmail(db);
      return json({ ok: true, email, configured: Boolean(email) });
    }

    if (body.action === "save") {
      let email: string;
      try {
        email = normalizePaymentReviewEmail(body.email);
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 400);
      }

      if (email) {
        const { error } = await db.from("private_settings").upsert({
          key: PAYMENT_REVIEW_NOTIFICATION_SETTING_KEY,
          value: email,
          updated_by: actor.userId,
        }, { onConflict: "key" });
        if (error) throw error;
      } else {
        const { error } = await db
          .from("private_settings")
          .delete()
          .eq("key", PAYMENT_REVIEW_NOTIFICATION_SETTING_KEY);
        if (error) throw error;
      }

      return json({ ok: true, email, configured: Boolean(email) });
    }

    if (body.action === "test") {
      const recipient = await loadSavedEmail(db);
      if (!recipient) {
        return json({
          ok: false,
          error: "Save a notification email before sending a test.",
        }, 400);
      }

      const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
      if (!resendApiKey) {
        return json({
          ok: false,
          error: "RESEND_API_KEY is not configured",
        }, 500);
      }

      const result = await sendPaymentReviewTestEmail({
        resendApiKey,
        recipient,
        fromAddress: Deno.env.get("EMAIL_FROM") || undefined,
        idempotencyKey: await testEmailIdempotencyKey(
          actor.userId,
          recipient,
        ),
      });

      return json({
        ok: true,
        sent: true,
        ...(result.providerMessageId
          ? { providerMessageId: result.providerMessageId }
          : {}),
      });
    }

    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (error) {
    console.error(
      "manage-payment-review-notification error:",
      errorMessage(error),
    );
    return json({
      ok: false,
      error: body.action === "test"
        ? "The test email could not be sent."
        : "Payment-review email settings could not be updated.",
    }, 500);
  }
});
