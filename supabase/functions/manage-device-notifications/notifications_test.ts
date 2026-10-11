// deno-lint-ignore-file no-explicit-any
import { handle } from "./index.ts";
import { validateSubscription, validEndpoint, sendPush } from "./push.ts";
import { processTargets } from "./worker.ts";
import webpush from "npm:web-push@3.6.7";
import { createECDH } from "node:crypto";
import { strict as assert } from "node:assert";

function fixture(options: any = {}) {
  const updates: any[] = [], deletions: any[] = [], filters: any[] = [];
  const row = { id: "target", channel: "push", user_id: "owner-1", lease_id: "lease", subscription: {}, pending_keys: ["b:1"], delivery_id: "delivery" };
  const db = {
    auth: { getUser: async () => options.noUser ? { error: true } : { data: { user: { id: "owner-1" } } } },
    rpc: async (name: string) => name === "claim_admin_notification_targets" ? { data: [row] } : { data: options.empty ? [] : ["b:1"] },
    from(table: string) {
      const result = table === "accounts" ? { data: { role: options.role || "owner", status: options.status || "active" } }
        : table === "private_settings" ? { data: { value: JSON.stringify(webpush.generateVAPIDKeys()) } }
        : { data: { id: "target", user_id: "owner-1", subscription: {} } };
      const chain: any = {
        select: () => chain, eq: (key: string, value: any) => { filters.push([key, value]); return chain; }, or: () => chain,
        maybeSingle: async () => result, single: async () => result,
        update: (value: any) => { updates.push(value); return chain; },
        upsert: (value: any) => { updates.push(value); return chain; },
        delete: () => { deletions.push(table); return chain; },
        then: (resolve: any) => resolve({ error: null }),
      };
      return chain;
    },
  };
  return { db, row, updates, deletions, filters };
}
const post = (body: any, auth = true) => new Request("https://example.com", { method: "POST", headers: auth ? { Authorization: "Bearer test" } : {}, body: JSON.stringify(body) });

Deno.test("subscription endpoints reject private hosts, forged suffixes and credentials", () => {
  for (const url of ["https://127.0.0.1/push", "https://fcm.googleapis.com.attacker.example/push", "http://fcm.googleapis.com/push", "https://u:p@fcm.googleapis.com/push", "https://fcm.googleapis.com:8443/push", "https://example.com/push"]) assert.throws(() => validEndpoint(url));
  for (const url of ["https://fcm.googleapis.com/fcm/send/a", "https://web.push.apple.com/a", "https://updates.push.services.mozilla.com/wpush/v2/a", "https://a.wns.windows.com/a"]) assert.equal(validEndpoint(url), url);
  assert.throws(() => validateSubscription({ endpoint: "https://fcm.googleapis.com/a", keys: {} }));
});
Deno.test("management requires a signed-in active owner and rejects unknown actions", async () => {
  assert.equal((await handle(post({ action: "get" }, false), fixture().db)).status, 401);
  assert.equal((await handle(post({ action: "get" }), fixture({ noUser: true }).db)).status, 401);
  for (const options of [{ role: "staff" }, { role: "host" }, { status: "disabled" }]) assert.equal((await handle(post({ action: "get" }), fixture(options).db)).status, 403);
  assert.equal((await handle(post({ action: "unknown" }), fixture().db)).status, 400);
});
Deno.test("worker rejects user bearer auth without the private scheduler secret", async () => {
  assert.equal((await handle(post({ action: "process" }), fixture().db)).status, 401);
});
Deno.test("status exposes only the public key; unsubscribe is scoped to the current owner", async () => {
  const f = fixture();
  const response = await (await handle(post({ action: "get" }), f.db)).json();
  assert.ok(response.publicKey); assert.equal(response.privateKey, undefined);
  assert.equal(JSON.stringify(response).includes("privateKey"), false);
  assert.equal((await handle(post({ action: "unsubscribe", endpoint: "https://fcm.googleapis.com/test" }), f.db)).status, 200);
  assert.ok(f.filters.some(([k, v]) => k === "user_id" && v === "owner-1"));
});
Deno.test("resolved queues suppress delivery and release the lease", async () => {
  const f = fixture({ empty: true }); let calls = 0;
  const result = await processTargets(f.db, () => undefined, async () => { calls++; return { expired: false }; });
  assert.equal(calls, 0); assert.equal(result.skipped, 1); assert.equal(f.updates[0].lease_id, null);
});
Deno.test("revoked account access suppresses already claimed push", async () => {
  const f = fixture({ role: "staff" }); let calls = 0;
  const result = await processTargets(f.db, () => undefined, async () => { calls++; return { expired: false }; });
  assert.equal(calls, 0); assert.equal(result.skipped, 1);
});
Deno.test("successful delivery advances the snapshot and clears the lease", async () => {
  const f = fixture();
  const result = await processTargets(f.db, () => undefined, async () => ({ expired: false }));
  assert.equal(result.sent, 1); assert.deepEqual(f.updates[0].last_keys, ["b:1"]);
  assert.equal(f.updates[0].lease_id, null); assert.equal(f.updates[0].delivery_id, null);
});
Deno.test("expired endpoints are removed; temporary failures keep their retry identity", async () => {
  const expired = fixture();
  const result = await processTargets(expired.db, () => undefined, async () => ({ expired: true }));
  assert.equal(result.expired, 1); assert.deepEqual(expired.deletions, ["admin_notification_targets"]);
  const failed = fixture();
  const failure = await processTargets(failed.db, () => undefined, async () => { throw Error("provider down"); });
  assert.equal(failure.failed, 1); assert.equal(failure.ok, false);
  assert.ok(Date.parse(failed.updates[0].next_attempt_at) > Date.now());
  assert.equal(failed.updates[0].delivery_id, undefined);
});
Deno.test("push transport encrypts payload, bounds TTL, and handles expiration without redirects", async () => {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const subscription = { endpoint: "https://fcm.googleapis.com/test", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: "AAAAAAAAAAAAAAAAAAAAAA" } };
  let seen: any;
  const transport = (async (_url: any, init: any) => { seen = init; return new Response(null, { status: 201 }); }) as typeof fetch;
  const result = await sendPush(subscription, { ...webpush.generateVAPIDKeys(), subject: "https://kortedoscdo.club" }, false, transport);
  assert.equal(result.expired, false); assert.equal(seen.redirect, "error"); assert.equal(Number(seen.headers.TTL), 300);
  assert.equal(seen.headers["Content-Encoding"], "aes128gcm");
  assert.equal(new TextDecoder().decode(seen.body).includes("payment-review"), false);
  const gone = await sendPush(subscription, { ...webpush.generateVAPIDKeys(), subject: "https://kortedoscdo.club" }, false, (async () => new Response(null, { status: 410 })) as typeof fetch);
  assert.equal(gone.expired, true);
});
