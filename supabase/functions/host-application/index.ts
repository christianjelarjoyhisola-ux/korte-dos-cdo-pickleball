import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ID_BYTES = 5 * 1024 * 1024;
const ALLOWED_ID_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

type SignupPayload = {
  action?: "signup" | "sign-valid-id" | "review";
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

function signupMeta(hostUserId: string, gcashNumber: string) {
  return JSON.stringify({ hostUserId, gcashNumber });
}

function parseSignupMeta(value: unknown) {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return { hostUserId: "", gcashNumber: "" };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      hostUserId: typeof parsed.hostUserId === "string" ? parsed.hostUserId : "",
      gcashNumber: typeof parsed.gcashNumber === "string" ? parsed.gcashNumber : "",
    };
  } catch {
    return { hostUserId: "", gcashNumber: "" };
  }
}

type ReviewerResult = { error: Response } | { user: { id: string } };

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
    return { error: json({ error: "Only the court owner can view host IDs" }, 403) };
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

  async function deleteAccount(userId: string) {
    const url = new URL(`${supabaseUrl}/rest/v1/accounts`);
    url.searchParams.set("id", `eq.${userId}`);
    await fetch(url, {
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

  if (body.action === "review") {
    const reviewer = await requireReviewer(req, db);
    if ("error" in reviewer) return reviewer.error;

    const applicationId = clean(body.applicationId);
    const status = body.status === "approved" ? "approved" : body.status === "rejected" ? "rejected" : "";
    if (!applicationId || !status) return json({ error: "Application id and review status are required" }, 400);

    const modernApp = await db
      .from("open_play_host_applications")
      .select("id, host_user_id, full_name, email")
      .eq("id", applicationId)
      .single();
    let app = modernApp.data as Record<string, unknown> | null;
    let appErr = modernApp.error;
    if (appErr && /host_user_id/i.test(appErr.message || "")) {
      const fallback = await db
        .from("open_play_host_applications")
        .select("id, full_name, email, review_note")
        .eq("id", applicationId)
        .single();
      app = fallback.data;
      appErr = fallback.error;
    }
    if (appErr || !app) return json({ error: "Host application not found" }, 404);
    const meta = parseSignupMeta((app as Record<string, unknown>).review_note);
    const hostUserId = (app as Record<string, unknown>).host_user_id || meta.hostUserId;

    const { error: updErr } = await db
      .from("open_play_host_applications")
      .update({
        status,
        review_note: clean(body.reviewNote) || (status === "approved" ? "Approved for 25% host booking access." : "Application rejected."),
        reviewed_by: reviewer.user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", applicationId);
    if (updErr) return json({ error: errMsg(updErr) }, 500);

    if (typeof hostUserId === "string" && hostUserId) {
      if (status === "approved") {
        const { error: accountErr } = await db
          .from("accounts")
          .upsert({
            id: hostUserId,
            username: app.email,
            full_name: app.full_name,
            email: app.email,
            role: "host",
            created_at: new Date().toISOString(),
          }, { onConflict: "id" });
        if (accountErr) return json({ error: errMsg(accountErr) }, 500);
      }

      await db.auth.admin.updateUserById(hostUserId, {
        user_metadata: { account_status: status === "approved" ? "active" : "suspended", role: "host" },
      }).catch(() => {});
    }

    return json({ ok: true });
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
