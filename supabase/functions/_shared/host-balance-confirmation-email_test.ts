import {
  buildHostBalanceConfirmationEmail,
  deliverHostBalanceConfirmation,
  hostBalanceConfirmationEvent,
} from "./host-balance-confirmation-email.ts";
import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

const payment = {
  id: "1be1b2a7-a81f-4f36-ae97-75ca686f2b75",
  verification_ref: "HBAL-686C57CF1D5E4CB58F9A8E82208076E0",
  booking_ref: "PB-MS99IHMJ-6L7C",
  booking_group_ref: "PB-MS99IHMJ-MYYP-G",
  booking_refs: ["PB-MS99IHMJ-6L7C"],
  status: "approved",
  total_amount: 3090,
  expected_amount: 2250,
  payment_provider: "maya",
  payment_reference: "2352B5D24C94",
  customer_name: "Ana <Palacio>",
  customer_email: "ana@example.com",
  approved_at: "2026-08-31T10:28:53+08:00",
};

const booking = {
  ref: "PB-MS99IHMJ-6L7C",
  booking_group_ref: "PB-MS99IHMJ-MYYP-G",
  full_name: "Ana Palacio",
  email: "ana@example.com",
  court_name: "Court 1",
  date: "2026-09-05",
  start_time: "3:00 PM",
  end_time: "4:00 PM",
  duration: 1,
  total: 1030,
  downpayment: 1030,
  status: "confirmed",
  payment_status: "paid",
  confirmation_email_sent_at: null,
  confirmation_email_last_event: null,
};

Deno.test("builds a fully-paid balance confirmation without exposing the full reference", () => {
  const email = buildHostBalanceConfirmationEmail(payment, [booking]);
  assertEquals(email.subject, "Balance Payment Confirmed - PB-MS99IHMJ-MYYP-G | KORTE DOS");
  assertMatch(email.text, /₱2,250\.00/);
  assertMatch(email.text, /FULLY PAID/);
  assertMatch(email.text, /••••4C94/);
  assert(!email.text.includes("2352B5D24C94"));
  assertMatch(email.html, /Ana &lt;Palacio&gt;/);
  assertMatch(email.html, /FULLY PAID · NO BALANCE DUE/);
});

Deno.test("delivery records a stable balance-paid event and deduplicates the next call", async () => {
  const rows = [{ ...booking }];
  let sendCount = 0;
  const db = {
    from(table: string) {
      if (table === "host_booking_balance_payments") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: { ...payment }, error: null }),
        };
      }
      if (table === "bookings") {
        return {
          select() { return this; },
          update(values: Record<string, unknown>) {
            rows.forEach((row) => Object.assign(row, values));
            return this;
          },
          in: async () => ({ data: rows.map((row) => ({ ...row })), error: null }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
  const fetcher: typeof fetch = async (_input, init) => {
    sendCount += 1;
    const headers = new Headers(init?.headers);
    assertMatch(headers.get("Idempotency-Key") || "", /^payment-review-delivery:v1:/);
    return new Response(JSON.stringify({ id: "email-123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const first = await deliverHostBalanceConfirmation({
    db,
    resendApiKey: "re_test_1234567890",
    paymentId: payment.id,
    fetcher,
  });
  assertEquals(first.sent, true);
  assertEquals(rows[0].confirmation_email_last_event, hostBalanceConfirmationEvent(payment.id));

  const second = await deliverHostBalanceConfirmation({
    db,
    resendApiKey: "re_test_1234567890",
    paymentId: payment.id,
    fetcher,
  });
  assertEquals(second.deduplicated, true);
  assertEquals(sendCount, 1);
});
