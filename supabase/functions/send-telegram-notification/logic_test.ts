import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAuthoritativeTelegramAlert,
  escapeTelegramHtml,
  normalizeTelegramAlertEvent,
} from "./logic.ts";

const RECEIPT_HASH = "a".repeat(64);

function booking(overrides: Record<string, unknown> = {}) {
  return {
    ref: "PB-TEST-001",
    booking_group_ref: null,
    full_name: "Test Owner",
    contact_number: "09170000000",
    court_id: "court-1",
    court_name: "Court 1",
    date: "2026-08-07",
    slots: ["18", "19"],
    start_time: "6:00 PM",
    end_time: "8:00 PM",
    duration: 2,
    total: 500,
    downpayment: 250,
    payment_method: "gcash",
    payment_status: "pending",
    payment_provider: "gcash",
    gcash_ref: "1234567890123",
    status: "pending",
    receipt_status: "none",
    receipt_flags: [],
    receipt_image_url: null,
    receipt_image_hash: null,
    created_at: "2026-07-31T10:00:00.000Z",
    ...overrides,
  };
}

Deno.test("event normalization permits only the two pending verification events", () => {
  assertEquals(
    normalizeTelegramAlertEvent({ event: "new_booking" }),
    "new_booking",
  );
  assertEquals(
    normalizeTelegramAlertEvent({
      type: "booking_update",
      event: "payment_review_needed",
      bookingStatus: "confirmed",
    }),
    "payment_review_needed",
  );
  assertEquals(
    normalizeTelegramAlertEvent({
      type: "open_play",
      event: "new_booking",
    }),
    null,
  );
  assertEquals(
    normalizeTelegramAlertEvent({
      type: "booking_update",
      event: "booking_rescheduled",
    }),
    null,
  );
  assertEquals(
    normalizeTelegramAlertEvent({
      type: "booking_update",
      event: "payment_verified",
    }),
    null,
  );
});

Deno.test("valid pending court booking produces one authoritative alert", async () => {
  const alert = await buildAuthoritativeTelegramAlert(
    [booking({ host_booking: true })],
    "new_booking",
    "https://kortedoscdo.club/admin.html",
  );
  assert(alert);
  assertEquals(
    alert.eventKey,
    "telegram:pending-booking:v1:PB-TEST-001",
  );
  assertEquals(alert.bookingRef, "PB-TEST-001");
  assertMatch(alert.payloadDigest, /^[a-f0-9]{64}$/);
  assertStringIncludes(alert.message, "PENDING BOOKING");
  assertStringIncludes(alert.message, "Court 1");
  assertStringIncludes(
    alert.message,
    "section=payreview&amp;review=PB-TEST-001",
  );
});

Deno.test("browser-forged status cannot override authoritative booking state", async () => {
  assertEquals(
    normalizeTelegramAlertEvent({
      event: "new_booking",
      bookingStatus: "pending",
    }),
    "new_booking",
  );
  const alert = await buildAuthoritativeTelegramAlert(
    [booking({ status: "confirmed" })],
    "new_booking",
    "https://kortedoscdo.club/admin.html",
  );
  assertEquals(alert, null);
});

Deno.test("a partially transitioned booking group is denied", async () => {
  const rows = [
    booking({
      ref: "PB-GROUP-1-A",
      booking_group_ref: "PB-GROUP-1",
    }),
    booking({
      ref: "PB-GROUP-1-B",
      booking_group_ref: "PB-GROUP-1",
      court_id: "court-2",
      court_name: "Court 2",
      status: "confirmed",
    }),
  ];
  assertEquals(
    await buildAuthoritativeTelegramAlert(
      rows,
      "new_booking",
      "https://kortedoscdo.club/admin.html",
    ),
    null,
  );
});

Deno.test("payment review requires stored evidence on every active group row", async () => {
  const valid = booking({
    payment_status: "for_verification",
    receipt_status: "manual_review",
    receipt_image_url: "receipts/PB-TEST-001/hash.jpg",
    receipt_image_hash: RECEIPT_HASH,
    receipt_flags: ["AMOUNT_REVIEW"],
  });
  const alert = await buildAuthoritativeTelegramAlert(
    [valid],
    "payment_review_needed",
    "https://kortedoscdo.club/admin.html",
  );
  assert(alert);
  assertStringIncludes(alert.message, "PAYMENT NEEDS VERIFICATION");
  assertStringIncludes(alert.message, "AMOUNT_REVIEW");

  const missingEvidence = await buildAuthoritativeTelegramAlert(
    [{ ...valid, receipt_image_url: "" }],
    "payment_review_needed",
    "https://kortedoscdo.club/admin.html",
  );
  assertEquals(missingEvidence, null);
});

Deno.test("new receipt evidence creates a distinct review event key", async () => {
  const first = await buildAuthoritativeTelegramAlert(
    [booking({
      payment_status: "for_verification",
      receipt_status: "rejected",
      receipt_image_url: "receipts/first.jpg",
      receipt_image_hash: "a".repeat(64),
    })],
    "payment_review_needed",
    "https://kortedoscdo.club/admin.html",
  );
  const second = await buildAuthoritativeTelegramAlert(
    [booking({
      payment_status: "for_verification",
      receipt_status: "rejected",
      receipt_image_url: "receipts/second.jpg",
      receipt_image_hash: "b".repeat(64),
    })],
    "payment_review_needed",
    "https://kortedoscdo.club/admin.html",
  );
  assert(first);
  assert(second);
  assertNotEquals(first.eventKey, second.eventKey);
});

Deno.test("generic pending alert is suppressed once receipt review begins", async () => {
  const alert = await buildAuthoritativeTelegramAlert(
    [booking({
      payment_status: "for_verification",
      receipt_status: "manual_review",
      receipt_image_url: "receipts/review.jpg",
      receipt_image_hash: RECEIPT_HASH,
    })],
    "new_booking",
    "https://kortedoscdo.club/admin.html",
  );
  assertEquals(alert, null);
});

Deno.test("mixed group identities and terminal-only rows are rejected", async () => {
  assertEquals(
    await buildAuthoritativeTelegramAlert(
      [
        booking({ ref: "PB-A", booking_group_ref: "GROUP-A" }),
        booking({ ref: "PB-B", booking_group_ref: "GROUP-B" }),
      ],
      "new_booking",
      "https://kortedoscdo.club/admin.html",
    ),
    null,
  );
  assertEquals(
    await buildAuthoritativeTelegramAlert(
      [booking({ status: "cancelled" })],
      "new_booking",
      "https://kortedoscdo.club/admin.html",
    ),
    null,
  );
});

Deno.test("all Telegram HTML fields are escaped", async () => {
  assertEquals(
    escapeTelegramHtml(`<Owner & "Court">`),
    '&lt;Owner &amp; "Court"&gt;',
  );
  const alert = await buildAuthoritativeTelegramAlert(
    [booking({
      full_name: "<script>alert(1)</script>",
      court_name: "Court & <One>",
      gcash_ref: "<bad>",
    })],
    "new_booking",
    "javascript:alert(1)",
  );
  assert(alert);
  assertEquals(alert.message.includes("<script>"), false);
  assertStringIncludes(alert.message, "&lt;script&gt;");
  assertStringIncludes(alert.message, "Court &amp; &lt;One&gt;");
  assertStringIncludes(alert.message, "https://kortedoscdo.club/admin.html");
});
