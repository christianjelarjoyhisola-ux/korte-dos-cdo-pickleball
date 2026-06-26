// verify-gcash-receipt
// ----------------------------------------------------------------------------
// Server-side GCash / GoTyme / PNB receipt verification + fraud detection.
//
// Actions (POST JSON):
//   { action: "verify", bookingRef, provider, imageBase64, contentType }
//     -> OCR (Google Vision) + fraud checks + confidence routing.
//        Stores the image (private bucket), writes an audit row, advances
//        payment_status on auto-approve, and alerts admin on review/reject.
//   { action: "sign", bookingRef }    (admin-only, requires a user JWT)
//     -> returns a short-lived signed URL to view the stored receipt image.
//
// Decision lanes:
//   auto_approved : zero hard flags, zero soft flags, OCR confident
//   manual_review : soft flag(s) or unreadable fields or low confidence
//   rejected      : any hard flag (duplicate / wrong number / underpay / stale)
//
// Rejections never auto-cancel the booking (OCR is heuristic — avoid harming
// honest customers). They flag the booking red and alert the admin.
// ----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Payment must happen within this many minutes after the booking/session join
// is started.
const PAYMENT_WINDOW_MINUTES = 10;
// OCR usually reads only minute-level timestamps. A receipt paid during the
// same minute as the hold can look a few seconds "before" the booking.
const PAYMENT_EARLY_TOLERANCE_MINUTES = 2;

const MAX_BYTES = 5 * 1024 * 1024;
const PESO_TOLERANCE = 5; // allow ±₱5 rounding; underpay beyond this is a hard flag

// Hard flags force a rejection; soft flags force manual review.
const HARD_FLAGS = new Set([
  "REF_FORMAT_INVALID",
  "SUSPECTED_FAKE",     // OCR ran and image has zero receipt-like content
  "IMAGE_UNREADABLE",   // OCR found NO text at all -> random/blank/non-receipt image
  "DUPLICATE_REF",
  "REF_MISMATCH",
  "DATE_NOT_TODAY",
  "TIME_EXPIRED",
  "TIME_FUTURE",
  "WRONG_GCASH_NUMBER",
  "AMOUNT_MISMATCH",    // Only hard if significantly underpaid (>₱5)
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errMsg(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const m = err as Record<string, unknown>;
    if (typeof m.message === "string") return m.message;
    if (typeof m.error === "string") return m.error;
  }
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  // Accept raw base64 or a data: URL.
  const comma = b64.indexOf(",");
  const raw = b64.startsWith("data:") && comma !== -1 ? b64.slice(comma + 1) : b64;
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Difference-hash (dHash): 64-bit perceptual hash robust to recompression and
// light cropping/scaling. Returns 16-hex-char string, or null if undecodable.
async function dHash(bytes: Uint8Array): Promise<string | null> {
  try {
    const img = await Image.decode(bytes);
    const small = img.resize(9, 8); // 9x8 -> 8 horizontal comparisons per row
    let bits = "";
    for (let y = 1; y <= 8; y++) {
      for (let x = 1; x <= 8; x++) {
        const lPix = small.getPixelAt(x, y);
        const rPix = small.getPixelAt(x + 1, y);
        const lGray = ((lPix >>> 24) & 0xff) + ((lPix >>> 16) & 0xff) + ((lPix >>> 8) & 0xff);
        const rGray = ((rPix >>> 24) & 0xff) + ((rPix >>> 16) & 0xff) + ((rPix >>> 8) & 0xff);
        bits += lGray < rGray ? "1" : "0";
      }
    }
    let hex = "";
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  } catch {
    return null; // HEIC/unknown formats — skip perceptual dedupe, not fatal
  }
}

function hammingHex(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 999;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}

function phManilaNow(): Date {
  // Current instant shifted to UTC+8 wall clock.
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function phTodayStr(): string {
  return phManilaNow().toISOString().slice(0, 10); // YYYY-MM-DD in PH
}

function toPhWallClockDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000);
}

function formatPhDateTime12(d: Date | null): string | null {
  if (!d) return null;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  let hour = d.getUTCHours();
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${year}-${month}-${day} ${hour}:${minute} ${ampm} PH`;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Parse a GCash-style timestamp e.g. "Jun 13, 2026 10:30 AM" into a Date
// interpreted as PH wall-clock (returned as a UTC+8-shifted Date for comparison
// against phManilaNow()). Returns null if not found.
function parseReceiptDateTime(text: string): { date: string | null; shifted: Date | null } {
  const m = text.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})\s*(am|pm)?)?/i,
  );
  if (!m) return { date: null, shifted: null };
  const mon = MONTHS[m[1].toLowerCase().slice(0, 3)];
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  let hour = m[4] ? parseInt(m[4], 10) : 0;
  const min = m[5] ? parseInt(m[5], 10) : 0;
  const ap = m[6]?.toLowerCase();
  if (ap === "pm" && hour !== 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  const dateStr = `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Build as if UTC so the numbers represent PH wall clock; compare to phManilaNow().
  const shifted = new Date(Date.UTC(year, mon, day, hour, min, 0));
  return { date: dateStr, shifted };
}

function digitsOnly(s: string): string {
  return (s || "").replace(/\D/g, "");
}

function normalizeReferenceForProvider(value: string, provider: "gcash" | "gotyme" | "pnb"): string {
  const raw = value || "";
  if (provider === "gcash") return digitsOnly(raw);
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Extract candidate 13-digit GCash reference numbers from OCR text.
function extractGcashRef(text: string): string | null {
  const cleaned = text.replace(/[^\d\s]/g, " ");
  const groups = cleaned.match(/(?:\d[\d\s]{11,20}\d)/g) || [];
  for (const g of groups) {
    const d = digitsOnly(g);
    if (d.length === 13) return d;
  }
  // Fallback: any standalone 13-digit run.
  const m = text.match(/\b\d{13}\b/);
  return m ? m[0] : null;
}

function extractReference(
  text: string,
  provider: "gcash" | "gotyme" | "pnb",
  typedRef: string,
): string | null {
  if (provider === "gcash") return extractGcashRef(text);

  // GoTyme/PNB references are not guaranteed to be 13-digit GCash-style refs.
  // For those providers, trust the customer-entered reference only if OCR sees
  // the same alphanumeric token in the receipt text.
  const normalizedTyped = normalizeReferenceForProvider(typedRef, provider);
  if (normalizedTyped.length >= 6) {
    const normalizedText = normalizeReferenceForProvider(text, provider);
    if (normalizedText.includes(normalizedTyped)) return normalizedTyped;
  }
  return null;
}

function extractAmount(text: string): number | null {
  // Prefer values near an amount keyword / peso sign.
  const near = text.match(/(?:amount|total|php|₱|p\s)\s*[:\-]?\s*([\d,]+\.\d{2})/i);
  if (near) return parseFloat(near[1].replace(/,/g, ""));
  const any = text.match(/\b([\d,]{1,9}\.\d{2})\b/);
  return any ? parseFloat(any[1].replace(/,/g, "")) : null;
}

// Normalize a PH mobile number to its 10 significant digits (drop 0/63 prefix).
function normalizeMobile(d: string): string {
  let x = digitsOnly(d);
  if (x.startsWith("63")) x = x.slice(2);
  if (x.startsWith("0")) x = x.slice(1);
  return x; // expect 10 digits: 9XXXXXXXXX
}

type NumberCheck = "match" | "wrong" | "unreadable";

function normalizedProvider(raw: string): "gcash" | "gotyme" | "pnb" {
  const provider = raw.toLowerCase();
  if (provider === "gotyme" || provider === "pnb") return provider;
  return "gcash";
}

function expectedMerchantForProvider(
  settings: Record<string, string>,
  provider: "gcash" | "gotyme" | "pnb",
): { number: string; name: string } {
  if (provider === "gotyme") {
    return {
      number: settings.gotyme_merchant_number || "",
      name: settings.gotyme_merchant_name || "",
    };
  }
  if (provider === "pnb") {
    return {
      number: settings.pnb_merchant_number || "",
      name: settings.pnb_merchant_name || "",
    };
  }
  return {
    number: settings.gcash_merchant_number || "",
    name: settings.gcash_merchant_name || "",
  };
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function closeMoney(a: number, b: number): boolean {
  return Math.abs(roundMoney(a) - roundMoney(b)) <= 0.01;
}

function parseJsonArray(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

function rateForHour(hour: number, tiers: Array<Record<string, unknown>>, fallbackRate: number): number {
  for (const tier of tiers || []) {
    const from = toNumber(tier.from);
    const to = toNumber(tier.to);
    const rate = toNumber(tier.rate, fallbackRate);
    const inRange = from < to ? hour >= from && hour < to : hour >= from || hour < to;
    if (inRange) return rate;
  }
  return tiers && tiers.length > 0
    ? Math.min(...tiers.map((tier) => toNumber(tier.rate, fallbackRate)))
    : fallbackRate;
}

function chooseExpectedDue(total: number, storedDownpayment: number, settings: Record<string, string>): number {
  const half = roundMoney(total / 2);
  const mode = settings.payment_acceptance_mode || "both";
  if (mode === "full_payment_only") return total;
  if (mode === "downpayment_only") return half;
  if (closeMoney(storedDownpayment, total)) return total;
  if (closeMoney(storedDownpayment, half)) return half;
  throw new Error("Stored payment amount does not match current pricing");
}

function expectedOpenPlayAmount(booking: Record<string, unknown>, settings: Record<string, string>): number {
  const cfg = (() => {
    try { return settings.open_play_config ? JSON.parse(settings.open_play_config) : {}; }
    catch { return {}; }
  })() as Record<string, unknown>;
  const openPlayFee = toNumber(cfg.fee ?? settings.open_play_fee, 100);
  const platformFee = toNumber(settings.maintenance_fee ?? settings.service_fee_rate ?? settings.booking_fee);
  const total = roundMoney(openPlayFee + platformFee);
  return chooseExpectedDue(total, toNumber(booking.downpayment, -1), settings);
}

async function expectedBookingAmount(
  db: ReturnType<typeof createClient>,
  booking: Record<string, unknown>,
  settings: Record<string, string>,
): Promise<number> {
  const courtId = String(booking.court_id || "");
  if (!courtId) return expectedOpenPlayAmount(booking, settings);

  const slots = Array.isArray(booking.slots)
    ? booking.slots.map(Number).filter(Number.isFinite)
    : [];
  if (slots.length === 0) throw new Error("Booking has no billable slots");

  const { data: court, error: courtErr } = await db
    .from("courts")
    .select("rate,rate_schedule")
    .eq("id", courtId)
    .single();
  if (courtErr || !court) throw courtErr || new Error("Court not found");

  const courtRate = toNumber(court.rate);
  const courtTiers = parseJsonArray(court.rate_schedule);
  const settingTiers = parseJsonArray(settings.pricing_tiers);
  const tiers = courtTiers.length ? courtTiers : settingTiers.length ? settingTiers : [{ from: 0, to: 24, rate: courtRate }];
  const courtTotal = slots.reduce((sum, hour) => sum + rateForHour(hour, tiers, courtRate), 0);
  const feeRate = toNumber(settings.maintenance_fee ?? settings.service_fee_rate ?? settings.booking_fee);
  const feeType = settings.fee_type === "flat" ? "flat" : "per_hour";
  const serviceFee = feeType === "flat" ? feeRate : feeRate * slots.length;
  const total = roundMoney(courtTotal + serviceFee);
  return chooseExpectedDue(total, toNumber(booking.downpayment, -1), settings);
}

async function loadBookingGroup(
  db: ReturnType<typeof createClient>,
  booking: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const groupRef = String(booking.booking_group_ref || "");
  if (!groupRef) return [booking];
  const { data, error } = await db
    .from("bookings")
    .select("ref, booking_group_ref, court_id, slots, total, downpayment, gcash_ref, date, payment_status, status, full_name, created_at")
    .eq("booking_group_ref", groupRef)
    .neq("status", "cancelled");
  if (error) throw error;
  return (data || []) as Array<Record<string, unknown>>;
}

async function expectedBookingGroupAmount(
  db: ReturnType<typeof createClient>,
  bookings: Array<Record<string, unknown>>,
  settings: Record<string, string>,
): Promise<number> {
  let due = 0;
  for (const row of bookings) due += await expectedBookingAmount(db, row, settings);
  return roundMoney(due);
}

function bookingGroupStoredTotal(bookings: Array<Record<string, unknown>>): number {
  return roundMoney(bookings.reduce((sum, row) => sum + toNumber(row.total), 0));
}

function bookingUpdateQuery(
  db: ReturnType<typeof createClient>,
  booking: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  const groupRef = String(booking.booking_group_ref || "");
  const query = db.from("bookings").update(update);
  return groupRef ? query.eq("booking_group_ref", groupRef) : query.eq("ref", String(booking.ref || ""));
}

function checkReceiverNumber(text: string, expectedRaw: string): NumberCheck {
  const expected = normalizeMobile(expectedRaw);
  if (expected.length < 10) return "unreadable"; // no configured number to compare
  const last4 = expected.slice(-4);

  // Full mobile numbers in the receipt (handles +63 / 0 / 9 forms).
  const fullMatches = text.match(/(?:\+?63|0)?9\d{2}[\s\-•*x.]*\d{2,3}[\s\-•*x.]*\d{2,4}/gi) || [];
  let sawFull = false;
  for (const fm of fullMatches) {
    const norm = normalizeMobile(fm);
    if (norm.length >= 10) {
      sawFull = true;
      if (norm === expected) return "match";
    }
  }
  // Masked receipts often reveal only the last 4 digits.
  if (new RegExp(`(?:[•*xX#\\s\\-]{2,}|\\d)${last4}\\b`).test(text)) return "match";
  if (text.includes(last4)) return "match";

  // We positively saw a complete, different mobile number → confidently wrong.
  if (sawFull) return "wrong";
  return "unreadable";
}

// Loose masked-name match (e.g. "CO**TY**D P*CKL*B*LL" vs "KORTE DOS").
function checkReceiverName(text: string, expectedName: string): "match" | "mismatch" | "unreadable" {
  const expected = (expectedName || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (expected.length < 3) return "unreadable";
  const upper = text.toUpperCase();
  // Compare on the alphabetic skeleton. Masked or incomplete names are neutral:
  // GCash commonly shows names like "AN*****A A.", which should not block a
  // valid receipt when number/ref/amount/date/time are correct.
  const tokens = expected.match(/.{1,4}/g) || [];
  let hits = 0;
  for (const t of tokens) {
    if (upper.replace(/[^A-Z]/g, "").includes(t)) hits++;
  }
  if (hits === 0) {
    // try first 3 visible letters
    if (upper.replace(/[^A-Z]/g, "").includes(expected.slice(0, 3))) return "match";
    return "unreadable";
  }
  return hits >= Math.ceil(tokens.length / 2) ? "match" : "unreadable";
}

// Best-effort "looks like a real GCash receipt" heuristic (soft signal only).
function looksLikeGcashReceipt(text: string): boolean {
  const t = text.toLowerCase();
  let score = 0;
  if (/ref(?:erence)?\s*(no|number|#)/.test(t)) score++;
  if (/gcash|gotyme|maya|paymongo|qrph|instapay|pesonet/.test(t)) score++;
  if (/sent|received|paid|transfer|amount/.test(t)) score++;
  if (/\d{4}/.test(t)) score++;
  return score >= 2;
}

// Best-effort JPEG "edited in image software" detector (soft signal only).
function editedBySoftware(bytes: Uint8Array): boolean {
  // Scan the first 64KB for editor signatures embedded in EXIF/XMP.
  const slice = bytes.subarray(0, Math.min(bytes.length, 65536));
  let s = "";
  for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
  return /(adobe\s*photoshop|gimp|pixlr|snapseed|picsart|lightroom|inkscape)/i.test(s);
}

async function googleVisionOCR(apiKey: string, base64: string): Promise<{ text: string; confidence: number }> {
  const content = base64.startsWith("data:") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        image: { content },
        features: [{ type: "TEXT_DETECTION", maxResults: 1 }],
        imageContext: { languageHints: ["en"] },
      }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vision error ${res.status}: ${errMsg(data)}`);
  const r = data?.responses?.[0];
  if (r?.error) throw new Error(`Vision: ${errMsg(r.error)}`);
  const text: string = r?.fullTextAnnotation?.text || r?.textAnnotations?.[0]?.description || "";
  // Confidence from page blocks when available; fall back on text length.
  let confidence = 0;
  const pages = r?.fullTextAnnotation?.pages || [];
  if (pages.length && typeof pages[0].confidence === "number") confidence = pages[0].confidence;
  else confidence = text.length > 40 ? 0.9 : text.length > 0 ? 0.5 : 0;
  return { text, confidence };
}

// OCR.space — free OCR API that does NOT require a credit card / billing.
// Get a free key at https://ocr.space/ocrapi/freekey (25k scans/mo). The
// 'helloworld' demo key works but is heavily rate-limited — set OCRSPACE_API_KEY.
async function ocrSpaceOCR(apiKey: string, base64: string, contentType: string): Promise<{ text: string; confidence: number }> {
  const raw = base64.startsWith("data:") ? base64 : `data:${contentType};base64,${base64}`;
  const form = new FormData();
  form.append("base64Image", raw);
  form.append("language", "eng");
  form.append("OCREngine", "2");      // engine 2 = better on receipts/numbers
  form.append("scale", "true");
  form.append("isTable", "true");
  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: apiKey },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OCR.space error ${res.status}: ${errMsg(data)}`);
  if (data?.IsErroredOnProcessing) throw new Error(`OCR.space: ${errMsg(data?.ErrorMessage || data)}`);
  const text: string = (data?.ParsedResults || []).map((p: { ParsedText?: string }) => p?.ParsedText || "").join("\n").trim();
  const confidence = text.length > 40 ? 0.85 : text.length > 0 ? 0.5 : 0;
  return { text, confidence };
}

// Try Google Vision first (best quality); if it is unconfigured, billing-disabled,
// or returns nothing, fall back to OCR.space so verification still works.
async function runOCR(
  visionKey: string,
  ocrSpaceKey: string,
  base64: string,
  contentType: string,
): Promise<{ text: string; confidence: number; provider: string }> {
  if (visionKey) {
    try {
      const v = await googleVisionOCR(visionKey, base64);
      if (v.text) return { ...v, provider: "google_vision" };
      console.error("Vision returned empty text — falling back to OCR.space");
    } catch (e) {
      console.error("Vision OCR failed, falling back to OCR.space:", errMsg(e));
    }
  }
  if (ocrSpaceKey) {
    const o = await ocrSpaceOCR(ocrSpaceKey, base64, contentType);
    return { ...o, provider: "ocr_space" };
  }
  return { text: "", confidence: 0, provider: "none" };
}

async function sendTelegram(message: string) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const chatIdRaw = Deno.env.get("TELEGRAM_CHAT_ID") || "";
  if (!botToken || !chatIdRaw) return;
  const chatIds = chatIdRaw.split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.allSettled(chatIds.map((chatId) =>
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    })
  ));
}

// ── handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey =
    Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ error: "Missing SERVICE_ROLE_KEY" }, 500);
  const db = createClient(supabaseUrl, serviceRoleKey);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = (body.action as string) || "verify";

  // ── admin-only: mint a signed URL to view a stored receipt ────────────────
  if (action === "sign") {
    const bookingRef = String(body.bookingRef || "");
    const openPlayRegistrationId = String(body.openPlayRegistrationId || "");
    const hostSessionRegistrationId = String(body.hostSessionRegistrationId || "");
    if (!bookingRef && !openPlayRegistrationId && !hostSessionRegistrationId) {
      return json({ error: "bookingRef, openPlayRegistrationId, or hostSessionRegistrationId required" }, 400);
    }

    // Require a real signed-in user (anon key alone is rejected).
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return json({ error: "Unauthorized" }, 401);

    let path: string | null = null;
    if (hostSessionRegistrationId) {
      const { data: reg } = await db
        .from("open_play_host_session_registrations")
        .select("receipt_image_url")
        .eq("id", hostSessionRegistrationId)
        .single();
      path = reg?.receipt_image_url || null;
    } else if (openPlayRegistrationId) {
      const { data: reg } = await db
        .from("open_play_registrations")
        .select("receipt_image_url")
        .eq("id", openPlayRegistrationId)
        .single();
      path = reg?.receipt_image_url || null;
    } else {
      const { data: bk } = await db.from("bookings").select("receipt_image_url").eq("ref", bookingRef).single();
      path = bk?.receipt_image_url || null;
    }
    if (!path) return json({ error: "No receipt on file" }, 404);
    const { data: signed, error: signErr } = await db.storage.from("receipts").createSignedUrl(path, 300);
    if (signErr || !signed) return json({ error: errMsg(signErr || "sign failed") }, 500);
    return json({ ok: true, url: signed.signedUrl });
  }

  // ── verify a freshly-uploaded receipt ─────────────────────────────────────
  try {
    const bookingRef = String(body.bookingRef || "");
    const provider = normalizedProvider(String(body.provider || "gcash"));
    const imageBase64 = String(body.imageBase64 || "");
    const contentType = String(body.contentType || "image/jpeg");
    // Optional: caller passes booking data so we can verify before saving to DB.
    // When present the DB lookup and the DB update at the end are both skipped.
    const inlineBookingData = (body.bookingData && typeof body.bookingData === "object")
      ? body.bookingData as Record<string, unknown>
      : null;
    if (!bookingRef) return json({ error: "bookingRef required" }, 400);
    if (!imageBase64) return json({ error: "imageBase64 required" }, 400);

    const bytes = base64ToBytes(imageBase64);
    if (bytes.length === 0) return json({ error: "Empty image" }, 400);
    if (bytes.length > MAX_BYTES) return json({ error: "Image too large (max 5 MB)" }, 400);

    // Load the booking we are verifying against (skip if inline data provided).
    let booking: Record<string, unknown>;
    if (inlineBookingData) {
      booking = inlineBookingData;
    } else {
      const { data: bk, error: bErr } = await db
        .from("bookings")
        .select("ref, booking_group_ref, court_id, slots, total, downpayment, gcash_ref, date, payment_status, status, full_name, created_at")
        .eq("ref", bookingRef)
        .single();
      if (bErr || !bk) return json({ error: "Booking not found" }, 404);
      booking = bk as Record<string, unknown>;
    }

    const settingsRows = await db.from("settings").select("key,value");
    const settings: Record<string, string> = {};
    (settingsRows.data || []).forEach((r: { key: string; value: string }) => { settings[r.key] = r.value; });
    const expectedMerchant = expectedMerchantForProvider(settings, provider);
    const expectedNumber = expectedMerchant.number;
    const expectedName = expectedMerchant.name;
    let pricingError = "";
    let expectedAmount = Number(booking.downpayment ?? (Number(booking.total) || 0) / 2);
    let expectedTotal = Number(booking.total || 0);
    let bookingGroup: Array<Record<string, unknown>> = [booking];
    try {
      if (inlineBookingData && Number(booking.total || 0) > 0) {
        expectedTotal = roundMoney(Number(booking.total || 0));
        expectedAmount = chooseExpectedDue(expectedTotal, toNumber(booking.downpayment, expectedTotal), settings);
      } else {
        bookingGroup = await loadBookingGroup(db, booking);
        expectedAmount = await expectedBookingGroupAmount(db, bookingGroup, settings);
        expectedTotal = bookingGroupStoredTotal(bookingGroup);
      }
    } catch (err) {
      pricingError = errMsg(err);
    }
    const bookingGroupRefs = new Set(bookingGroup.map(row => String(row.ref || "")).filter(Boolean));

    // Hashes are stored for audit only. GCash validity is based on receipt details.
    const imageHash = await sha256Hex(bytes);
    const phash = await dHash(bytes);

    // Store the image immediately (evidence kept even if rejected).
    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const objectPath = `${bookingRef}/${Date.now()}.${ext}`;
    const { error: upErr } = await db.storage.from("receipts").upload(objectPath, bytes, {
      contentType,
      upsert: false,
    });
    if (upErr) console.error("receipt upload failed:", errMsg(upErr));

    const flags: string[] = [];

    // ── duplicate-image checks (exact + perceptual) ─────────────────────────
    // ── OCR ─────────────────────────────────────────────────────────────────
    const visionKey = Deno.env.get("GOOGLE_VISION_API_KEY") || "";
    // OCR.space free key (no billing required). Defaults to the public demo key.
    const ocrSpaceKey = Deno.env.get("OCRSPACE_API_KEY") || "helloworld";
    let ocrText = "";
    let ocrConfidence = 0;
    try {
      const ocr = await runOCR(visionKey, ocrSpaceKey, imageBase64, contentType);
      ocrText = ocr.text;
      ocrConfidence = ocr.confidence;
    } catch (e) {
      console.error("OCR failed (all providers):", errMsg(e));
    }
    if (!visionKey && !ocrSpaceKey) {
      // No OCR provider configured at all — cannot verify content, manual review.
      flags.push("OCR_UNAVAILABLE");
    } else if (!ocrText) {
      // OCR ran (OCR.space reliably reads genuine receipts) but found NO text.
      // That means a random photo, a blank image, or a non-receipt upload —
      // auto-reject. A real customer with a poor photo can simply re-upload.
      flags.push("IMAGE_UNREADABLE"); // HARD — random/blank/non-receipt image
    }

    // ── field extraction ────────────────────────────────────────────────────
    const typedRef = normalizeReferenceForProvider(String(booking.gcash_ref || ""), provider);
    const extractedRef = extractReference(ocrText, provider, typedRef);
    const extractedAmount = extractAmount(ocrText);
    const { date: receiptDate, shifted: receiptDateTime } = parseReceiptDateTime(ocrText);
    const bookingStartedAt = toPhWallClockDate(booking.created_at || booking.createdAt);
    const bookingStartedDate = bookingStartedAt ? bookingStartedAt.toISOString().slice(0, 10) : null;
    const receiptAgeMinutes = bookingStartedAt && receiptDateTime
      ? (receiptDateTime.getTime() - bookingStartedAt.getTime()) / 60000
      : null;
    if (provider === "gcash" && typedRef.length !== 13) {
      flags.push("REF_FORMAT_INVALID");
    }

    // ── content checks (only when OCR text exists) ──────────────────────────
    if (ocrText) {
      // Reference format
      if (!extractedRef) {
        if (provider === "gcash" && !flags.includes("REF_FORMAT_INVALID")) flags.push("REF_FORMAT_INVALID");
        else if (provider !== "gcash") flags.push("REF_UNREADABLE");
      } else if (typedRef && extractedRef !== typedRef) {
        // The ref on the receipt doesn't match what the customer typed — possible fraud.
        flags.push("REF_MISMATCH");
      }

      // Amount: allow overpay, flag underpay beyond tolerance; unreadable -> soft.
      if (pricingError) flags.push("AMOUNT_MISMATCH");
      else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
      else if (extractedAmount < expectedAmount - PESO_TOLERANCE) flags.push("AMOUNT_MISMATCH");

      // Receipt date must match the date the booking was started/submitted (PH).
      if (!receiptDate) flags.push("DATE_UNREADABLE");
      else if (bookingStartedDate && receiptDate !== bookingStartedDate) flags.push("DATE_NOT_TODAY");

      // Receipt timestamp must be inside the 15-minute slot-reservation window.
      if (!receiptDateTime) flags.push("TIME_UNREADABLE");
      else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
      else if ((receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES) flags.push("TIME_FUTURE");
      else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) flags.push("TIME_EXPIRED");

      // Receiver number.
      const numCheck = checkReceiverNumber(ocrText, expectedNumber);
      if (numCheck === "wrong") flags.push("WRONG_GCASH_NUMBER");
      else if (numCheck === "unreadable" && expectedNumber) flags.push("NUMBER_UNREADABLE");

      // Receiver name (soft).
      const nameCheck = checkReceiverName(ocrText, expectedName);
      if (nameCheck === "mismatch") flags.push("RECEIVER_NAME_MISMATCH");

      // Authenticity heuristics — HARD: a non-receipt image should be rejected outright.
      if (!looksLikeGcashReceipt(ocrText)) flags.push("SUSPECTED_FAKE");
    }
    if (editedBySoftware(bytes)) flags.push("EDITED_METADATA");

    // Low OCR confidence → soft review signal.
    if (ocrText && ocrConfidence < 0.55) flags.push("LOW_OCR_CONFIDENCE");

    // ── reference reuse / replay guard ──────────────────────────────────────
    // Use the OCR-extracted ref when available, else the customer-typed ref.
    // GCash refs are stored as digits only; other providers are namespaced so
    // same-looking references from different banks do not collide.
    const rawRefForDedupe = extractedRef || typedRef || null;
    const refForDedupe = rawRefForDedupe
      ? provider === "gcash" ? rawRefForDedupe : `${provider}:${rawRefForDedupe}`
      : null;
    let refAlreadyClaimedByThisBooking = false;
    if (refForDedupe) {
      const { data: existingRef } = await db
        .from("used_gcash_refs")
        .select("booking_ref")
        .eq("gcash_ref", refForDedupe)
        .maybeSingle();
      if (existingRef && !bookingGroupRefs.has(String(existingRef.booking_ref || ""))) flags.push("DUPLICATE_REF");
      else if (existingRef && bookingGroupRefs.has(String(existingRef.booking_ref || ""))) refAlreadyClaimedByThisBooking = true;
    }

    // ── decision routing ────────────────────────────────────────────────────
    const hasHard = flags.some((f) => HARD_FLAGS.has(f));
    const hasSoftOrUnreadable = flags.length > 0;
    let result: "auto_approved" | "manual_review" | "rejected";
    if (hasHard) result = "rejected";
    else if (hasSoftOrUnreadable) result = "manual_review";
    else result = "auto_approved";

    // Race-safe claim of the payment reference. The table's primary key on
    // gcash_ref is the source of truth: if another request claims the same ref
    // between our earlier read and this insert, this receipt becomes duplicate.
    if (result === "auto_approved" && refForDedupe && !refAlreadyClaimedByThisBooking) {
      const { error: claimErr } = await db
        .from("used_gcash_refs")
        .insert({ gcash_ref: refForDedupe, booking_ref: bookingRef, provider });
      if (claimErr) {
        console.error("payment reference claim failed:", errMsg(claimErr));
        if (!flags.includes("DUPLICATE_REF")) flags.push("DUPLICATE_REF");
        result = "rejected";
      }
    }

    const confidence = result === "auto_approved" ? Math.max(0.9, ocrConfidence)
      : result === "manual_review" ? 0.5 : 0.1;

    const extracted = {
      ref: extractedRef,
      amount: extractedAmount,
      date: receiptDate,
      time: receiptDateTime ? receiptDateTime.toISOString() : null,
      timePh12: formatPhDateTime12(receiptDateTime),
      bookingStartedAt: bookingStartedAt ? bookingStartedAt.toISOString() : null,
      bookingStartedAtPh12: formatPhDateTime12(bookingStartedAt),
      bookingStartedDate,
      receiptAgeMinutes,
      allowedPaymentWindowMinutes: PAYMENT_WINDOW_MINUTES,
      allowedPaymentEarlyToleranceMinutes: PAYMENT_EARLY_TOLERANCE_MINUTES,
      expectedAmount,
      provider,
      expectedReceiverNumber: expectedNumber || null,
      expectedReceiverName: expectedName || null,
    };

    // ── persist outcome on the booking ──────────────────────────────────────
    // Split into TWO updates so a transient failure on a single metadata field
    // (e.g. JSONB shape, missing column) cannot prevent the slot from being
    // released. Pass 1 = status invariants (the only fields that gate slot
    // availability). Pass 2 = receipt_* metadata for admin/audit display.
    const statusUpdate: Record<string, unknown> = {};
    if (result === "auto_approved") {
      const fullyPaid = expectedAmount >= expectedTotal - PESO_TOLERANCE;
      statusUpdate.payment_status = fullyPaid ? "paid" : "downpayment_paid";
      if (booking.status !== "completed" && booking.status !== "cancelled") {
        statusUpdate.status = "confirmed";
      }
    } else if (result === "manual_review") {
      statusUpdate.payment_status = "for_verification";
      if (booking.status !== "completed" && booking.status !== "cancelled") {
        statusUpdate.status = "pending";
      }
    } else if (result === "rejected") {
      // Cancel the booking immediately — invalid/fake receipt → slot must be freed.
      statusUpdate.status = "cancelled";
      statusUpdate.payment_status = "rejected";
    }

    const metadataUpdate: Record<string, unknown> = {
      receipt_image_url: objectPath,
      receipt_image_hash: imageHash,
      receipt_phash: phash,
      receipt_status: result,
      receipt_flags: flags,
      receipt_extracted: extracted,
      receipt_confidence: confidence,
      receipt_verified_at: new Date().toISOString(),
    };

    let statusUpdateError: string | null = null;
    let metadataUpdateError: string | null = null;

    // Skip DB update when booking hasn't been saved yet (pre-save verification flow).
    if (!inlineBookingData) {
      // Pass 1 — status invariants (CRITICAL for slot release on rejection).
      if (Object.keys(statusUpdate).length > 0) {
        const { data: statusRows, error: sErr } = await bookingUpdateQuery(db, booking, statusUpdate)
          .select("ref, status, payment_status");
        if (sErr) {
          statusUpdateError = errMsg(sErr);
          console.error("booking STATUS update failed:", statusUpdateError, "payload=", JSON.stringify(statusUpdate));
        } else if (!statusRows || statusRows.length === 0) {
          statusUpdateError = `No row matched ref=${bookingRef}`;
          console.error(statusUpdateError);
        }
      }
      // Pass 2 — receipt_* metadata. A failure here MUST NOT block slot release.
      const { error: mErr } = await bookingUpdateQuery(db, booking, metadataUpdate);
      if (mErr) {
        metadataUpdateError = errMsg(mErr);
        console.error("booking METADATA update failed:", metadataUpdateError);
      }

      // Last-resort fallback: if rejection's status update failed, try once
      // more with just the cancel field. The slot MUST be freed on a rejected
      // receipt — no exceptions.
      if (statusUpdateError && result === "rejected") {
        const { error: fallbackErr } = await bookingUpdateQuery(db, booking, { status: "cancelled" });
        if (fallbackErr) {
          console.error("FALLBACK cancel also failed:", errMsg(fallbackErr));
        } else {
          console.error("FALLBACK cancel succeeded after status update failure");
          statusUpdateError = null;
        }
      }
    }

    // ── audit trail (immutable) ─────────────────────────────────────────────
    await db.from("receipt_verifications").insert({
      booking_ref: bookingRef,
      result,
      flags,
      extracted,
      confidence,
      image_hash: imageHash,
      phash,
      raw_ocr_text: ocrText || null,
    });

    // ── alert admin on anything needing a human ─────────────────────────────
    if (result !== "auto_approved") {
      const icon = result === "rejected" ? "❌" : "⚠️";
      const head = result === "rejected" ? "RECEIPT REJECTED — BOOKING CANCELLED" : "RECEIPT NEEDS REVIEW";
      await sendTelegram(
        `${icon} <b>${head}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📋 Ref: <code>${bookingRef}</code>\n` +
        `👤 ${booking.full_name || "—"}\n` +
        `💰 Expected: ₱${expectedAmount.toFixed(2)}` +
        (extractedAmount != null ? ` · Seen: ₱${extractedAmount.toFixed(2)}` : "") + `\n` +
        `🚩 Flags: <code>${flags.join(", ") || "none"}</code>\n` +
        (result === "rejected" ? `🗑 Booking auto-cancelled. Slot is now free.` : `👉 Open admin panel to review the receipt.`),
      );
    }

    return json({
      ok: true,
      status: result,
      flags,
      extracted,
      confidence,
      receiptImageUrl: objectPath,
      receiptImageHash: imageHash,
      receiptPhash: phash,
      receiptVerifiedAt: metadataUpdate.receipt_verified_at,
      ...(statusUpdateError ? { warning: `status update failed: ${statusUpdateError}` } : {}),
      ...(metadataUpdateError ? { metadataWarning: metadataUpdateError } : {}),
      message:
        result === "auto_approved" ? "Payment verified."
        : result === "manual_review" ? "Received — the owner will verify your payment shortly."
        : "Your receipt could not be verified. Your booking has been cancelled — please try again with a valid receipt.",
    });
  } catch (err) {
    console.error("verify-gcash-receipt error:", errMsg(err));
    return json({ error: errMsg(err) }, 500);
  }
});
