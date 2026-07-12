// deno-lint-ignore-file no-explicit-any no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ID_BYTES = 5 * 1024 * 1024;
const ALLOWED_ID_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

type SignupPayload = {
  action?: "signup" | "sign-valid-id" | "review" | "repair-activation";
  applicationId?: string;
  status?: "approved" | "rejected";
  reviewNote?: string;
  fullName?: string;
  contactNumber?: string;
  email?: string;
  password?: string;
  gcashNumber?: string;
  validIdBase64?: string;
  validIdFileName?: string;
  validIdFileType?: string;
  validIdFileSize?: number;
  notes?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clean(value: unknown) {
  return String(value || "").trim();
}

function errMsg(err: unknown) {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const maybe = err as Record<string, unknown>;
    if (typeof maybe.message === "string") return maybe.message;
    if (typeof maybe.error === "string") return maybe.error;
  }
  return String(err || "Unknown error");
}

function base64ToBytes(b64: string) {
  const comma = b64.indexOf(",");
  const raw = b64.startsWith("data:") && comma !== -1 ? b64.slice(comma + 1) : b64;
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function validPhone(value: string) {
  return /^(09|\+639)\d{9}$/.test(value.replace(/[\s-]/g, ""));
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeExt(fileName: string, contentType: string) {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && ["jpg", "jpeg", "png", "webp", "pdf"].includes(ext)) return ext;
  if (contentType === "application/pdf") return "pdf";
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

async function readJson(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function apiError(data: unknown, fallback: string) {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.msg === "string") return obj.msg;
  }
  return fallback;
}

function signupMeta(hostUserId: string, gcashNumber: string, reviewNote = "") {
  return JSON.stringify({ hostUserId, gcashNumber, reviewNote });
}

function parseSignupMeta(value: unknown) {
  if (typeof value !== "string" || !value.trim().startsWith("{")) {
    return { hostUserId: "", gcashNumber: "", reviewNote: "" };
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      hostUserId: typeof parsed.hostUserId === "string" ? parsed.hostUserId : "",
      gcashNumber: typeof parsed.gcashNumber === "string" ? parsed.gcashNumber : "",
      reviewNote: typeof parsed.reviewNote === "string" ? parsed.reviewNote : "",
    };
  } catch {
    return { hostUserId: "", gcashNumber: "", reviewNote: "" };
  }
}

type HostApplicationRecord = Record<string, unknown>;

type LoadedHostApplication = {
  app: HostApplicationRecord;
  legacySchema: boolean;
  meta: ReturnType<typeof parseSignupMeta>;
};

type ExistingAccount = {
  id: string;
  username: string;
  full_name: string;
  email: string;
  role: string;
  status: string;
  created_at: string | null;
};

class HostActivationError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "HostActivationError";
    this.status = status;
  }
}

function normalizedEmail(value: unknown) {
  return clean(value).toLowerCase();
}

// This standalone function has no generated Database type.
async function loadHostApplication(db: any, applicationId: string): Promise<LoadedHostApplication> {
  const modern = await db
    .from("open_play_host_applications")
    .select("id, host_user_id, full_name, email, gcash_number, status, review_note")
    .eq("id", applicationId)
    .single();

  let app = modern.data as HostApplicationRecord | null;
  let error = modern.error;
  let legacySchema = false;
  if (error && /host_user_id|gcash_number/i.test(error.message || "")) {
    legacySchema = true;
    const legacy = await db
      .from("open_play_host_applications")
      .select("id, full_name, email, status, review_note")
      .eq("id", applicationId)
      .single();
    app = legacy.data as HostApplicationRecord | null;
    error = legacy.error;
  }
  if (error || !app) throw new HostActivationError("Host application not found", 404);
  return { app, legacySchema, meta: parseSignupMeta(app.review_note) };
}

// Supabase Auth does not expose an exact-email admin lookup, so scan its
// paginated admin list and compare normalized emails exactly. This fallback is
// used only during owner-approved activation/repair, never public signup.
async function authUsersByExactEmail(db: any, email: string): Promise<Array<Record<string, unknown>>> {
  const matches: Array<Record<string, unknown>> = [];
  const perPage = 1000;
  let page = 1;

  while (true) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) throw new HostActivationError(`Could not search host Auth account: ${errMsg(error)}`);
    const users = Array.isArray(data?.users) ? data.users as Array<Record<string, unknown>> : [];
    for (const user of users) {
      if (normalizedEmail(user.email) === email) matches.push(user);
    }

    const nextPage = Number(data?.nextPage || 0);
    const lastPage = Number(data?.lastPage || page);
    if (!nextPage && page >= lastPage) break;
    const followingPage = nextPage || page + 1;
    if (followingPage <= page || page > 10000) {
      throw new HostActivationError("Could not safely finish Auth account lookup");
    }
    page = followingPage;
  }
  return matches;
}

async function resolveUniqueHostAuthUser(
  db: any,
  loaded: LoadedHostApplication,
): Promise<Record<string, unknown>> {
  const appEmail = normalizedEmail(loaded.app.email);
  if (!validEmail(appEmail)) throw new HostActivationError("Application email is invalid", 409);

  const modernId = clean(loaded.app.host_user_id);
  const legacyId = clean(loaded.meta.hostUserId);
  const linkedIds = [...new Set([modernId, legacyId].filter(Boolean))];
  if (linkedIds.length > 1) {
    throw new HostActivationError("Application has conflicting linked Auth accounts", 409);
  }

  let linkedUser: Record<string, unknown> | null = null;
  if (linkedIds[0]) {
    const { data, error } = await db.auth.admin.getUserById(linkedIds[0]);
    if (!error && data?.user) linkedUser = data.user as Record<string, unknown>;
    if (linkedUser && normalizedEmail(linkedUser.email) !== appEmail) {
      throw new HostActivationError("Linked Auth account email does not match the application", 409);
    }
  }

  const emailMatches = await authUsersByExactEmail(db, appEmail);
  if (emailMatches.length === 0) {
    throw new HostActivationError("No existing Auth login matches this application email", 409);
  }
  if (emailMatches.length > 1) {
    throw new HostActivationError("Multiple Auth logins match this application email", 409);
  }
  const emailUser = emailMatches[0];
  if (linkedUser && clean(linkedUser.id) !== clean(emailUser.id)) {
    throw new HostActivationError("Linked Auth account conflicts with the email login", 409);
  }
  return linkedUser || emailUser;
}

async function safeExistingHostAccount(
  db: any,
  userId: string,
  email: string,
): Promise<ExistingAccount | null> {
  const { data: byId, error: byIdError } = await db
    .from("accounts")
    .select("id, username, full_name, email, role, status, created_at")
    .eq("id", userId)
    .maybeSingle();
  if (byIdError) throw new HostActivationError(`Could not inspect host account: ${errMsg(byIdError)}`);

  const existing = byId as ExistingAccount | null;
  if (existing && existing.role !== "host") {
    throw new HostActivationError("This Auth login already belongs to a non-host account", 409);
  }
  if (existing?.email && normalizedEmail(existing.email) !== email) {
    throw new HostActivationError("Linked account email does not match the application", 409);
  }

  const { data: emailRows, error: emailError } = await db
    .from("accounts")
    .select("id")
    .eq("email", email)
    .limit(2);
  if (emailError) throw new HostActivationError(`Could not validate host email: ${errMsg(emailError)}`);
  if ((emailRows || []).some((row: { id?: string }) => clean(row.id) !== userId)) {
    throw new HostActivationError("Application email is linked to a different dashboard account", 409);
  }
  return existing;
}

async function rollbackHostActivation(
  db: any,
  userId: string,
  originalMetadata: Record<string, unknown>,
  originalEmailConfirmed: boolean,
  originalAccount: ExistingAccount | null,
  accountChanged: boolean,
  authChanged: boolean,
): Promise<string[]> {
  const failures: string[] = [];
  if (accountChanged) {
    const rollback = originalAccount
      ? await db.from("accounts").upsert(originalAccount, { onConflict: "id" })
      : await db.from("accounts").delete().eq("id", userId);
    if (rollback.error) {
      failures.push(`account rollback: ${errMsg(rollback.error)}`);
      // A suspended row is safer than leaving a newly-active orphan account.
      await db.from("accounts").update({ status: "suspended" }).eq("id", userId).catch(() => {});
    }
  }
  if (authChanged) {
    const { error } = await db.auth.admin.updateUserById(userId, {
      user_metadata: originalMetadata,
      email_confirm: originalEmailConfirmed,
    });
    if (error) failures.push(`Auth rollback: ${errMsg(error)}`);
  }
  return failures;
}

async function activateHostApplication(
  db: any,
  loaded: LoadedHostApplication,
  options: {
    reviewerId: string;
    reviewNote: string;
    markApproved: boolean;
  },
) {
  const app = loaded.app;
  const appEmail = normalizedEmail(app.email);
  const appFullName = clean(app.full_name);
  const gcashNumber = clean(app.gcash_number) || loaded.meta.gcashNumber;
  const authUser = await resolveUniqueHostAuthUser(db, loaded);
  const userId = clean(authUser.id);
  if (!userId) throw new HostActivationError("Resolved Auth login has no id", 409);

  const originalMetadata = authUser.user_metadata && typeof authUser.user_metadata === "object"
    ? { ...(authUser.user_metadata as Record<string, unknown>) }
    : {};
  const existingMetadataRole = clean(originalMetadata.role);
  const existingAppRole = authUser.app_metadata && typeof authUser.app_metadata === "object"
    ? clean((authUser.app_metadata as Record<string, unknown>).role)
    : "";
  if (
    (existingMetadataRole && existingMetadataRole !== "host") ||
    (existingAppRole && !["authenticated", "host"].includes(existingAppRole))
  ) {
    throw new HostActivationError("This Auth login already belongs to a non-host identity", 409);
  }
  const originalEmailConfirmed = Boolean(authUser.email_confirmed_at || authUser.confirmed_at);
  const originalAccount = await safeExistingHostAccount(db, userId, appEmail);
  const username = clean(originalAccount?.username) || appEmail;
  let authChanged = false;
  let accountChanged = false;

  try {
    const { error: authError } = await db.auth.admin.updateUserById(userId, {
      email_confirm: true,
      user_metadata: {
        ...originalMetadata,
        full_name: appFullName,
        username,
        role: "host",
        account_status: "active",
      },
    });
    if (authError) throw new HostActivationError(`Could not activate host login: ${errMsg(authError)}`);
    authChanged = true;

    const { error: accountError } = await db.from("accounts").upsert({
      id: userId,
      username,
      full_name: appFullName,
      email: appEmail,
      role: "host",
      status: "active",
    }, { onConflict: "id" });
    if (accountError) throw new HostActivationError(`Could not activate host account: ${errMsg(accountError)}`);
    accountChanged = true;

    const { data: verifiedAuth, error: verifiedAuthError } = await db.auth.admin.getUserById(userId);
    const verifiedMeta = verifiedAuth?.user?.user_metadata || {};
    if (
      verifiedAuthError || !verifiedAuth?.user || normalizedEmail(verifiedAuth.user.email) !== appEmail ||
      !verifiedAuth.user.email_confirmed_at || verifiedMeta.role !== "host" ||
      verifiedMeta.account_status !== "active"
    ) {
      throw new HostActivationError("Host Auth activation could not be verified");
    }
    const { data: verifiedAccount, error: verifiedAccountError } = await db
      .from("accounts")
      .select("id, role, status, email")
      .eq("id", userId)
      .maybeSingle();
    if (
      verifiedAccountError || !verifiedAccount || verifiedAccount.role !== "host" ||
      verifiedAccount.status !== "active" || normalizedEmail(verifiedAccount.email) !== appEmail
    ) {
      throw new HostActivationError("Active host dashboard account could not be verified");
    }

    const applicationUpdate: Record<string, unknown> = {};
    if (loaded.legacySchema) {
      applicationUpdate.review_note = signupMeta(userId, gcashNumber, options.reviewNote);
    } else {
      applicationUpdate.host_user_id = userId;
      if (gcashNumber) applicationUpdate.gcash_number = gcashNumber;
      if (options.markApproved) applicationUpdate.review_note = options.reviewNote;
    }
    if (options.markApproved) {
      applicationUpdate.status = "approved";
      applicationUpdate.reviewed_by = options.reviewerId;
      applicationUpdate.reviewed_at = new Date().toISOString();
    }

    let applicationQuery = db
      .from("open_play_host_applications")
      .update(applicationUpdate)
      .eq("id", clean(app.id));
    applicationQuery = options.markApproved
      ? applicationQuery.eq("status", clean(app.status))
      : applicationQuery.eq("status", "approved");
    const { data: updatedApplication, error: applicationError } = await applicationQuery
      .select("id")
      .maybeSingle();
    if (applicationError) throw new HostActivationError(`Could not link approved host application: ${errMsg(applicationError)}`);
    if (!updatedApplication) throw new HostActivationError("Host application changed during activation", 409);

    return { hostUserId: userId, accountStatus: "active" as const };
  } catch (error) {
    const rollbackFailures = await rollbackHostActivation(
      db,
      userId,
      originalMetadata,
      originalEmailConfirmed,
      originalAccount,
      accountChanged,
      authChanged,
    );
    if (rollbackFailures.length > 0) {
      console.error("host activation rollback incomplete:", rollbackFailures.join("; "));
      throw new HostActivationError(`${errMsg(error)}. Activation rollback needs administrator review.`);
    }
    if (error instanceof HostActivationError) throw error;
    throw new HostActivationError(errMsg(error));
  }
}

type ReviewerResult = { error: Response } | { user: { id: string } };

// This standalone function has no generated Database type, and it supports
// both modern and pre-migration query shapes.
async function requireReviewer(req: Request, db: any): Promise<ReviewerResult> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: json({ error: "Unauthorized" }, 401) };

  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData?.user) return { error: json({ error: "Unauthorized" }, 401) };

  const { data: account, error: accountErr } = await db
    .from("accounts")
    .select("role, status")
    .eq("id", userData.user.id)
    .single();

  const accountRow = account as { role?: string; status?: string } | null;
  if (accountErr || !accountRow || accountRow.status !== "active" || !["owner", "court_owner"].includes(accountRow.role || "")) {
    return { error: json({ error: "Only an active owner or court owner can manage host applications" }, 403) };
  }

  return { user: userData.user };
}

Deno.serve(async (req): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Supabase service credentials are missing" }, 500);

  const db = createClient(supabaseUrl, serviceRoleKey);

  const serviceHeaders = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
  };

  async function restSelect(table: string, filters: Record<string, string>) {
    const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
    url.searchParams.set("select", "id");
    url.searchParams.set("limit", "1");
    Object.entries(filters).forEach(([key, value]) => url.searchParams.set(key, value));
    const res = await fetch(url, { headers: serviceHeaders });
    const data = await readJson(res);
    if (!res.ok) throw new Error(apiError(data, `Supabase REST select failed (${res.status})`));
    return Array.isArray(data) ? data : [];
  }

  async function restInsert(table: string, record: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
    url.searchParams.set("select", "id");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...serviceHeaders,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(record),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(apiError(data, `Supabase REST insert failed (${res.status})`));
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") throw new Error("Supabase REST insert did not return a row");
    return row as Record<string, unknown>;
  }

  async function createAuthUser() {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        ...serviceHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, username: email, role: "host", account_status: "pending" },
      }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(apiError(data, `Could not create host auth account (${res.status})`));
    const id = data && typeof data === "object" ? (data as Record<string, unknown>).id : "";
    if (typeof id !== "string" || !id) throw new Error("Auth user was not created");
    return id;
  }

  async function deleteAuthUser(userId: string) {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: serviceHeaders,
    }).catch(() => {});
  }

  let body: SignupPayload;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body.action === "sign-valid-id") {
    const reviewer = await requireReviewer(req, db);
    if ("error" in reviewer) return reviewer.error;

    const applicationId = clean(body.applicationId);
    if (!applicationId) return json({ error: "Application id is required" }, 400);

    const { data: app, error: appErr } = await db
      .from("open_play_host_applications")
      .select("valid_id_path")
      .eq("id", applicationId)
      .single();
    if (appErr || !app?.valid_id_path) return json({ error: "No valid ID available" }, 404);

    const { data, error } = await db.storage.from("host-ids").createSignedUrl(app.valid_id_path, 300);
    if (error || !data?.signedUrl) return json({ error: errMsg(error) || "Could not sign valid ID" }, 500);
    return json({ ok: true, url: data.signedUrl });
  }

  if (body.action === "repair-activation") {
    const reviewer = await requireReviewer(req, db);
    if ("error" in reviewer) return reviewer.error;

    const applicationId = clean(body.applicationId);
    if (!applicationId) return json({ error: "Application id is required" }, 400);
    try {
      const loaded = await loadHostApplication(db, applicationId);
      if (clean(loaded.app.status) !== "approved") {
        return json({ error: "Only an approved application can be repaired" }, 409);
      }
      const rawReviewNote = clean(loaded.app.review_note);
      const reviewNote = loaded.meta.reviewNote ||
        (rawReviewNote.startsWith("{") ? "" : rawReviewNote) ||
        "Approved for 25% host booking access.";
      const activated = await activateHostApplication(db, loaded, {
        reviewerId: reviewer.user.id,
        reviewNote,
        markApproved: false,
      });
      return json({
        ok: true,
        status: "approved",
        loginLinked: true,
        hostUserId: activated.hostUserId,
        accountStatus: activated.accountStatus,
      });
    } catch (error) {
      const status = error instanceof HostActivationError ? error.status : 500;
      return json({ error: errMsg(error) }, status);
    }
  }

  if (body.action === "review") {
    const reviewer = await requireReviewer(req, db);
    if ("error" in reviewer) return reviewer.error;

    const applicationId = clean(body.applicationId);
    const status = body.status === "approved" ? "approved" : body.status === "rejected" ? "rejected" : "";
    if (!applicationId || !status) return json({ error: "Application id and review status are required" }, 400);

    let loaded: LoadedHostApplication;
    try {
      loaded = await loadHostApplication(db, applicationId);
    } catch (error) {
      const errorStatus = error instanceof HostActivationError ? error.status : 500;
      return json({ error: errMsg(error) }, errorStatus);
    }
    const { app, legacySchema, meta } = loaded;
    const hostUserId = app.host_user_id || meta.hostUserId;
    const appFullName = clean(app.full_name);
    const reviewNote = clean(body.reviewNote) || (status === "approved"
      ? "Approved for 25% host booking access."
      : "Application rejected.");

    if (status === "approved") {
      try {
        const activated = await activateHostApplication(db, loaded, {
          reviewerId: reviewer.user.id,
          reviewNote,
          markApproved: true,
        });
        return json({
          ok: true,
          status: "approved",
          loginLinked: true,
          hostUserId: activated.hostUserId,
          accountStatus: activated.accountStatus,
        });
      } catch (error) {
        const errorStatus = error instanceof HostActivationError ? error.status : 500;
        return json({ error: errMsg(error) }, errorStatus);
      }
    }

    // Rejection keeps the existing fail-closed order: suspend access before
    // recording the application as rejected.
    if (typeof hostUserId === "string" && hostUserId) {
      const { data: authLookup, error: authLookupErr } = await db.auth.admin.getUserById(hostUserId);
      if (authLookupErr || !authLookup?.user) {
        return json({ error: `Linked host auth account was not found: ${errMsg(authLookupErr)}` }, 409);
      }

      const appEmail = normalizedEmail(app.email);
      if (normalizedEmail(authLookup.user.email) !== appEmail) {
        return json({ error: "Linked Auth account email does not match the application" }, 409);
      }
      const currentMetadata = authLookup.user.user_metadata && typeof authLookup.user.user_metadata === "object"
        ? authLookup.user.user_metadata
        : {};
      const currentMetadataRole = clean(currentMetadata.role);
      const currentAppRole = authLookup.user.app_metadata && typeof authLookup.user.app_metadata === "object"
        ? clean(authLookup.user.app_metadata.role)
        : "";
      if (
        (currentMetadataRole && currentMetadataRole !== "host") ||
        (currentAppRole && !["authenticated", "host"].includes(currentAppRole))
      ) {
        return json({ error: "Linked Auth login belongs to a non-host identity" }, 409);
      }

      let existingAccount: ExistingAccount | null;
      try {
        existingAccount = await safeExistingHostAccount(db, hostUserId, appEmail);
      } catch (error) {
        const errorStatus = error instanceof HostActivationError ? error.status : 500;
        return json({ error: errMsg(error) }, errorStatus);
      }

      // Suspend the accounts row first because database authorization checks
      // it on every request, including sessions whose JWT is already issued.
      if (existingAccount) {
        const { data: suspendedAccount, error: accountErr } = await db
          .from("accounts")
          .update({ status: "suspended" })
          .eq("id", hostUserId)
          .select("id")
          .maybeSingle();
        if (accountErr || !suspendedAccount) {
          return json({ error: `Could not suspend host account: ${errMsg(accountErr)}` }, 500);
        }
      }

      const { error: authErr } = await db.auth.admin.updateUserById(hostUserId, {
        user_metadata: {
          ...currentMetadata,
          full_name: appFullName,
          role: "host",
          account_status: "suspended",
        },
      });
      if (authErr) return json({ error: `Could not suspend host login: ${errMsg(authErr)}` }, 500);
    }

    const storedReviewNote = legacySchema && typeof hostUserId === "string" && hostUserId
      ? signupMeta(hostUserId, meta.gcashNumber, reviewNote)
      : reviewNote;
    const applicationUpdates: Record<string, unknown> = {
      status,
      review_note: storedReviewNote,
      reviewed_by: reviewer.user.id,
      reviewed_at: new Date().toISOString(),
    };
    // Applications submitted against the pre-migration schema kept their auth
    // id in review_note. Once the modern columns exist, persist that id in its
    // proper column so later rejection/reactivation still targets the login.
    if (!legacySchema && !app.host_user_id && typeof hostUserId === "string" && hostUserId) {
      applicationUpdates.host_user_id = hostUserId;
      if (meta.gcashNumber) applicationUpdates.gcash_number = meta.gcashNumber;
    }
    const { data: updatedApp, error: updErr } = await db
      .from("open_play_host_applications")
      .update(applicationUpdates)
      .eq("id", applicationId)
      .select("id")
      .maybeSingle();
    if (updErr) return json({ error: errMsg(updErr) }, 500);
    if (!updatedApp) return json({ error: "Host application not found" }, 404);

    return json({
      ok: true,
      status,
      loginLinked: typeof hostUserId === "string" && Boolean(hostUserId),
      hostUserId: typeof hostUserId === "string" && hostUserId ? hostUserId : null,
      accountStatus: typeof hostUserId === "string" && hostUserId ? "suspended" : null,
    });
  }

  if (body.action !== "signup") return json({ error: "Unknown action" }, 400);

  const fullName = clean(body.fullName);
  const contactNumber = clean(body.contactNumber);
  const email = clean(body.email).toLowerCase();
  const password = String(body.password || "");
  const gcashNumber = clean(body.gcashNumber);
  const validIdBase64 = String(body.validIdBase64 || "");
  const validIdFileName = clean(body.validIdFileName);
  const validIdFileType = clean(body.validIdFileType);
  const validIdFileSize = Number(body.validIdFileSize || 0);
  const notes = clean(body.notes);

  if (fullName.length < 3) return json({ error: "Full name is required" }, 400);
  if (!validPhone(contactNumber)) return json({ error: "Valid phone number is required" }, 400);
  if (!validEmail(email)) return json({ error: "Valid email is required" }, 400);
  if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
  if (!validPhone(gcashNumber)) return json({ error: "Valid GCash number is required" }, 400);

  const hasValidId = Boolean(validIdBase64 || validIdFileName || validIdFileType || validIdFileSize);
  let idBytes: Uint8Array | null = null;
  if (hasValidId) {
    if (!validIdBase64 || !validIdFileName || !ALLOWED_ID_TYPES.has(validIdFileType)) {
      return json({ error: "Valid ID upload must be a JPG, PNG, WebP, or PDF" }, 400);
    }
    if (validIdFileSize > MAX_ID_BYTES) return json({ error: "Valid ID file must be 5MB or smaller" }, 400);
    idBytes = base64ToBytes(validIdBase64);
    if (idBytes.byteLength > MAX_ID_BYTES) return json({ error: "Valid ID file must be 5MB or smaller" }, 400);
  }

  let authUserId = "";
  try {
    const usernameMatch = await restSelect("accounts", { username: `eq.${email}` });
    const emailMatch = await restSelect("accounts", { email: `eq.${email}` });

    if ((usernameMatch && usernameMatch.length > 0) || (emailMatch && emailMatch.length > 0)) {
      return json({ error: "A host account or application already uses this email" }, 409);
    }

    const existingApp = await restSelect("open_play_host_applications", { email: `eq.${email}`, status: "neq.rejected" });
    if (existingApp && existingApp.length > 0) {
      return json({ error: "A pending host application already uses this email" }, 409);
    }

    authUserId = await createAuthUser();

    let idPath: string | null = null;
    if (idBytes) {
      idPath = `${authUserId}/${crypto.randomUUID()}.${safeExt(validIdFileName, validIdFileType)}`;
      const { error: uploadErr } = await db.storage.from("host-ids").upload(idPath, idBytes, {
        contentType: validIdFileType,
        upsert: false,
      });
      if (uploadErr) throw uploadErr;
    }

    let app: Record<string, unknown>;
    try {
      app = await restInsert("open_play_host_applications", {
        host_user_id: authUserId,
        full_name: fullName,
        contact_number: contactNumber,
        email,
        gcash_number: gcashNumber,
        valid_id_file_name: idBytes ? validIdFileName : null,
        valid_id_file_type: idBytes ? validIdFileType : null,
        valid_id_file_size: idBytes ? idBytes.byteLength : null,
        valid_id_path: idPath,
        notes: notes || null,
        review_note: signupMeta(authUserId, gcashNumber),
        status: "pending",
        created_at: new Date().toISOString(),
      });
    } catch (insertErr) {
      if (!/host_user_id|gcash_number|valid_id_/i.test(errMsg(insertErr))) throw insertErr;
      app = await restInsert("open_play_host_applications", {
        full_name: fullName,
        contact_number: contactNumber,
        email,
        notes: notes || null,
        review_note: signupMeta(authUserId, gcashNumber),
        status: "pending",
        created_at: new Date().toISOString(),
      });
    }

    return json({ ok: true, applicationId: typeof app.id === "string" ? app.id : "" });
  } catch (err) {
    if (authUserId) {
      await deleteAuthUser(authUserId);
    }
    return json({ error: errMsg(err) }, 500);
  }
});
