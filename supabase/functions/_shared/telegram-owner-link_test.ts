// deno-lint-ignore-file require-await

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  claimTelegramNotificationDelivery,
  deriveTelegramWebhookSecret,
  extractTelegramLinkCode,
  finalizeTelegramNotificationDelivery,
  generateTelegramLinkCode,
  handleTelegramOwnerLinkRequest,
  normalizeTelegramLinkCode,
  registerTelegramOwnerLinkWebhook,
  resolveTelegramOwnerChatIds,
  sha256Hex,
  timingSafeEqual,
  type TelegramOwnerLinkDb,
} from "./telegram-owner-link.ts";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

function mockDb(options: {
  rpc?: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code?: string } | null }>;
  authenticated?: boolean;
} = {}): TelegramOwnerLinkDb {
  return {
    auth: {
      getUser: async () => ({
        data: {
          user: options.authenticated === false ? null : { id: ACTOR_ID },
        },
        error: options.authenticated === false ? { code: "401" } : null,
      }),
    },
    rpc: options.rpc ||
      (async () => ({ data: null, error: null })),
  };
}

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://example.test/functions/v1/send-telegram-notification", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

Deno.test("connection codes normalize and parse both supported Telegram forms", () => {
  assertEquals(
    normalizeTelegramLinkCode("  korte-new-bot-skr  "),
    "KORTE-NEW-BOT-SKR",
  );
  assertEquals(
    extractTelegramLinkCode("/start KORTE-NEW-BOT-SKR"),
    "KORTE-NEW-BOT-SKR",
  );
  assertEquals(
    extractTelegramLinkCode("/start@KorteDosAlertsBot korte-new-bot-skr"),
    "KORTE-NEW-BOT-SKR",
  );
  assertEquals(
    extractTelegramLinkCode("KORTE-NEW-BOT-SKR"),
    "KORTE-NEW-BOT-SKR",
  );
  assertEquals(extractTelegramLinkCode("/start"), null);
  assertEquals(extractTelegramLinkCode("contains spaces"), null);
});

Deno.test("generated codes are high-entropy-shaped and do not expose ambiguous characters", () => {
  let offset = 0;
  const first = generateTelegramLinkCode((bytes) => {
    bytes.forEach((_, index) => {
      bytes[index] = (index + offset) & 255;
    });
    offset += 7;
  });
  const second = generateTelegramLinkCode((bytes) => {
    bytes.forEach((_, index) => {
      bytes[index] = (index + offset) & 255;
    });
  });
  assertMatch(
    first,
    /^KORTE-[A-HJ-NP-Z2-9]{5}(?:-[A-HJ-NP-Z2-9]{5}){3}$/,
  );
  assertNotEquals(first, second);
});

Deno.test("digest and webhook secret derivation are deterministic and separated", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const secret = await deriveTelegramWebhookSecret("123:BOT_TOKEN");
  assertMatch(secret, /^[0-9a-f]{64}$/);
  assertNotEquals(secret, await sha256Hex("123:BOT_TOKEN"));
  assert(timingSafeEqual(secret, secret));
  assertEquals(timingSafeEqual(secret, `${secret}0`), false);
  assertEquals(timingSafeEqual(secret, secret.replace(/^./, "0")), false);
});

Deno.test("webhook registration uses the current function slug and secret header", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}"));
    calls.push({ url, body });
    if (url.endsWith("/getMe")) {
      return Response.json({
        ok: true,
        result: { username: "KorteDosAlertsBot" },
      });
    }
    return Response.json({ ok: true, result: true });
  };

  const registration = await registerTelegramOwnerLinkWebhook({
    botToken: "123:BOT_TOKEN",
    configuredSecret: "configured_secret",
    supabaseUrl: "https://project.supabase.co/",
    fetch: fakeFetch,
  });

  assertEquals(registration.botUsername, "KorteDosAlertsBot");
  assertEquals(
    registration.webhookUrl,
    "https://project.supabase.co/functions/v1/send-telegram-notification",
  );
  assertEquals(calls.length, 2);
  assertStringIncludes(calls[1].url, "/setWebhook");
  assertEquals(calls[1].body.secret_token, "configured_secret");
  assertEquals(calls[1].body.url, registration.webhookUrl);
  assertEquals(calls[1].body.drop_pending_updates, false);
});

Deno.test("ordinary notification requests are left untouched", async () => {
  const request = jsonRequest({
    type: "booking",
    bookingRef: "KD-1",
  });
  const result = await handleTelegramOwnerLinkRequest(request);
  assertEquals(result, null);
  assertEquals((await request.json()).bookingRef, "KD-1");
});

Deno.test("admin create_code stores only a digest and returns the one-time start link", async () => {
  const rpcCalls: Array<{
    name: string;
    args?: Record<string, unknown>;
  }> = [];
  const db = mockDb({
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "create_telegram_owner_link_code") {
        return {
          data: {
            id: "33333333-3333-4333-8333-333333333333",
            targetUserId: TARGET_ID,
            expiresAt: "2026-08-07T12:00:00.000Z",
          },
          error: null,
        };
      }
      return { data: { revoked: true }, error: null };
    },
  });
  const telegramCalls: Array<{
    url: string;
    body: Record<string, unknown>;
  }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}"));
    telegramCalls.push({ url, body });
    return url.endsWith("/getMe")
      ? Response.json({
        ok: true,
        result: { username: "KorteDosAlertsBot" },
      })
      : Response.json({ ok: true, result: true });
  };

  const response = await handleTelegramOwnerLinkRequest(
    jsonRequest({
      api: "telegram_owner_link",
      action: "create_code",
      targetAccountId: TARGET_ID,
    }, { authorization: "Bearer owner-jwt" }),
    {
      env: (name) => ({
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "anon-key",
        TELEGRAM_BOT_TOKEN: "123:BOT_TOKEN",
        TELEGRAM_WEBHOOK_SECRET: "configured_secret",
      })[name],
      createDb: () => db,
      fetch: fakeFetch,
      fillRandom: (bytes) => bytes.fill(0),
    },
  );

  assert(response);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(
    body.code,
    "KORTE-AAAAA-AAAAA-AAAAA-AAAAA",
  );
  assertEquals(body.botUsername, "KorteDosAlertsBot");
  assertEquals(
    body.startLink,
    "https://t.me/KorteDosAlertsBot?start=KORTE-AAAAA-AAAAA-AAAAA-AAAAA",
  );
  assertEquals(body.expiresAt, "2026-08-07T12:00:00.000Z");
  assertEquals(rpcCalls[0].name, "create_telegram_owner_link_code");
  assertEquals(
    rpcCalls[0].args?.p_code_digest,
    await sha256Hex(body.code),
  );
  assertNotEquals(rpcCalls[0].args?.p_code_digest, body.code);
  assertEquals(telegramCalls.length, 2);
});

Deno.test("admin list exposes separate candidate and connection collections", async () => {
  const db = mockDb({
    rpc: async () => ({
      data: [{
        userId: TARGET_ID,
        fullName: "Court Owner",
        email: "court@example.test",
        role: "court_owner",
        accountStatus: "active",
        eligible: true,
        connected: true,
        telegramChatId: 123456789,
        telegramUsername: "courtowner",
        connectedAt: "2026-07-31T12:00:00.000Z",
      }],
      error: null,
    }),
  });

  const response = await handleTelegramOwnerLinkRequest(
    jsonRequest({
      api: "telegram_owner_link",
      action: "list",
    }, { authorization: "Bearer owner-jwt" }),
    {
      env: (name) => ({
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "anon-key",
      })[name],
      createDb: () => db,
    },
  );

  assert(response);
  const body = await response.json();
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  assertStringIncludes(
    response.headers.get("access-control-allow-headers") || "",
    "authorization",
  );
  assertEquals(
    response.headers.get("access-control-allow-methods"),
    "POST, OPTIONS",
  );
  assertEquals(body.candidates.length, 1);
  assertEquals(body.candidates[0].accountId, TARGET_ID);
  assertEquals(body.connections.length, 1);
  assertEquals(body.connections[0].telegramChatId, "123456789");
});

for (
  const [input, expectedStatus, expectedText] of [
    [
      "/start KORTE-ABCDE-FGHJK-MNPQR-STUVW",
      "success",
      "Connected successfully",
    ],
    [
      "KORTE-ABCDE-FGHJK-MNPQR-STUVW",
      "already_used",
      "already been used",
    ],
    [
      "KORTE-ABCDE-FGHJK-MNPQR-STUVW",
      "expired",
      "has expired",
    ],
    [
      "KORTE-NEW-BOT-SKR",
      "invalid",
      "is invalid",
    ],
  ] as const
) {
  Deno.test(`webhook accepts code text and sends a safe ${expectedStatus} reply`, async () => {
    const rpcCalls: Array<{
      name: string;
      args?: Record<string, unknown>;
    }> = [];
    const db = mockDb({
      rpc: async (name, args) => {
        rpcCalls.push({ name, args });
        return { data: { status: expectedStatus }, error: null };
      },
    });
    const sent: Array<Record<string, unknown>> = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body || "{}")));
      return Response.json({
        ok: true,
        result: { message_id: 90 },
      });
    };

    const response = await handleTelegramOwnerLinkRequest(
      jsonRequest({
        update_id: 1,
        message: {
          message_id: 2,
          text: input,
          chat: { id: 987654321, type: "private" },
          from: {
            id: 987654321,
            is_bot: false,
            username: "owner_name",
            first_name: "Owner",
            last_name: "Name",
            language_code: "en",
          },
        },
      }, { "x-telegram-bot-api-secret-token": "configured_secret" }),
      {
        env: (name) => ({
          SUPABASE_URL: "https://project.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-key",
          TELEGRAM_BOT_TOKEN: "123:BOT_TOKEN",
          TELEGRAM_WEBHOOK_SECRET: "configured_secret",
        })[name],
        createDb: () => db,
        fetch: fakeFetch,
      },
    );

    assert(response);
    assertEquals(response.status, 200);
    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0].name, "consume_telegram_owner_link_code");
    assertEquals(
      rpcCalls[0].args?.p_code_digest,
      await sha256Hex(extractTelegramLinkCode(input)!),
    );
    assertEquals(rpcCalls[0].args?.p_telegram_chat_id, "987654321");
    assertEquals(sent.length, 1);
    assertStringIncludes(String(sent[0].text), expectedText);
    assertEquals(JSON.stringify(sent[0]).includes(TARGET_ID), false);
  });
}

Deno.test("/start without a code gives instructions and does not consume anything", async () => {
  let rpcCalled = false;
  const db = mockDb({
    rpc: async () => {
      rpcCalled = true;
      return { data: null, error: null };
    },
  });
  const sent: Array<Record<string, unknown>> = [];
  const response = await handleTelegramOwnerLinkRequest(
    jsonRequest({
      message: {
        text: "/start",
        chat: { id: 987654321, type: "private" },
        from: { id: 987654321, first_name: "Owner" },
      },
    }, { "x-telegram-bot-api-secret-token": "configured_secret" }),
    {
      env: (name) => ({
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-key",
        TELEGRAM_BOT_TOKEN: "123:BOT_TOKEN",
        TELEGRAM_WEBHOOK_SECRET: "configured_secret",
      })[name],
      createDb: () => db,
      fetch: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body || "{}")));
        return Response.json({ ok: true, result: { message_id: 1 } });
      },
    },
  );

  assert(response);
  assertEquals(response.status, 200);
  assertEquals(rpcCalled, false);
  assertEquals(sent.length, 1);
  assertStringIncludes(String(sent[0].text), "/start followed by the code");
});

Deno.test("webhook rejects a bad Telegram secret before database access", async () => {
  let databaseCreated = false;
  let fetched = false;
  const response = await handleTelegramOwnerLinkRequest(
    jsonRequest({
      message: {
        text: "KORTE-NEW-BOT-SKR",
        chat: { id: 123, type: "private" },
        from: { id: 123 },
      },
    }, { "x-telegram-bot-api-secret-token": "wrong_secret" }),
    {
      env: (name) => ({
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-key",
        TELEGRAM_BOT_TOKEN: "123:BOT_TOKEN",
        TELEGRAM_WEBHOOK_SECRET: "configured_secret",
      })[name],
      createDb: () => {
        databaseCreated = true;
        return mockDb();
      },
      fetch: async () => {
        fetched = true;
        return Response.json({ ok: true });
      },
    },
  );

  assert(response);
  assertEquals(response.status, 401);
  assertEquals(databaseCreated, false);
  assertEquals(fetched, false);
});

Deno.test("recipient resolution combines, validates, and deduplicates chat IDs", async () => {
  const db = mockDb({
    rpc: async () => ({
      data: [
        { telegram_chat_id: 200 },
        { telegram_chat_id: "300" },
        { telegram_chat_id: 100 },
      ],
      error: null,
    }),
  });
  assertEquals(
    await resolveTelegramOwnerChatIds(db, "100, invalid, -50"),
    ["100", "-50", "200", "300"],
  );
});

Deno.test("delivery wrappers preserve claim tokens and generic finalization state", async () => {
  const calls: string[] = [];
  const db = mockDb({
    rpc: async (name) => {
      calls.push(name);
      if (name === "claim_telegram_notification_delivery") {
        return {
          data: {
            claimed: true,
            status: "sending",
            deliveryId: "33333333-3333-4333-8333-333333333333",
            claimToken: "44444444-4444-4444-8444-444444444444",
            attemptCount: 1,
          },
          error: null,
        };
      }
      return {
        data: { updated: true, status: "sent" },
        error: null,
      };
    },
  });

  const claim = await claimTelegramNotificationDelivery(db, {
    eventKey: "booking:KD-1:pending",
    chatId: 100,
    payloadDigest: "a".repeat(64),
  });
  assertEquals(claim.claimed, true);
  assert(claim.deliveryId);
  assert(claim.claimToken);
  const final = await finalizeTelegramNotificationDelivery(db, {
    deliveryId: claim.deliveryId,
    claimToken: claim.claimToken,
    succeeded: true,
    telegramMessageId: 91,
  });
  assertEquals(final, { updated: true, status: "sent", retryAt: undefined });
  assertEquals(calls, [
    "claim_telegram_notification_delivery",
    "finalize_telegram_notification_delivery",
  ]);
});
