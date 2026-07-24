import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPaymentReviewEmail,
  buildPaymentReviewTestEmail,
  buildPaymentReviewUrl,
  createPaymentReviewDedupeKey,
  createPaymentReviewDeliveryIdempotencyKey,
  maskPaymentReference,
  normalizePaymentReviewEmail,
  paymentReviewFlagLabel,
  sendPaymentReviewEmail,
  sendPaymentReviewTestEmail,
} from "./payment-review-email.ts";

const BASE_NOTIFICATION = {
  bookingRef: "KD-REVIEW-123",
  bookingGroupRef: "KD-GROUP-1",
  contextType: "court_booking" as const,
  receiptVerificationId: 91,
  fullName: "Player One",
  provider: "gcash",
  paymentReference: "9043190886590",
  imageHash: "a".repeat(64),
  flags: ["wrong_receiver_number"],
  expectedAmount: 720,
  extractedAmount: 720,
  courtLabel: "Court 2",
  scheduleLabel: "July 23, 2026 · 7:00 PM–9:00 PM",
};

Deno.test("notification email normalization accepts blank clears and rejects injection", () => {
  assertEquals(
    normalizePaymentReviewEmail("  OWNER+PAYMENTS@Example.COM "),
    "owner+payments@example.com",
  );
  assertEquals(normalizePaymentReviewEmail("  "), "");
  assertThrows(
    () =>
      normalizePaymentReviewEmail(
        "owner@example.com\r\nBcc: bad@example.com",
      ),
    Error,
    "valid notification email",
  );
  assertThrows(
    () => normalizePaymentReviewEmail("one;two@example.com"),
    Error,
    "valid notification email",
  );
});

Deno.test("technical verification flags become owner-friendly reasons", () => {
  assertEquals(
    paymentReviewFlagLabel("WRONG_GCASH_NUMBER"),
    "Receiver number needs checking",
  );
  assertEquals(
    paymentReviewFlagLabel("SESSION_CAPACITY_REVIEW"),
    "The session filled while this paid receipt was being checked",
  );
  assertEquals(
    paymentReviewFlagLabel("LEGACY_CLIENT_REVIEW"),
    "Submitted from an older booking page and needs an owner check",
  );
  assertEquals(
    paymentReviewFlagLabel("GOTYME_TRACE_ID_MISMATCH"),
    "GoTyme Trace ID does not match the Reference No.",
  );
});

Deno.test("payment review email escapes content and never exposes a full payment reference", () => {
  const paymentReference = "9043190886590";
  const email = buildPaymentReviewEmail({
    ...BASE_NOTIFICATION,
    fullName: `<img src=x onerror="alert(1)">`,
    courtLabel: "Court <Two>",
    scheduleLabel: "Tonight & tomorrow",
    paymentReference,
    flags: [`bad <script>alert("x")</script>`],
  });

  assertFalse(email.html.includes("<img src=x"));
  assertStringIncludes(email.html, "&lt;img src=x");
  assertStringIncludes(email.html, "Court &lt;Two&gt;");
  assertStringIncludes(email.html, "Tonight &amp; tomorrow");
  assertFalse(email.html.includes(paymentReference));
  assertFalse(email.text.includes(paymentReference));
  assertStringIncludes(email.html, maskPaymentReference(paymentReference));
  assertStringIncludes(email.text, maskPaymentReference(paymentReference));
});

Deno.test("payment review link targets the exact protected dashboard record", () => {
  assertEquals(
    buildPaymentReviewUrl(
      "https://kortedoscdo.club/admin.html#old-section",
      "PB-ABC_123",
    ),
    "https://kortedoscdo.club/admin.html?section=payreview&review=PB-ABC_123",
  );
  const email = buildPaymentReviewEmail(
    BASE_NOTIFICATION,
    "https://kortedoscdo.club/admin.html",
  );
  assertStringIncludes(
    email.text,
    "admin.html?section=payreview&review=KD-REVIEW-123",
  );
});

Deno.test("configuration test email has no fake booking or review action", async () => {
  const testEmail = buildPaymentReviewTestEmail();
  assertEquals(
    testEmail.subject,
    "Test — KORTE DOS payment review alerts",
  );
  assertStringIncludes(testEmail.text, "No booking exists");
  assertStringIncludes(testEmail.text, "no action is required");
  assertFalse(testEmail.html.includes("Open Payment Review"));
  assertFalse(testEmail.html.includes("EMAIL-TEST"));

  let requestBodyJson = "";
  const fetcher = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requestBodyJson = String(init?.body);
    return new Response(JSON.stringify({ id: "test_email_123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const result = await sendPaymentReviewTestEmail({
    resendApiKey: "re_test_1234567890",
    recipient: "owner@example.com",
    idempotencyKey: "payment-review-test:v1:" + "e".repeat(64),
    fetcher,
  });
  assertEquals(result, { providerMessageId: "test_email_123" });
  const sentBody = JSON.parse(requestBodyJson) as Record<string, unknown>;
  assertEquals(sentBody.subject, testEmail.subject);
});

Deno.test("payment review dedupe key is stable per context, group, reference, and image", async () => {
  const first = await createPaymentReviewDedupeKey(BASE_NOTIFICATION);
  const retry = await createPaymentReviewDedupeKey({
    ...BASE_NOTIFICATION,
    fullName: "A renamed player",
    flags: ["different display-only flag"],
  });
  const newImage = await createPaymentReviewDedupeKey({
    ...BASE_NOTIFICATION,
    imageHash: "b".repeat(64),
  });
  const newContext = await createPaymentReviewDedupeKey({
    ...BASE_NOTIFICATION,
    contextType: "host_session",
  });

  assertEquals(first, retry);
  assert(first.startsWith("payment-review:v1:"));
  assertFalse(first === newImage);
  assertFalse(first === newContext);
});

Deno.test("delivery idempotency is stable per saved recipient and rotates when it changes", async () => {
  const dedupeKey = await createPaymentReviewDedupeKey(BASE_NOTIFICATION);
  const first = await createPaymentReviewDeliveryIdempotencyKey(
    dedupeKey,
    "OWNER@Example.com",
  );
  const sameRecipient = await createPaymentReviewDeliveryIdempotencyKey(
    dedupeKey,
    " owner@example.com ",
  );
  const changedRecipient = await createPaymentReviewDeliveryIdempotencyKey(
    dedupeKey,
    "payments@example.com",
  );

  assertEquals(first, sameRecipient);
  assertFalse(first === changedRecipient);
  assertFalse(first.includes("owner@example.com"));
  assert(first.startsWith("payment-review-delivery:v1:"));
});

Deno.test("Resend request uses the saved recipient and a stable idempotency header", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ id: "email_123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await sendPaymentReviewEmail({
    resendApiKey: "re_test_1234567890",
    recipient: "owner@example.com",
    notification: BASE_NOTIFICATION,
    idempotencyKey: "payment-review:v1:" + "c".repeat(64),
    fromAddress: "KORTE DOS <payments@example.com>",
    adminUrl: "https://kortedoscdo.club/admin.html#payreview",
    fetcher,
  });

  assertEquals(result, { providerMessageId: "email_123" });
  assertEquals(requestUrl, "https://api.resend.com/emails");
  const headers = new Headers(requestInit?.headers);
  assertEquals(
    headers.get("Idempotency-Key"),
    "payment-review:v1:" + "c".repeat(64),
  );
  const body = JSON.parse(String(requestInit?.body));
  assertEquals(body.to, ["owner@example.com"]);
  assertFalse(
    JSON.stringify(body).includes(BASE_NOTIFICATION.paymentReference),
  );
});

Deno.test("non-retryable Resend failures are reported immediately", async () => {
  let attempts = 0;
  const fetcher = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ message: "bad request" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  await assertRejects(
    () =>
      sendPaymentReviewEmail({
        resendApiKey: "re_test_1234567890",
        recipient: "owner@example.com",
        notification: BASE_NOTIFICATION,
        idempotencyKey: "payment-review:v1:" + "d".repeat(64),
        fetcher,
      }),
    Error,
    "status 422",
  );
  assertEquals(attempts, 1);
});

Deno.test("transient Resend failures retry with the same idempotency key", async () => {
  const seenKeys: string[] = [];
  let attempts = 0;
  const fetcher = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    attempts += 1;
    seenKeys.push(new Headers(init?.headers).get("Idempotency-Key") || "");
    if (attempts < 3) {
      return new Response(JSON.stringify({ message: "temporary" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "email_after_retry" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const key = "payment-review:v1:" + "f".repeat(64);
  const result = await sendPaymentReviewEmail({
    resendApiKey: "re_test_1234567890",
    recipient: "owner@example.com",
    notification: BASE_NOTIFICATION,
    idempotencyKey: key,
    fetcher,
  });

  assertEquals(result, { providerMessageId: "email_after_retry" });
  assertEquals(attempts, 3);
  assertEquals(seenKeys, [key, key, key]);
});
