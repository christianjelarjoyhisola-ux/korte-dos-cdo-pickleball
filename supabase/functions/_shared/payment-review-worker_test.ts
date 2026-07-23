import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizePaymentReviewWorkerBatchSize,
  paymentReviewNotificationFromClaimedRow,
  paymentReviewWorkerSecretsMatch,
  processDuePaymentReviewNotifications,
} from "./payment-review-worker.ts";
import { createPaymentReviewDeliveryIdempotencyKey } from "./payment-review-email.ts";

class ResultBuilder {
  private selected = false;

  constructor(
    private readonly result: Record<string, unknown>,
    private readonly updates: Array<Record<string, unknown>>,
    private readonly updateValue?: Record<string, unknown>,
  ) {}

  select(): ResultBuilder {
    this.selected = true;
    return this;
  }

  eq(): ResultBuilder {
    return this;
  }

  maybeSingle(): Promise<Record<string, unknown>> {
    if (this.updateValue) {
      this.updates.push(this.updateValue);
      return Promise.resolve({
        data: this.selected ? { id: "delivery-1" } : null,
        error: null,
      });
    }
    return Promise.resolve(this.result);
  }

  then(
    resolve: (value: Record<string, unknown>) => unknown,
  ): Promise<unknown> {
    if (this.updateValue) this.updates.push(this.updateValue);
    return Promise.resolve(resolve({ error: null }));
  }
}

function fakeDb(options: {
  recipient: string;
  rows?: Array<Record<string, unknown>>;
}) {
  const updates: Array<Record<string, unknown>> = [];
  let rpcCalls = 0;
  return {
    updates,
    get rpcCalls() {
      return rpcCalls;
    },
    from(table: string) {
      if (table === "private_settings") {
        return new ResultBuilder({
          data: options.recipient ? { value: options.recipient } : null,
          error: null,
        }, updates);
      }
      if (table === "payment_review_notifications") {
        return {
          update(value: Record<string, unknown>) {
            return new ResultBuilder({}, updates, value);
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    rpc(name: string) {
      assertEquals(name, "claim_due_payment_review_notifications");
      rpcCalls += 1;
      return Promise.resolve({ data: options.rows || [], error: null });
    },
  };
}

const CLAIMED_ROW = {
  id: "delivery-1",
  dedupe_key: "payment-review:v1:" + "a".repeat(64),
  receipt_verification_id: 91,
  booking_ref: "PB-PRIVATE-123",
  booking_group_ref: "PB-GROUP-123",
  context_type: "court_booking",
  image_hash: "b".repeat(64),
  payment_provider: "gcash",
  payment_reference_masked: "••••6590",
  recipient_email: "old-owner@example.com",
  payload: {
    fullName: "Player One",
    flags: ["WRONG_GCASH_NUMBER"],
    expectedAmount: 720,
    extractedAmount: 720,
  },
  attempt_count: 2,
};

Deno.test("worker secret comparison is strict and batch size is bounded", () => {
  const secret = "a".repeat(64);
  assertEquals(paymentReviewWorkerSecretsMatch(secret, secret), true);
  assertFalse(paymentReviewWorkerSecretsMatch(`${secret}x`, secret));
  assertFalse(paymentReviewWorkerSecretsMatch("", ""));
  assertEquals(normalizePaymentReviewWorkerBatchSize(undefined), 20);
  assertEquals(normalizePaymentReviewWorkerBatchSize(0), 1);
  assertEquals(normalizePaymentReviewWorkerBatchSize(500), 50);
});

Deno.test("claimed rows reconstruct only a masked payment reference", () => {
  const notification = paymentReviewNotificationFromClaimedRow(CLAIMED_ROW);
  assertEquals(notification.bookingRef, "PB-PRIVATE-123");
  assertEquals(notification.paymentReference, "••••6590");
  assertFalse(JSON.stringify(notification).includes("9043190886590"));
});

Deno.test("blank saved recipient disables retries without claiming rows", async () => {
  const db = fakeDb({ recipient: "", rows: [CLAIMED_ROW] });
  let fetchCalls = 0;
  const summary = await processDuePaymentReviewNotifications({
    db,
    resendApiKey: "re_test_1234567890",
    fetcher: (async () => {
      fetchCalls += 1;
      return new Response();
    }) as typeof fetch,
  });

  assertEquals(summary, {
    ok: true,
    disabled: true,
    claimed: 0,
    sent: 0,
    failed: 0,
  });
  assertEquals(db.rpcCalls, 0);
  assertEquals(fetchCalls, 0);
});

Deno.test("retry sends to the current saved recipient with stable idempotency", async () => {
  const db = fakeDb({
    recipient: "new-owner@example.com",
    rows: [CLAIMED_ROW],
  });
  let requestBody = "";
  let idempotencyKey = "";
  const summary = await processDuePaymentReviewNotifications({
    db,
    resendApiKey: "re_test_1234567890",
    fetcher: (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestBody = String(init?.body || "");
      idempotencyKey = new Headers(init?.headers).get("Idempotency-Key") || "";
      return new Response(JSON.stringify({ id: "email_retry_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });

  assertEquals(summary, {
    ok: true,
    disabled: false,
    claimed: 1,
    sent: 1,
    failed: 0,
  });
  assertEquals(
    idempotencyKey,
    await createPaymentReviewDeliveryIdempotencyKey(
      CLAIMED_ROW.dedupe_key,
      "new-owner@example.com",
    ),
  );
  assertFalse(
    idempotencyKey ===
      await createPaymentReviewDeliveryIdempotencyKey(
        CLAIMED_ROW.dedupe_key,
        CLAIMED_ROW.recipient_email,
      ),
  );
  assertEquals(JSON.parse(requestBody).to, ["new-owner@example.com"]);
  assertFalse(requestBody.includes("9043190886590"));
  assertEquals(db.updates[0].status, "sent");
  assertEquals(db.updates[0].recipient_email, "new-owner@example.com");
});

Deno.test("failed retry is returned to durable backoff", async () => {
  const db = fakeDb({
    recipient: "owner@example.com",
    rows: [CLAIMED_ROW],
  });
  const summary = await processDuePaymentReviewNotifications({
    db,
    resendApiKey: "re_test_1234567890",
    fetcher: (async () =>
      new Response(JSON.stringify({ message: "invalid request" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
  });

  assertEquals(summary, {
    ok: false,
    disabled: false,
    claimed: 1,
    sent: 0,
    failed: 1,
  });
  assertEquals(db.updates[0].status, "failed");
  assertEquals(db.updates[0].recipient_email, "owner@example.com");
  assertEquals(typeof db.updates[0].next_attempt_at, "string");
});
