// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { endpointKey, loadVapid, sendPush, validEndpoint, validateSubscription } from "./push.ts";
import { processTargets } from "./worker.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
function secretMatches(a: string, b: string) {
  if (!a || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function handle(req: Request, db: any, env = (key: string) => Deno.env.get(key)) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (Number(req.headers.get("content-length")) > 12000) return json({ ok: false, error: "Request too large" }, 413);
  try {
    const raw = await req.text();
    if (raw.length > 12000) return json({ ok: false, error: "Request too large" }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ ok: false, error: "Invalid request" }, 400); }
    if (body?.action === "process") {
      const setting = await db.from("private_settings").select("value").eq("key", "payment_review_notification_worker_secret").maybeSingle();
      if (setting.error) throw setting.error;
      if (!secretMatches(req.headers.get("x-payment-review-worker-secret") || "", setting.data?.value || "")) return json({ ok: false, error: "Unauthorized" }, 401);
      const summary = await processTargets(db, env);
      return json(summary, summary.ok ? 200 : 207);
    }
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ ok: false, error: "Sign in to manage notifications" }, 401);
    const user = await db.auth.getUser(token);
    if (user.error || !user.data?.user) return json({ ok: false, error: "Sign in again" }, 401);
    const userId = user.data.user.id;
    const account = await db.from("accounts").select("role,status").eq("id", userId).maybeSingle();
    if (account.error || account.data?.status !== "active" || !["owner", "court_owner"].includes(account.data?.role)) return json({ ok: false, error: "Only active owners can manage notifications" }, 403);
    if (!["get", "subscribe", "unsubscribe", "test"].includes(body?.action)) return json({ ok: false, error: "Invalid action" }, 400);
    let key = "";
    let subscription;
    try {
      if (body.action === "subscribe") subscription = validateSubscription(body.subscription);
      const endpoint = subscription?.endpoint || body.endpoint;
      if (endpoint) key = await endpointKey(validEndpoint(endpoint));
      else if (body.action !== "get") throw new Error("Device subscription required");
    } catch (e) { return json({ ok: false, error: e instanceof Error ? e.message : "Invalid subscription" }, 400); }
    if (body.action === "get") {
      const vapid = await loadVapid(db);
      const existing = key ? await db.from("admin_notification_targets").select("id,last_sent_at").eq("target_key", key).eq("user_id", userId).maybeSingle() : { data: null, error: null };
      if (existing.error) throw existing.error;
      return json({ ok: true, publicKey: vapid.publicKey, subscribed: Boolean(existing.data), lastSentAt: existing.data?.last_sent_at || null });
    }
    if (body.action === "subscribe") {
      // Possession of the browser's endpoint and encryption keys binds this device.
      const result = await db.from("admin_notification_targets").upsert({ channel: "push", target_key: key, user_id: userId, subscription,
        lease_id: null, lease_until: null }, { onConflict: "target_key" });
      if (result.error) throw result.error;
      return json({ ok: true, subscribed: true });
    }
    if (body.action === "unsubscribe") {
      const result = await db.from("admin_notification_targets").delete().eq("target_key", key).eq("user_id", userId);
      if (result.error) throw result.error;
      return json({ ok: true, subscribed: false });
    }
    const cutoff = new Date(Date.now() - 60000).toISOString();
    const claimed = await db.from("admin_notification_targets").update({ last_test_at: new Date().toISOString() })
      .eq("target_key", key).eq("user_id", userId).or(`last_test_at.is.null,last_test_at.lt.${cutoff}`).select("id,subscription").maybeSingle();
    if (claimed.error) throw claimed.error;
    if (!claimed.data) return json({ ok: false, error: "Enable this device first, or wait one minute before another test." }, 429);
    const sent = await sendPush(claimed.data.subscription, await loadVapid(db), true);
    if (sent.expired) {
      const removed = await db.from("admin_notification_targets").delete().eq("id", claimed.data.id).eq("user_id", userId);
      if (removed.error) throw removed.error;
      return json({ ok: false, expired: true, error: "This device subscription expired. Turn notifications off, then enable them again." }, 410);
    }
    return json({ ok: true, accepted: true });
  } catch {
    console.error("Admin notification operation failed");
    return json({ ok: false, error: "Notifications are temporarily unavailable. Please try again." }, 503);
  }
}

if (import.meta.main) Deno.serve(req => handle(req, createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { auth: { persistSession: false } })));
