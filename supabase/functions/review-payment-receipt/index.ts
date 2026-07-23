import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type ReviewDecision = "approve" | "reject";

type ReviewPayload = {
  contextType?: "court_booking" | "open_play" | "host_session";
  bookingRef?: string;
  registrationId?: number | string;
  decision?: ReviewDecision;
  reason?: string;
};

type ReviewerAuthorization =
  | {
    user: { id: string };
    account: { role: string; status: string };
  }
  | { response: Response };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const item = error as Record<string, unknown>;
    if (typeof item.message === "string") return item.message;
    if (typeof item.error === "string") return item.error;
  }
  return String(error || "Unknown error");
}

function cleanReason(value: unknown): string {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()
    .slice(0, 1000);
}

async function requireReviewer(
  req: Request,
  db: any,
): Promise<ReviewerAuthorization> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { response: json({ error: "Unauthorized" }, 401) };

  const { data: userData, error: userError } = await db.auth.getUser(token);
  if (userError || !userData?.user) {
    return { response: json({ error: "Unauthorized" }, 401) };
  }

  const { data: account, error: accountError } = await db
    .from("accounts")
    .select("id,role,status")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (
    accountError || account?.status !== "active" ||
    !["owner", "court_owner", "staff"].includes(String(account?.role || ""))
  ) {
    return {
      response: json({ error: "Payment review permission required" }, 403),
    };
  }

  return { user: userData.user, account };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Supabase service credentials are missing" }, 500);
  }

  const db = createClient(supabaseUrl, serviceRoleKey);
  const reviewer = await requireReviewer(req, db);
  if ("response" in reviewer) return reviewer.response;

  let body: ReviewPayload;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const contextType = String(body.contextType || "court_booking").trim()
    .toLowerCase();
  const bookingRef = String(body.bookingRef || "").trim();
  const registrationId = Number(body.registrationId);
  const hostRegistrationId = String(body.registrationId || "").trim()
    .toLowerCase();
  const validHostRegistrationId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(hostRegistrationId);
  const decision = body.decision;
  const reason = cleanReason(body.reason);
  if (!["court_booking", "open_play", "host_session"].includes(contextType)) {
    return json({ error: "A valid payment-review context is required" }, 400);
  }
  if (
    !["approve", "reject"].includes(String(decision || "")) ||
    (contextType === "court_booking" && !bookingRef) ||
    (
      contextType === "open_play" &&
      (!Number.isSafeInteger(registrationId) || registrationId <= 0)
    ) ||
    (
      contextType === "host_session" &&
      !validHostRegistrationId
    )
  ) {
    return json({
      error: contextType === "open_play"
        ? "registrationId and a valid decision are required"
        : contextType === "host_session"
        ? "a valid host registrationId and decision are required"
        : "bookingRef and a valid decision are required",
    }, 400);
  }
  if (decision === "reject" && reason.length < 3) {
    return json({
      error: "A rejection reason of at least 3 characters is required",
    }, 400);
  }

  try {
    const defaultReason = decision === "approve"
      ? "Receipt reviewed and payment confirmed."
      : null;
    const rpcName = contextType === "open_play"
      ? "apply_open_play_payment_review_decision"
      : contextType === "host_session"
      ? "apply_host_session_payment_review_decision"
      : "apply_payment_review_decision";
    const rpcArgs = contextType === "open_play"
      ? {
        p_registration_id: registrationId,
        p_decision: decision,
        p_actor_user_id: reviewer.user.id,
        p_actor_role: reviewer.account.role,
        p_reason: reason || defaultReason,
      }
      : contextType === "host_session"
      ? {
        p_registration_id: hostRegistrationId,
        p_decision: decision,
        p_actor_user_id: reviewer.user.id,
        p_actor_role: reviewer.account.role,
        p_reason: reason || defaultReason,
      }
      : {
        p_booking_ref: bookingRef,
        p_decision: decision,
        p_actor_user_id: reviewer.user.id,
        p_actor_role: reviewer.account.role,
        p_reason: reason || defaultReason,
      };
    const { data, error } = await db.rpc(rpcName, rpcArgs);
    if (error) {
      const code = String(error.code || "");
      const status = code === "P0002"
        ? 404
        : code === "42501"
        ? 403
        : code === "22023"
        ? 400
        : ["23505", "P0001"].includes(code)
        ? 409
        : 500;
      console.error("review-payment-receipt:", errMsg(error));
      return json({ error: errMsg(error) }, status);
    }

    return json({
      ok: true,
      contextType,
      decision,
      ...(contextType === "open_play"
        ? { registrationId }
        : contextType === "host_session"
        ? { registrationId: hostRegistrationId }
        : { bookingRef }),
      ...(data && typeof data === "object" ? data : {}),
    });
  } catch (error) {
    console.error("review-payment-receipt:", errMsg(error));
    return json({ error: errMsg(error) }, 500);
  }
});
