import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  claimTelegramNotificationDelivery,
  finalizeTelegramNotificationDelivery,
  handleTelegramOwnerLinkRequest,
  resolveTelegramOwnerChatIds,
  sha256Hex,
  type TelegramRpcDb,
} from "../_shared/telegram-owner-link.ts";
import {
  buildAuthoritativeTelegramAlert,
  normalizeTelegramAlertEvent,
} from "./logic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOOKING_SELECT = [
  "ref",
  "booking_group_ref",
  "full_name",
  "contact_number",
  "court_id",
  "court_name",
  "date",
  "slots",
  "start_time",
  "end_time",
  "duration",
  "total",
  "downpayment",
  "payment_method",
  "payment_status",
  "payment_provider",
  "gcash_ref",
  "status",
  "receipt_status",
  "receipt_flags",
  "receipt_image_url",
  "receipt_image_hash",
  "created_at",
].join(",");

type DbError = {
  code?: string;
  message?: string;
};

type TelegramSendResult = {
  messageId?: string;
};

type ServiceDb = TelegramRpcDb & {
  // Supabase's fluent query builder is intentionally opaque here.
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.message === "string") return value.message;
  }
  return String(error || "Unknown error");
}

function bookingReference(value: unknown): string {
  const reference = String(value || "").trim();
  return /^[A-Za-z0-9_-]{3,128}$/.test(reference) ? reference : "";
}

function legacyTelegramChatIds(raw: string): string[] {
  const recipients = new Set<string>();
  for (const value of raw.split(",")) {
    const chatId = value.trim();
    if (/^-?[1-9][0-9]{0,18}$/.test(chatId)) recipients.add(chatId);
  }
  return [...recipients];
}

async function loadBookingGroup(
  db: ServiceDb,
  reference: string,
): Promise<Record<string, unknown>[]> {
  const { data: primary, error: primaryError } = await db
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("ref", reference)
    .maybeSingle();

  if (primaryError) throw primaryError;

  if (!primary) {
    const { data: grouped, error: groupedError } = await db
      .from("bookings")
      .select(BOOKING_SELECT)
      .eq("booking_group_ref", reference)
      .order("created_at", { ascending: true })
      .order("ref", { ascending: true });
    if (groupedError) throw groupedError;
    return (grouped || []) as Record<string, unknown>[];
  }

  const primaryRow = primary as unknown as Record<string, unknown>;
  const groupRef = String(primaryRow.booking_group_ref || "").trim();
  if (!groupRef) return [primaryRow];

  const { data: grouped, error: groupedError } = await db
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("booking_group_ref", groupRef)
    .order("created_at", { ascending: true })
    .order("ref", { ascending: true });
  if (groupedError) throw groupedError;
  return (grouped?.length ? grouped : [primaryRow]) as Record<string, unknown>[];
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  message: string,
): Promise<TelegramSendResult> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    },
  );
  const envelope = await response.json().catch(() => ({})) as {
    ok?: boolean;
    result?: { message_id?: unknown };
  };
  if (!response.ok || envelope.ok !== true) {
    throw new Error(`Telegram send failed with HTTP ${response.status}`);
  }
  const messageId = envelope.result?.message_id;
  return {
    messageId: typeof messageId === "number" || typeof messageId === "string"
      ? String(messageId)
      : undefined,
  };
}

async function resolveRecipients(
  db: ServiceDb,
  legacyRaw: string,
): Promise<string[]> {
  try {
    return await resolveTelegramOwnerChatIds(db, legacyRaw);
  } catch (error) {
    // During a schema rollout, preserve the existing configured recipients.
    console.error(
      "Dynamic Telegram recipients unavailable:",
      errorMessage(error),
    );
    return legacyTelegramChatIds(legacyRaw);
  }
}

async function deliverToRecipient(options: {
  db: ServiceDb;
  botToken: string;
  chatId: string;
  eventKey: string;
  payloadDigest: string;
  message: string;
}): Promise<"sent" | "deduplicated" | "failed"> {
  let claim;
  try {
    claim = await claimTelegramNotificationDelivery(options.db, {
      eventKey: options.eventKey,
      chatId: options.chatId,
      payloadDigest: options.payloadDigest,
    });
  } catch (error) {
    console.error(
      "Telegram delivery claim failed:",
      errorMessage(error),
    );
    return "failed";
  }

  if (
    !claim.claimed ||
    !claim.deliveryId ||
    !claim.claimToken
  ) {
    return "deduplicated";
  }

  try {
    const sent = await sendTelegramMessage(
      options.botToken,
      options.chatId,
      options.message,
    );
    await finalizeTelegramNotificationDelivery(options.db, {
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      succeeded: true,
      telegramMessageId: sent.messageId,
    });
    return "sent";
  } catch (error) {
    const reason = errorMessage(error).slice(0, 500);
    try {
      await finalizeTelegramNotificationDelivery(options.db, {
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        succeeded: false,
        error: reason,
      });
    } catch (finalizeError) {
      console.error(
        "Telegram failure finalization failed:",
        errorMessage(finalizeError),
      );
    }
    console.error("Telegram recipient send failed:", reason);
    return "failed";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const ownerLinkResponse = await handleTelegramOwnerLinkRequest(req);
    if (ownerLinkResponse) return ownerLinkResponse;
  } catch (error) {
    console.error("Telegram owner-link routing failed:", errorMessage(error));
    return json({
      ok: false,
      error: "Telegram owner linking is temporarily unavailable.",
    }, 500);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const event = normalizeTelegramAlertEvent(body);
  if (!event) {
    return json({
      ok: true,
      skipped: true,
      reason: "Only pending booking verification alerts are sent",
    });
  }

  const reference = bookingReference(body.bookingRef);
  if (!reference) {
    return json({ ok: false, error: "A valid booking reference is required" }, 400);
  }

  const supabaseUrl = String(Deno.env.get("SUPABASE_URL") || "").trim();
  const serviceRoleKey = String(
    Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      "",
  ).trim();
  const botToken = String(Deno.env.get("TELEGRAM_BOT_TOKEN") || "").trim();
  const legacyChatIds = String(Deno.env.get("TELEGRAM_CHAT_ID") || "").trim();

  if (!supabaseUrl || !serviceRoleKey || !botToken) {
    return json({
      ok: true,
      skipped: true,
      reason: "Telegram notification service is not configured",
    });
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  }) as unknown as ServiceDb;

  let rows: Record<string, unknown>[];
  try {
    rows = await loadBookingGroup(db, reference);
  } catch (error) {
    const dbError = error as DbError;
    console.error(
      "Telegram authoritative booking lookup failed:",
      dbError.code || "",
      dbError.message || errorMessage(error),
    );
    return json({
      ok: false,
      error: "The booking could not be checked for Telegram notification.",
    }, 500);
  }

  const adminUrl = String(
    Deno.env.get("APP_ADMIN_URL") ||
      Deno.env.get("PAYMENT_REVIEW_ADMIN_URL") ||
      "https://kortedoscdo.club/admin.html",
  ).trim();
  const alert = await buildAuthoritativeTelegramAlert(rows, event, adminUrl);
  if (!alert) {
    return json({
      ok: true,
      skipped: true,
      reason: "The booking is not awaiting owner verification",
    });
  }

  const recipients = await resolveRecipients(db, legacyChatIds);
  if (!recipients.length) {
    return json({
      ok: true,
      skipped: true,
      reason: "No Telegram recipients are connected",
    });
  }

  const payloadDigest = alert.payloadDigest ||
    await sha256Hex(alert.message);
  const outcomes = await Promise.all(
    recipients.map((chatId) =>
      deliverToRecipient({
        db,
        botToken,
        chatId,
        eventKey: alert.eventKey,
        payloadDigest,
        message: alert.message,
      })
    ),
  );

  const sent = outcomes.filter((outcome) => outcome === "sent").length;
  const deduplicated = outcomes.filter((outcome) =>
    outcome === "deduplicated"
  ).length;
  const failed = outcomes.filter((outcome) => outcome === "failed").length;

  return json({
    ok: failed === 0,
    sent,
    deduplicated,
    failed,
    recipients: recipients.length,
    event,
    bookingRef: alert.bookingRef,
  });
});
