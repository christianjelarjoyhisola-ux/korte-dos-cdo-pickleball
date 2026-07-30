// deno-lint-ignore-file no-explicit-any no-import-prefix no-control-regex

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type AccountRole = "host" | "owner" | "court_owner" | "system";
type Actor = {
  userId: string | null;
  role: AccountRole;
};

type RequestBody = {
  action?: unknown;
  bookingRef?: unknown;
  bookingKey?: unknown;
  booking_ref?: unknown;
  booking_key?: unknown;
  idempotencyKey?: unknown;
  idempotency_key?: unknown;
  provider?: unknown;
  paymentProvider?: unknown;
  payment_provider?: unknown;
  paymentReference?: unknown;
  payment_reference?: unknown;
  paymentId?: unknown;
  payment_id?: unknown;
  receiptVerificationId?: unknown;
  receipt_verification_id?: unknown;
  decision?: unknown;
  reason?: unknown;
  limit?: unknown;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BALANCE_REF_RE = /^HBAL-[A-F0-9]{32}$/;
const ALLOWED_PROVIDERS = new Set([
  "gcash",
  "bdopay",
  "maya",
  "bpi",
  "maribank",
  "gotyme",
  "pnb",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const item = error as Record<string, unknown>;
    if (typeof item.message === "string") return item.message;
    if (typeof item.error === "string") return item.error;
  }
  return "Unknown error";
}

function cleanText(
  value: unknown,
  maxLength: number,
  field: string,
  required = true,
): string {
  const raw = String(value ?? "");
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error(`${field} contains invalid control characters`);
  }
  const clean = raw.trim().replace(/\s+/g, " ").normalize("NFC");
  if (required && !clean) throw new Error(`${field} is required`);
  if (clean.length > maxLength) throw new Error(`${field} is too long`);
  return clean;
}

function cleanUuid(value: unknown, field: string): string {
  const clean = cleanText(value, 36, field).toLowerCase();
  if (!UUID_RE.test(clean)) throw new Error(`${field} is invalid`);
  return clean;
}

function positiveAuditId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Receipt verification id is invalid");
  }
  return id;
}

function actionName(value: unknown): string {
  return String(value || "").trim().replace(/-/g, "_").toLowerCase();
}

function databaseErrorStatus(error: any): number {
  const code = String(error?.code || "");
  if (code === "P0002") return 404;
  if (code === "42501") return 403;
  if (code === "22023" || code.startsWith("22")) return 400;
  if (["23505", "P0001", "40001"].includes(code)) return 409;
  return 500;
}

function normalizePaymentRow(row: any): Record<string, unknown> {
  if (!row || typeof row !== "object") return {};
  const status = String(row.status || "");
  const total = Number(row.total_amount || 0);
  const originalPaid = Number(row.original_paid_amount || 0);
  const expected = Number(row.expected_amount || 0);
  return {
    id: row.id,
    paymentId: row.id,
    verificationRef: row.verification_ref,
    bookingRef: row.booking_ref,
    bookingGroupRef: row.booking_group_ref || null,
    bookingKey: row.booking_key,
    bookingRefs: Array.isArray(row.booking_refs) ? row.booking_refs : [],
    hostUserId: row.host_user_id,
    status,
    totalAmount: total,
    originalPaidAmount: originalPaid,
    paidAmount: status === "approved" ? total : originalPaid,
    balanceAmount: expected,
    remainingAmount: status === "approved" ? 0 : expected,
    balanceDueAt: row.balance_due_at,
    expiresAt: row.expires_at,
    paymentProvider: row.payment_provider,
    paymentReference: row.payment_reference,
    customerName: row.customer_name,
    customerEmail: row.customer_email || null,
    bookingDate: row.booking_date,
    courtLabel: row.court_label || null,
    scheduleLabel: row.schedule_label || null,
    receiptVerificationId: row.receipt_verification_id || null,
    receiptStatus: row.receipt_result || null,
    receiptImageHash: row.receipt_image_hash || null,
    receiptFlags: Array.isArray(row.receipt_flags) ? row.receipt_flags : [],
    receiptExtracted: row.receipt_extracted || null,
    receiptConfidence: row.receipt_confidence == null
      ? null
      : Number(row.receipt_confidence),
    submittedAt: row.submitted_at || null,
    reviewedAt: row.reviewed_at || null,
    reviewedByUserId: row.reviewed_by_user_id || null,
    reviewedByRole: row.reviewed_by_role || null,
    reviewReason: row.review_reason || null,
    approvedAt: row.approved_at || null,
    rejectedAt: row.rejected_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeRpcPayment(value: any): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const payment = { ...value } as Record<string, unknown>;
  if (payment.id && !payment.paymentId) payment.paymentId = payment.id;
  return payment;
}

async function authenticate(
  req: Request,
  db: any,
  serviceRoleKey: string,
): Promise<Actor | Response> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ ok: false, error: "Unauthorized" }, 401);

  // The service key is accepted only as the non-human system actor. Browser
  // callers always go through auth.getUser plus the active accounts table.
  if (token === serviceRoleKey) return { userId: null, role: "system" };

  const { data: userData, error: userError } = await db.auth.getUser(token);
  if (userError || !userData?.user) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  const { data: accountData, error: accountError } = await db
    .from("accounts")
    .select("role,status")
    .eq("id", userData.user.id)
    .maybeSingle();
  const role = String(accountData?.role || "") as AccountRole;
  if (
    accountError ||
    accountData?.status !== "active" ||
    !["host", "owner", "court_owner"].includes(role)
  ) {
    return json({ ok: false, error: "Active account required" }, 403);
  }
  return { userId: userData.user.id, role };
}

function requireHost(actor: Actor): Response | null {
  if (actor.role !== "host" || !actor.userId) {
    return json({
      ok: false,
      error: "Only an active host can manage a booking balance payment.",
    }, 403);
  }
  return null;
}

function requireReviewer(actor: Actor): Response | null {
  if (!["owner", "court_owner", "system"].includes(actor.role)) {
    return json({
      ok: false,
      error:
        "Only an active system owner or court owner can review balance payments.",
    }, 403);
  }
  return null;
}

async function loadCurrentAttempt(
  db: any,
  bookingKey: string,
  hostUserId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from("host_booking_balance_payments")
    .select("*")
    .eq("booking_key", bookingKey)
    .eq("host_user_id", hostUserId)
    .in("status", ["created", "pending_review"])
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  const now = Date.now();
  const current = (data || []).find((row: any) =>
    row.status === "pending_review" ||
    (
      row.status === "created" &&
      new Date(row.expires_at).getTime() > now &&
      new Date(row.balance_due_at).getTime() > now
    )
  );
  return current ? normalizePaymentRow(current) : null;
}

async function signedReceipt(
  db: any,
  paymentId: string,
): Promise<{ url: string; expiresIn: number }> {
  const { data: payment, error: paymentError } = await db
    .from("host_booking_balance_payments")
    .select("verification_ref,receipt_image_hash,receipt_verification_id")
    .eq("id", paymentId)
    .maybeSingle();
  if (paymentError) throw paymentError;
  if (
    !payment ||
    !BALANCE_REF_RE.test(String(payment.verification_ref || "")) ||
    !payment.receipt_verification_id ||
    !/^[a-f0-9]{64}$/i.test(String(payment.receipt_image_hash || ""))
  ) {
    throw Object.assign(new Error("Balance receipt was not found"), {
      code: "P0002",
    });
  }

  const hash = String(payment.receipt_image_hash).toLowerCase();
  const ref = String(payment.verification_ref);
  const { data: files, error: listError } = await db.storage
    .from("receipts")
    .list(ref, { limit: 10, search: hash });
  if (listError) throw listError;
  const file = (files || []).find((item: any) =>
    new RegExp(`^${hash}\\.(?:jpg|jpeg|png|webp|heic|heif)$`, "i").test(
      String(item.name || ""),
    )
  );
  if (!file) {
    throw Object.assign(new Error("Balance receipt image was not found"), {
      code: "P0002",
    });
  }
  const path = `${ref}/${file.name}`;
  const expiresIn = 300;
  const { data: signed, error: signedError } = await db.storage
    .from("receipts")
    .createSignedUrl(path, expiresIn);
  if (signedError || !signed?.signedUrl) {
    throw signedError || new Error("Could not sign the balance receipt");
  }
  return { url: signed.signedUrl, expiresIn };
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
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const actorResult = await authenticate(req, db, serviceRoleKey);
  if (actorResult instanceof Response) return actorResult;
  const actor = actorResult;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const action = actionName(body.action);

  try {
    if (action === "quote") {
      const denied = requireHost(actor);
      if (denied) return denied;
      const bookingLookup = cleanText(
        body.bookingKey ?? body.booking_key ?? body.bookingRef ??
          body.booking_ref,
        160,
        "Booking reference",
      );
      const { data, error } = await db.rpc(
        "quote_host_booking_balance_payment",
        {
          p_booking_lookup: bookingLookup,
          p_host_user_id: actor.userId,
        },
      );
      if (error) throw error;
      const quote = data as Record<string, unknown>;
      const bookingKey = String(quote?.bookingKey || "");
      const currentAttempt = bookingKey
        ? await loadCurrentAttempt(db, bookingKey, actor.userId as string)
        : null;
      return json({
        ok: true,
        action,
        quote,
        ...(currentAttempt ? { currentAttempt } : {}),
      });
    }

    if (action === "create") {
      const denied = requireHost(actor);
      if (denied) return denied;
      const bookingLookup = cleanText(
        body.bookingKey ?? body.booking_key ?? body.bookingRef ??
          body.booking_ref,
        160,
        "Booking reference",
      );
      const idempotencyKey = cleanText(
        body.idempotencyKey ?? body.idempotency_key,
        128,
        "Idempotency key",
      );
      const provider = cleanText(
        body.paymentProvider ?? body.payment_provider ?? body.provider,
        20,
        "Payment provider",
      ).toLowerCase();
      if (!ALLOWED_PROVIDERS.has(provider)) {
        return json({
          ok: false,
          error: "A supported payment provider is required",
        }, 400);
      }
      const paymentReference = cleanText(
        body.paymentReference ?? body.payment_reference,
        160,
        "Payment reference",
      );
      const { data, error } = await db.rpc(
        "create_host_booking_balance_payment",
        {
          p_booking_lookup: bookingLookup,
          p_host_user_id: actor.userId,
          p_idempotency_key: idempotencyKey,
          p_provider: provider,
          p_payment_reference: paymentReference,
        },
      );
      if (error) throw error;
      const payment = normalizeRpcPayment(data);
      if (
        payment.status === "expired" ||
        (
          payment.status === "created" &&
          new Date(String(payment.expiresAt || "")).getTime() <= Date.now()
        )
      ) {
        return json({
          ok: false,
          error: "The payment attempt expired; create a new attempt.",
          payment,
        }, 409);
      }
      return json({
        ok: true,
        action,
        payment,
        verification: {
          bookingRef: payment.verificationRef,
          provider: payment.paymentProvider,
        },
      });
    }

    if (action === "submit") {
      const denied = requireHost(actor);
      if (denied) return denied;
      const paymentId = cleanUuid(
        body.paymentId ?? body.payment_id,
        "Payment id",
      );
      const receiptVerificationId = positiveAuditId(
        body.receiptVerificationId ?? body.receipt_verification_id,
      );
      const { data, error } = await db.rpc(
        "submit_host_booking_balance_payment",
        {
          p_payment_id: paymentId,
          p_host_user_id: actor.userId,
          p_receipt_verification_id: receiptVerificationId,
        },
      );
      if (error) throw error;
      const payment = normalizeRpcPayment(data);
      if (payment.status === "expired") {
        return json({
          ok: false,
          error: "The payment attempt expired; create a new attempt.",
          payment,
        }, 409);
      }
      return json({
        ok: true,
        action,
        payment,
      });
    }

    if (action === "list_pending") {
      const denied = requireReviewer(actor);
      if (denied) return denied;
      const requestedLimit = Number(body.limit);
      const limit = Number.isSafeInteger(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 100))
        : 100;
      const { data, error } = await db
        .from("host_booking_balance_payments")
        .select("*")
        .eq("status", "pending_review")
        .order("submitted_at", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return json({
        ok: true,
        action,
        payments: (data || []).map(normalizePaymentRow),
      });
    }

    if (action === "review") {
      const denied = requireReviewer(actor);
      if (denied) return denied;
      const paymentId = cleanUuid(
        body.paymentId ?? body.payment_id,
        "Payment id",
      );
      const decision = cleanText(body.decision, 16, "Decision").toLowerCase();
      if (!["approve", "reject"].includes(decision)) {
        return json({
          ok: false,
          error: "Decision must be approve or reject",
        }, 400);
      }
      const reason = cleanText(body.reason, 1000, "Reason", false);
      if (decision === "reject" && reason.length < 3) {
        return json({
          ok: false,
          error: "A rejection reason of at least 3 characters is required",
        }, 400);
      }
      const { data, error } = await db.rpc(
        "apply_host_booking_balance_payment_decision",
        {
          p_payment_id: paymentId,
          p_decision: decision,
          p_actor_user_id: actor.userId,
          p_actor_role: actor.role,
          p_reason: reason || null,
        },
      );
      if (error) throw error;
      return json({
        ok: true,
        action,
        decision,
        payment: normalizeRpcPayment(data),
      });
    }

    if (action === "sign_receipt" || action === "receipt_url") {
      const denied = requireReviewer(actor);
      if (denied) return denied;
      const paymentId = cleanUuid(
        body.paymentId ?? body.payment_id,
        "Payment id",
      );
      const signed = await signedReceipt(db, paymentId);
      return json({ ok: true, action, paymentId, ...signed });
    }

    return json({ ok: false, error: "Unsupported action" }, 400);
  } catch (error) {
    const status = databaseErrorStatus(error);
    const message = errorMessage(error);
    if (status >= 500) {
      console.error("host-booking-balance-payment:", message);
    }
    return json({
      ok: false,
      error: message,
      ...(typeof (error as any)?.code === "string"
        ? { code: (error as any).code }
        : {}),
    }, status);
  }
});
