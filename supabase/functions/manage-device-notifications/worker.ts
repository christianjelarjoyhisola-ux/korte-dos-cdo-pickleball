// deno-lint-ignore-file no-explicit-any
import { loadVapid, sendPush } from "./push.ts";

export async function processTargets(db: any, env: (key: string) => string | undefined, transport = sendPush, fetcher = fetch) {
  const claimed = await db.rpc("claim_admin_notification_targets");
  if (claimed.error) throw claimed.error;
  const summary = { ok: true, claimed: claimed.data?.length || 0, sent: 0, failed: 0, expired: 0, skipped: 0 };
  let vapid: any;
  // Five parallel sends cap provider latency without unbounded fan-out.
  const rows = claimed.data || [];
  for (let start = 0; start < rows.length; start += 5) {
    await Promise.all(rows.slice(start, start + 5).map(async (row: any) => {
      try {
        // Recheck immediately before delivery: a reviewer may have cleared the queue.
        const pending = await db.rpc("pending_admin_review_keys");
        if (pending.error) throw pending.error;
        if (!pending.data?.length) {
          const release = await db.from("admin_notification_targets").update({ lease_until: null, lease_id: null, delivery_id: null }).eq("id", row.id).eq("lease_id", row.lease_id);
          if (release.error) throw release.error;
          summary.skipped++;
          return;
        }
        if (row.channel === "push") {
          const current = await db.from("admin_notification_targets").select("user_id").eq("id", row.id).eq("lease_id", row.lease_id).maybeSingle();
          if (current.error) throw current.error;
          const account = current.data && await db.from("accounts").select("role,status").eq("id", current.data.user_id).maybeSingle();
          if (account?.error) throw account.error;
          if (!account?.data || account.data.status !== "active" || !["owner", "court_owner"].includes(account.data.role)) {
            summary.skipped++;
            return;
          }
          vapid ||= await loadVapid(db);
          const result = await transport(row.subscription, vapid);
          if (result.expired) {
            const deleted = await db.from("admin_notification_targets").delete().eq("id", row.id).eq("lease_id", row.lease_id);
            if (deleted.error) throw deleted.error;
            summary.expired++;
            return;
          }
        } else {
          const setting = await db.from("private_settings").select("value").eq("key", "payment_review_notification_email").maybeSingle();
          if (setting.error) throw setting.error;
          if (!row.recipient || setting.data?.value !== row.recipient) {
            summary.skipped++;
            return;
          }
          const apiKey = env("RESEND_API_KEY");
          if (!apiKey) throw new Error("Email provider is not configured");
          const response = await fetcher("https://api.resend.com/emails", {
            method: "POST", signal: AbortSignal.timeout(10000),
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `review-reminder:${row.delivery_id}` },
            body: JSON.stringify({ from: env("EMAIL_FROM") || "KORTE DOS <onboarding@resend.dev>", to: [row.recipient],
              subject: "Korte DOS — payment review reminder",
              text: "Payments are still awaiting review. Sign in securely to review them: https://kortedoscdo.club/admin?section=payreview\n\nManage email alerts in Admin → Notifications. This reminder does not approve or reject any payment." }),
          });
          await response.body?.cancel();
          if (!response.ok) throw new Error("Email provider rejected delivery");
        }
        const saved = await db.from("admin_notification_targets").update({ last_sent_at: new Date().toISOString(),
          last_keys: pending.data, last_recipient: row.recipient, lease_until: null, lease_id: null, delivery_id: null,
          next_attempt_at: new Date().toISOString() }).eq("id", row.id).eq("lease_id", row.lease_id);
        if (saved.error) throw saved.error;
        summary.sent++;
      } catch {
        summary.failed++;
        // Keep delivery_id stable on retry for email-provider idempotency.
        await db.from("admin_notification_targets").update({ lease_until: null, lease_id: null,
          next_attempt_at: new Date(Date.now() + 300000).toISOString() }).eq("id", row.id).eq("lease_id", row.lease_id);
      }
    }));
  }
  summary.ok = summary.failed === 0;
  return summary;
}
