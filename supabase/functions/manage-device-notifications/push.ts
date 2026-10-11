// deno-lint-ignore-file no-explicit-any
import webpush from "npm:web-push@3.6.7";

export function validEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid device endpoint");
  const u = new URL(value);
  const h = u.hostname;
  const allowed = h === "fcm.googleapis.com" || h === "updates.push.services.mozilla.com" ||
    h === "web.push.apple.com" || h.endsWith(".push.apple.com") ||
    h === "wns.windows.com" || h.endsWith(".wns.windows.com");
  if (!allowed || u.protocol !== "https:" || u.port || u.username || u.password || u.hash) {
    throw new Error("Unsupported push service. Use a current Chrome, Edge, Firefox or Safari browser.");
  }
  return u.href;
}

export function validateSubscription(value: any) {
  const endpoint = validEndpoint(value?.endpoint);
  const keys = value?.keys;
  if (!/^[A-Za-z0-9_-]{87}={0,1}$/.test(keys?.p256dh || "") ||
      !/^[A-Za-z0-9_-]{22}={0,2}$/.test(keys?.auth || "")) throw new Error("Invalid device keys");
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export async function endpointKey(endpoint: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function loadVapid(db: any) {
  const key = "admin_web_push_vapid_v1";
  let result = await db.from("private_settings").select("value").eq("key", key).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) {
    // Only the insert winner persists its pair; all concurrent callers reread it.
    const pair = webpush.generateVAPIDKeys();
    const insert = await db.from("private_settings").upsert({ key, value: JSON.stringify(pair) }, { onConflict: "key", ignoreDuplicates: true });
    if (insert.error) throw insert.error;
    result = await db.from("private_settings").select("value").eq("key", key).single();
    if (result.error) throw result.error;
  }
  return { ...JSON.parse(result.data.value), subject: "https://kortedoscdo.club" };
}

export async function sendPush(subscription: any, vapid: any, test = false, fetcher = fetch) {
  const safe = validateSubscription(subscription);
  const request = webpush.generateRequestDetails(safe, JSON.stringify({ type: test ? "test" : "payment-review" }), {
    vapidDetails: vapid, TTL: 300, urgency: "normal", topic: test ? "korte-dos-test" : "korte-dos-review",
  });
  const response = await fetcher(request.endpoint, {
    method: "POST", headers: request.headers, body: new Uint8Array(request.body),
    redirect: "error", signal: AbortSignal.timeout(10000),
  });
  await response.body?.cancel();
  if (response.status === 404 || response.status === 410) return { expired: true };
  if (!response.ok) throw new Error("Push provider rejected delivery");
  return { expired: false };
}
