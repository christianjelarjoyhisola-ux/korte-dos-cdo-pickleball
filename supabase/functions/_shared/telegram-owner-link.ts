import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const TELEGRAM_OWNER_LINK_API = "telegram_owner_link";
export const TELEGRAM_OWNER_LINK_FUNCTION_SLUG =
  "send-telegram-notification";

const WEBHOOK_SECRET_DOMAIN_SEPARATOR =
  ":korte-dos-cdo:telegram-owner-link:webhook-secret:v1";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PREFIX = "KORTE";
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type DbError = {
  code?: string;
  message?: string;
};

type RpcResult = {
  data: unknown;
  error: DbError | null;
};

export type TelegramOwnerLinkDb = {
  auth: {
    getUser: (jwt: string) => Promise<{
      data: { user: { id: string } | null };
      error: DbError | null;
    }>;
  };
  rpc: (
    functionName: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<RpcResult>;
};

export type TelegramRpcDb = Pick<TelegramOwnerLinkDb, "rpc">;

type CreateDb = (
  url: string,
  key: string,
  authorization?: string,
) => TelegramOwnerLinkDb;

type RandomFill = (bytes: Uint8Array) => void;

export type TelegramOwnerLinkDependencies = {
  env?: (name: string) => string | undefined;
  fetch?: typeof fetch;
  createDb?: CreateDb;
  fillRandom?: RandomFill;
};

type OwnerLinkAdminBody = {
  api?: unknown;
  action?: unknown;
  targetAccountId?: unknown;
  accountId?: unknown;
};

type TelegramUser = {
  id?: unknown;
  is_bot?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
  language_code?: unknown;
};

type TelegramMessage = {
  message_id?: unknown;
  text?: unknown;
  chat?: {
    id?: unknown;
    type?: unknown;
  };
  from?: TelegramUser;
};

type TelegramUpdate = {
  update_id?: unknown;
  message?: TelegramMessage;
};

type LinkRow = {
  userId?: unknown;
  fullName?: unknown;
  email?: unknown;
  role?: unknown;
  accountStatus?: unknown;
  eligible?: unknown;
  connected?: unknown;
  telegramChatId?: unknown;
  telegramUserId?: unknown;
  telegramUsername?: unknown;
  telegramFirstName?: unknown;
  telegramLastName?: unknown;
  telegramLanguageCode?: unknown;
  firstConnectedAt?: unknown;
  connectedAt?: unknown;
  updatedAt?: unknown;
  revokedAt?: unknown;
  pendingCodeCreatedAt?: unknown;
  pendingCodeExpiresAt?: unknown;
};

export type TelegramDeliveryClaim = {
  claimed: boolean;
  status: string;
  deliveryId?: string;
  claimToken?: string;
  attemptCount?: number;
  retryAt?: string;
};

function defaultCreateDb(
  url: string,
  key: string,
  authorization?: string,
): TelegramOwnerLinkDb {
  const client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    ...(authorization
      ? { global: { headers: { Authorization: authorization } } }
      : {}),
  });

  return {
    auth: {
      getUser: async (jwt: string) => {
        const { data, error } = await client.auth.getUser(jwt);
        return {
          data: {
            user: data.user ? { id: data.user.id } : null,
          },
          error,
        };
      },
    },
    rpc: async (
      functionName: string,
      args?: Record<string, unknown>,
    ) => {
      const { data, error } = await client.rpc(functionName, args);
      return { data, error };
    },
  };
}

function getEnv(
  dependencies: TelegramOwnerLinkDependencies,
  name: string,
): string {
  if (dependencies.env) {
    return String(dependencies.env(name) || "").trim();
  }
  return String(
    (typeof Deno !== "undefined" ? Deno.env.get(name) : "") ??
      "",
  ).trim();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableValue<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): T | undefined {
  return predicate(value) ? value : undefined;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function bearerToken(request: Request): string {
  const match = request.headers.get("authorization")?.match(
    /^Bearer\s+(.+)$/i,
  );
  return match?.[1]?.trim() || "";
}

function rpcObject(data: unknown): Record<string, unknown> {
  if (isRecord(data)) return data;
  if (Array.isArray(data) && isRecord(data[0])) return data[0];
  return {};
}

function linkRows(data: unknown): LinkRow[] {
  const rows = Array.isArray(data)
    ? data
    : (isRecord(data) && Array.isArray(data.links) ? data.links : []);
  return rows.filter(isRecord) as LinkRow[];
}

function safeTelegramId(value: unknown): string | null {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return String(value);
  }
  if (
    typeof value === "string" &&
    /^[1-9][0-9]{0,18}$/.test(value)
  ) {
    return value;
  }
  return null;
}

function cleanProfileText(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const cleaned = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) || 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("")
    .trim();
  return cleaned ? cleaned.slice(0, maximumLength) : null;
}

export function normalizeTelegramLinkCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{8,64}$/.test(normalized)) return null;
  return normalized;
}

export function extractTelegramLinkCode(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const start = trimmed.match(
    /^\/start(?:@[A-Za-z0-9_]{3,})?(?:\s+(.+))?$/i,
  );
  if (start) return normalizeTelegramLinkCode(start[1] || "");
  return normalizeTelegramLinkCode(trimmed);
}

export function generateTelegramLinkCode(
  fillRandom: RandomFill = (bytes) => {
    crypto.getRandomValues(bytes);
  },
): string {
  const bytes = new Uint8Array(20);
  fillRandom(bytes);
  const payload = Array.from(
    bytes,
    (byte) => CODE_ALPHABET[byte & 31],
  ).join("");
  return `${CODE_PREFIX}-${payload.slice(0, 5)}-${payload.slice(5, 10)}-${
    payload.slice(10, 15)
  }-${payload.slice(15, 20)}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function deriveTelegramWebhookSecret(
  botToken: string,
): Promise<string> {
  return await sha256Hex(botToken + WEBHOOK_SECRET_DOMAIN_SEPARATOR);
}

export async function resolveTelegramWebhookSecret(
  botToken: string,
  configuredSecret?: string,
): Promise<string> {
  const configured = String(configuredSecret || "").trim();
  const secret = configured ||
    await deriveTelegramWebhookSecret(botToken);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error("Invalid Telegram webhook secret configuration");
  }
  return secret;
}

export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const maximumLength = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

export function isTelegramOwnerLinkAdminBody(
  body: unknown,
): body is OwnerLinkAdminBody {
  return isRecord(body) && body.api === TELEGRAM_OWNER_LINK_API;
}

async function parseClonedJson(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

type TelegramApiEnvelope = {
  ok?: boolean;
  result?: unknown;
};

async function telegramApi(
  fetchImplementation: typeof fetch,
  botToken: string,
  method: string,
  payload?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImplementation(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    },
  );
  const envelope = await response.json().catch(() => ({})) as
    TelegramApiEnvelope;
  if (!response.ok || envelope.ok !== true) {
    throw new Error("Telegram API request failed");
  }
  return envelope.result;
}

export async function registerTelegramOwnerLinkWebhook(options: {
  botToken: string;
  configuredSecret?: string;
  supabaseUrl: string;
  fetch?: typeof fetch;
}): Promise<{
  botUsername: string;
  webhookUrl: string;
  secret: string;
}> {
  const fetchImplementation = options.fetch || fetch;
  const supabaseUrl = options.supabaseUrl.replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+/i.test(supabaseUrl)) {
    throw new Error("Invalid Supabase URL");
  }
  const webhookUrl =
    `${supabaseUrl}/functions/v1/${TELEGRAM_OWNER_LINK_FUNCTION_SLUG}`;
  const secret = await resolveTelegramWebhookSecret(
    options.botToken,
    options.configuredSecret,
  );

  const profile = await telegramApi(
    fetchImplementation,
    options.botToken,
    "getMe",
  );
  const botUsername = isRecord(profile)
    ? cleanProfileText(profile.username, 64)
    : null;
  if (!botUsername || !/^[A-Za-z0-9_]{3,64}$/.test(botUsername)) {
    throw new Error("Telegram bot username is unavailable");
  }

  await telegramApi(
    fetchImplementation,
    options.botToken,
    "setWebhook",
    {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    },
  );

  return { botUsername, webhookUrl, secret };
}

function adminListResponse(data: unknown): Response {
  const rows = linkRows(data);
  const candidates = rows.map((row) => ({
    accountId: optionalString(row.userId),
    fullName: optionalString(row.fullName),
    email: optionalString(row.email),
    role: optionalString(row.role),
    status: optionalString(row.accountStatus),
    eligible: nullableValue(row.eligible, isBoolean) ?? false,
    ...(optionalString(row.pendingCodeCreatedAt)
      ? { pendingCodeCreatedAt: optionalString(row.pendingCodeCreatedAt) }
      : {}),
    ...(optionalString(row.pendingCodeExpiresAt)
      ? { pendingCodeExpiresAt: optionalString(row.pendingCodeExpiresAt) }
      : {}),
  }));
  const connections = rows
    .filter((row) =>
      row.telegramChatId !== null && row.telegramChatId !== undefined
    )
    .map((row) => ({
      accountId: optionalString(row.userId),
      connected: nullableValue(row.connected, isBoolean) ?? false,
      telegramChatId: String(row.telegramChatId),
      ...(row.telegramUserId !== null && row.telegramUserId !== undefined
        ? { telegramUserId: String(row.telegramUserId) }
        : {}),
      ...(optionalString(row.telegramUsername)
        ? { telegramUsername: optionalString(row.telegramUsername) }
        : {}),
      ...(optionalString(row.telegramFirstName)
        ? { telegramFirstName: optionalString(row.telegramFirstName) }
        : {}),
      ...(optionalString(row.telegramLastName)
        ? { telegramLastName: optionalString(row.telegramLastName) }
        : {}),
      ...(optionalString(row.telegramLanguageCode)
        ? { telegramLanguageCode: optionalString(row.telegramLanguageCode) }
        : {}),
      ...(optionalString(row.firstConnectedAt)
        ? { firstConnectedAt: optionalString(row.firstConnectedAt) }
        : {}),
      ...(optionalString(row.connectedAt)
        ? { connectedAt: optionalString(row.connectedAt) }
        : {}),
      ...(optionalString(row.updatedAt)
        ? { updatedAt: optionalString(row.updatedAt) }
        : {}),
      ...(optionalString(row.revokedAt)
        ? { revokedAt: optionalString(row.revokedAt) }
        : {}),
    }));
  return json({ ok: true, candidates, connections });
}

function adminRpcError(action: string, error: DbError): Response {
  if (error.code === "42501") {
    return json({
      ok: false,
      error: "You are not allowed to manage Telegram owner links.",
    }, 403);
  }
  if (error.code === "22023" || error.code === "P0002") {
    return json({
      ok: false,
      error: action === "create_code"
        ? "Choose an active owner or court-owner account."
        : "The selected account is unavailable.",
    }, 400);
  }
  return json({
    ok: false,
    error: action === "list"
      ? "Telegram connections could not be loaded."
      : action === "create_code"
      ? "A Telegram connection code could not be created."
      : "The Telegram connection could not be revoked.",
  }, 500);
}

async function revokeGeneratedCodeQuietly(
  db: TelegramOwnerLinkDb,
  codeId: string | undefined,
): Promise<void> {
  if (!codeId) return;
  try {
    await db.rpc("revoke_telegram_owner_link_code", {
      p_code_id: codeId,
    });
  } catch {
    // The raw code is never returned if setup fails. A database-side failure
    // here still leaves a high-entropy, seven-day challenge rather than a
    // credential stored or logged by the function.
  }
}

async function handleAdminRequest(
  request: Request,
  body: OwnerLinkAdminBody,
  dependencies: TelegramOwnerLinkDependencies,
): Promise<Response> {
  const action = String(body.action || "");
  if (!["list", "create_code", "revoke"].includes(action)) {
    return json({ ok: false, error: "Unknown Telegram link action." }, 400);
  }

  const token = bearerToken(request);
  if (!token) {
    return json({ ok: false, error: "Sign in is required." }, 401);
  }

  const supabaseUrl = getEnv(dependencies, "SUPABASE_URL");
  const anonKey = getEnv(dependencies, "SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return json({
      ok: false,
      error: "Telegram linking is not configured.",
    }, 503);
  }

  const createDb = dependencies.createDb || defaultCreateDb;
  const authorization = `Bearer ${token}`;
  const db = createDb(supabaseUrl, anonKey, authorization);
  const auth = await db.auth.getUser(token);
  if (auth.error || !auth.data.user) {
    return json({ ok: false, error: "Sign in is required." }, 401);
  }

  if (action === "list") {
    const result = await db.rpc("list_telegram_owner_links", {
      p_target_user_id: null,
    });
    if (result.error) return adminRpcError(action, result.error);
    return adminListResponse(result.data);
  }

  if (action === "revoke") {
    const accountId = body.accountId === undefined ||
        body.accountId === null ||
        body.accountId === ""
      ? auth.data.user.id
      : body.accountId;
    if (!isUuid(accountId)) {
      return json({
        ok: false,
        error: "Choose a valid account.",
      }, 400);
    }
    const result = await db.rpc("revoke_telegram_owner_link", {
      p_target_user_id: accountId,
    });
    if (result.error) return adminRpcError(action, result.error);
    const value = rpcObject(result.data);
    return json({
      ok: true,
      accountId,
      connectionRevoked: value.connectionRevoked === true,
      codesRevoked: Number(value.codesRevoked || 0),
    });
  }

  const targetAccountId = body.targetAccountId === undefined ||
      body.targetAccountId === null ||
      body.targetAccountId === ""
    ? auth.data.user.id
    : body.targetAccountId;
  if (!isUuid(targetAccountId)) {
    return json({
      ok: false,
      error: "Choose a valid owner or court-owner account.",
    }, 400);
  }

  const botToken = getEnv(dependencies, "TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    return json({
      ok: false,
      error: "Telegram linking is not configured.",
    }, 503);
  }

  const rawCode = generateTelegramLinkCode(dependencies.fillRandom);
  const codeDigest = await sha256Hex(rawCode);
  const createResult = await db.rpc("create_telegram_owner_link_code", {
    p_code_digest: codeDigest,
    p_target_user_id: targetAccountId,
  });
  if (createResult.error) {
    return adminRpcError(action, createResult.error);
  }

  const created = rpcObject(createResult.data);
  const codeId = optionalString(created.id);

  let registration: Awaited<
    ReturnType<typeof registerTelegramOwnerLinkWebhook>
  >;
  try {
    registration = await registerTelegramOwnerLinkWebhook({
      botToken,
      configuredSecret: getEnv(dependencies, "TELEGRAM_WEBHOOK_SECRET"),
      supabaseUrl,
      fetch: dependencies.fetch,
    });
  } catch {
    await revokeGeneratedCodeQuietly(db, codeId);
    return json({
      ok: false,
      error: "Telegram linking could not be prepared. Please try again.",
    }, 502);
  }

  return json({
    ok: true,
    code: rawCode,
    targetAccountId,
    expiresAt: optionalString(created.expiresAt),
    botUsername: registration.botUsername,
    startLink: `https://t.me/${registration.botUsername}?start=${
      encodeURIComponent(rawCode)
    }`,
  });
}

type TelegramReplyStatus =
  | "success"
  | "expired"
  | "invalid"
  | "already_used"
  | "instructions";

const TELEGRAM_REPLY: Record<TelegramReplyStatus, string> = {
  success:
    "Connected successfully. You will now receive pending booking verification alerts from Korte Dos CDO.",
  expired:
    "This connection code has expired. Please ask an owner for a new code.",
  invalid:
    "This connection code is invalid. Please check it or ask an owner for a new code.",
  already_used:
    "This connection code has already been used. Please ask an owner for a new code.",
  instructions:
    "Send your connection code here, or send /start followed by the code. Ask an owner for a new code if you do not have one.",
};

function consumeStatus(
  data: unknown,
): Exclude<TelegramReplyStatus, "instructions"> {
  const value = rpcObject(data).status;
  return value === "success" ||
      value === "expired" ||
      value === "already_used"
    ? value
    : "invalid";
}

async function sendTelegramOwnerLinkReply(
  fetchImplementation: typeof fetch,
  botToken: string,
  chatId: string,
  status: TelegramReplyStatus,
): Promise<void> {
  await telegramApi(
    fetchImplementation,
    botToken,
    "sendMessage",
    {
      chat_id: chatId,
      text: TELEGRAM_REPLY[status],
      disable_web_page_preview: true,
    },
  );
}

async function handleWebhookRequest(
  request: Request,
  dependencies: TelegramOwnerLinkDependencies,
): Promise<Response> {
  const botToken = getEnv(dependencies, "TELEGRAM_BOT_TOKEN");
  const supabaseUrl = getEnv(dependencies, "SUPABASE_URL");
  const serviceRoleKey = getEnv(dependencies, "SERVICE_ROLE_KEY") ||
    getEnv(dependencies, "SUPABASE_SERVICE_ROLE_KEY");
  if (!botToken || !supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Webhook unavailable." }, 503);
  }

  let expectedSecret: string;
  try {
    expectedSecret = await resolveTelegramWebhookSecret(
      botToken,
      getEnv(dependencies, "TELEGRAM_WEBHOOK_SECRET"),
    );
  } catch {
    return json({ ok: false, error: "Webhook unavailable." }, 503);
  }
  const suppliedSecret =
    request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!suppliedSecret || !timingSafeEqual(suppliedSecret, expectedSecret)) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return json({ ok: false, error: "Invalid update." }, 400);
  }

  const message = update.message;
  if (!message || typeof message.text !== "string") {
    return json({ ok: true, ignored: true });
  }

  const chatId = safeTelegramId(message.chat?.id);
  const telegramUserId = safeTelegramId(message.from?.id);
  if (
    !chatId ||
    !telegramUserId ||
    chatId !== telegramUserId ||
    message.chat?.type !== "private" ||
    message.from?.is_bot === true
  ) {
    return json({ ok: true, ignored: true });
  }

  const fetchImplementation = dependencies.fetch || fetch;
  const code = extractTelegramLinkCode(message.text);
  if (!code) {
    const replyStatus: TelegramReplyStatus =
      /^\/start(?:@[A-Za-z0-9_]{3,})?\s*$/i.test(message.text.trim())
        ? "instructions"
        : "invalid";
    try {
      await sendTelegramOwnerLinkReply(
        fetchImplementation,
        botToken,
        chatId,
        replyStatus,
      );
    } catch {
      return json({ ok: false, error: "Reply unavailable." }, 502);
    }
    return json({ ok: true });
  }

  const createDb = dependencies.createDb || defaultCreateDb;
  const serviceDb = createDb(supabaseUrl, serviceRoleKey);
  const result = await serviceDb.rpc("consume_telegram_owner_link_code", {
    p_code_digest: await sha256Hex(code),
    p_telegram_chat_id: chatId,
    p_telegram_user_id: telegramUserId,
    p_chat_type: "private",
    p_telegram_username: cleanProfileText(message.from?.username, 64),
    p_telegram_first_name: cleanProfileText(
      message.from?.first_name,
      128,
    ),
    p_telegram_last_name: cleanProfileText(
      message.from?.last_name,
      128,
    ),
    p_telegram_language_code: cleanProfileText(
      message.from?.language_code,
      16,
    ),
  });
  const status = result.error ? "invalid" : consumeStatus(result.data);

  try {
    await sendTelegramOwnerLinkReply(
      fetchImplementation,
      botToken,
      chatId,
      status,
    );
  } catch {
    return json({ ok: false, error: "Reply unavailable." }, 502);
  }
  return json({ ok: true });
}

/**
 * Handles Telegram owner-link admin calls or authenticated Telegram webhook
 * updates. Returns null for ordinary notification payloads so the existing
 * send-telegram-notification handler can continue processing the request.
 */
export async function handleTelegramOwnerLinkRequest(
  request: Request,
  dependencies: TelegramOwnerLinkDependencies = {},
): Promise<Response | null> {
  if (request.method !== "POST") return null;

  if (request.headers.has("x-telegram-bot-api-secret-token")) {
    try {
      return await handleWebhookRequest(request, dependencies);
    } catch {
      return json({ ok: false, error: "Webhook unavailable." }, 503);
    }
  }

  const body = await parseClonedJson(request);
  if (!isTelegramOwnerLinkAdminBody(body)) return null;
  try {
    return await handleAdminRequest(request, body, dependencies);
  } catch {
    return json({
      ok: false,
      error: "Telegram owner links could not be updated.",
    }, 500);
  }
}

function addChatId(target: Set<string>, value: unknown): void {
  const text = String(value ?? "").trim();
  if (/^-?[1-9][0-9]{0,18}$/.test(text)) target.add(text);
}

/**
 * Merges legacy TELEGRAM_CHAT_ID recipients with active linked owners.
 * The supplied client must use the service role; the database RPC enforces it.
 */
export async function resolveTelegramOwnerChatIds(
  serviceDb: TelegramRpcDb,
  legacyChatIds: string | readonly (string | number)[] = [],
): Promise<string[]> {
  const recipients = new Set<string>();
  if (typeof legacyChatIds === "string") {
    legacyChatIds.split(",").forEach((value) => addChatId(recipients, value));
  } else {
    legacyChatIds.forEach((value) => addChatId(recipients, value));
  }

  const result = await serviceDb.rpc(
    "list_active_telegram_owner_chat_ids",
  );
  if (result.error) {
    throw new Error("Telegram recipients could not be loaded");
  }
  if (Array.isArray(result.data)) {
    for (const row of result.data) {
      if (isRecord(row)) addChatId(recipients, row.telegram_chat_id);
    }
  }
  return [...recipients];
}

export async function claimTelegramNotificationDelivery(
  serviceDb: TelegramRpcDb,
  options: {
    eventKey: string;
    chatId: string | number;
    payloadDigest?: string;
  },
): Promise<TelegramDeliveryClaim> {
  const result = await serviceDb.rpc(
    "claim_telegram_notification_delivery",
    {
      p_event_key: options.eventKey,
      p_telegram_chat_id: String(options.chatId),
      p_payload_digest: options.payloadDigest || null,
    },
  );
  if (result.error) {
    throw new Error("Telegram delivery could not be claimed");
  }
  const value = rpcObject(result.data);
  return {
    claimed: value.claimed === true,
    status: optionalString(value.status) || "unknown",
    deliveryId: optionalString(value.deliveryId),
    claimToken: optionalString(value.claimToken),
    attemptCount: typeof value.attemptCount === "number"
      ? value.attemptCount
      : undefined,
    retryAt: optionalString(value.retryAt),
  };
}

export async function finalizeTelegramNotificationDelivery(
  serviceDb: TelegramRpcDb,
  options: {
    deliveryId: string;
    claimToken: string;
    succeeded: boolean;
    telegramMessageId?: string | number;
    error?: string;
    retryAt?: string;
  },
): Promise<{ updated: boolean; status: string; retryAt?: string }> {
  const result = await serviceDb.rpc(
    "finalize_telegram_notification_delivery",
    {
      p_delivery_id: options.deliveryId,
      p_claim_token: options.claimToken,
      p_succeeded: options.succeeded,
      p_telegram_message_id: options.telegramMessageId === undefined
        ? null
        : String(options.telegramMessageId),
      p_error: options.error || null,
      p_retry_at: options.retryAt || null,
    },
  );
  if (result.error) {
    throw new Error("Telegram delivery could not be finalized");
  }
  const value = rpcObject(result.data);
  return {
    updated: value.updated === true,
    status: optionalString(value.status) || "unknown",
    retryAt: optionalString(value.retryAt),
  };
}
