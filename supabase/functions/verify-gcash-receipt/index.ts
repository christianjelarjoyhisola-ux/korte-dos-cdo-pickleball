// verify-gcash-receipt
// ----------------------------------------------------------------------------
// Server-side GCash / BDO Pay / GoTyme / PNB receipt verification + fraud detection.
//
// Actions (POST JSON):
//   multipart { action: "verify", bookingRef, provider, receipt, contentType }
//   JSON { action: "verify", bookingRef, provider, imageBase64, contentType }
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
// Rejections auto-cancel the booking and release its slot. Uncertain OCR fields
// must therefore route to manual review instead of becoming hard flags.
// ----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import { calculateCourtPayment, chooseExpectedDue, closeMoney, roundMoney, toNumber } from "../_shared/booking-payment.ts";
import { extractReceiptAmount } from "../_shared/receipt-amount.ts";
import {
  checkReceiverNumber,
  extractBpiConfirmationNo,
  extractBpiTransactionRefNo,
  hasGcashGxiDestination,
  hasSuccessfulBpiTransfer,
  isBpiConfirmationNo,
  isBpiReceipt,
} from "../_shared/bpi-receipt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Payment must happen within this many minutes after the booking/session join
// is started.
const PAYMENT_WINDOW_MINUTES = 15;
// OCR usually reads only minute-level timestamps. A receipt paid during the
// same minute as the hold can look a few seconds "before" the booking.
const PAYMENT_EARLY_TOLERANCE_MINUTES = 2;

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const PESO_TOLERANCE = 5; // allow ±₱5 rounding; underpay beyond this is a hard flag

// Hard flags force a rejection; soft flags force manual review.
const HARD_FLAGS = new Set([
  "REF_FORMAT_INVALID",
  "SUSPECTED_FAKE", // OCR ran and image has zero receipt-like content
  "IMAGE_UNREADABLE", // OCR found NO text at all -> random/blank/non-receipt image
  "DUPLICATE_REF",
  "DUPLICATE_INVOICE",
  "DUPLICATE_INSTAPAY_REF",
  "DUPLICATE_BPI_TRANSACTION_REF",
  "METHOD_MISMATCH",
  "REF_MISMATCH",
  "DATE_NOT_TODAY",
  "TIME_EXPIRED",
  "TIME_FUTURE",
  "WRONG_GCASH_NUMBER",
  "AMOUNT_MISMATCH", // Only hard if significantly underpaid (>₱5)
]);

type PaymentProvider = "gcash" | "bdopay" | "maya" | "bpi" | "gotyme" | "pnb";
type OcrProvider = "google_vision" | "none";

type OcrResult = {
  text: string;
  confidence: number;
  provider: OcrProvider;
  primaryProvider?: OcrProvider;
  fallbackProvider?: OcrProvider;
  fallbackReason?: string;
  error?: string;
};

function publicReceiptMessage(
  result: "auto_approved" | "manual_review" | "rejected",
  flags: string[],
): string {
  if (result === "auto_approved") return "Payment verified.";
  if (result === "manual_review") {
    return "Received - the owner will verify your payment shortly.";
  }

  const flagSet = new Set(flags);
  if (flagSet.has("AMOUNT_MISMATCH")) {
    return "Payment amount is lower than required. Please upload the correct payment receipt.";
  }
  if (
    flagSet.has("TIME_EXPIRED") || flagSet.has("TIME_FUTURE") ||
    flagSet.has("DATE_NOT_TODAY")
  ) {
    return `Payment was sent outside the allowed ${PAYMENT_WINDOW_MINUTES}-minute window. Please create a new booking.`;
  }
  if (flagSet.has("IMAGE_UNREADABLE") || flagSet.has("OCR_UNAVAILABLE")) {
    return "Receipt image is unreadable. Please upload a clearer screenshot.";
  }
  if (
    flagSet.has("SUSPECTED_FAKE") ||
    flagSet.has("GCASH_RECEIPT_UNREADABLE") ||
    flagSet.has("BDO_PAY_UNREADABLE") ||
    flagSet.has("MAYA_UNREADABLE") ||
    flagSet.has("BPI_UNREADABLE")
  ) {
    return "Payment could not be verified. Please upload a valid receipt or contact admin.";
  }
  return "Payment details do not match this booking. Please check your receipt and try again, or contact admin.";
}

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
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
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

function bytesToBase64(bytes: Uint8Array): string {
  // Build the binary string in chunks so a mobile-upload-sized image does not
  // exceed the JavaScript argument/call-stack limit.
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copy.buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
        const lGray = ((lPix >>> 24) & 0xff) + ((lPix >>> 16) & 0xff) +
          ((lPix >>> 8) & 0xff);
        const rGray = ((rPix >>> 24) & 0xff) + ((rPix >>> 16) & 0xff) +
          ((rPix >>> 8) & 0xff);
        bits += lGray < rGray ? "1" : "0";
      }
    }
    let hex = "";
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null; // HEIC/unknown formats — skip perceptual dedupe, not fatal
  }
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
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Parse a GCash-style timestamp e.g. "Jun 13, 2026 10:30 AM" into a Date
// interpreted as PH wall-clock (returned as a UTC+8-shifted Date for comparison
// against phManilaNow()). If OCR only finds the date, return the date but no
// shifted time so it routes to manual review instead of assuming midnight.
function parseReceiptDateTime(
  text: string,
): { date: string | null; shifted: Date | null } {
  const normalized = String(text || "")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const datePattern = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?[\s,.\-]+(\d{4})\b/i;
  const dateOnly = normalized.match(datePattern);
  if (!dateOnly) return { date: null, shifted: null };

  const mon = MONTHS[dateOnly[1].toLowerCase().slice(0, 3)];
  const day = parseInt(dateOnly[2], 10);
  const year = parseInt(dateOnly[3], 10);
  const dateStr = `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const afterDate = normalized.slice(
    (dateOnly.index || 0) + dateOnly[0].length,
    (dateOnly.index || 0) + dateOnly[0].length + 80,
  );
  const beforeDate = normalized.slice(
    Math.max(0, (dateOnly.index || 0) - 40),
    dateOnly.index || 0,
  );
  const timePattern = /\b(\d{1,2})\s*[:;.]\s*(\d{2})(?:\s*[:;.]\s*\d{2})?\s*([ap](?:\s*\.?\s*m\.?)?|[ap])\b/i;
  const time = afterDate.match(timePattern) || beforeDate.match(timePattern);
  if (time) {
    let hour = parseInt(time[1], 10);
    const min = parseInt(time[2], 10);
    const ap = time[3].toLowerCase().replace(/[^apm]/g, "");
    if (ap.startsWith("p") && hour !== 12) hour += 12;
    if (ap.startsWith("a") && hour === 12) hour = 0;
    const shifted = new Date(Date.UTC(year, mon, day, hour, min, 0));
    return { date: dateStr, shifted };
  }

  return { date: dateStr, shifted: null };
}

function digitsOnly(s: string): string {
  return (s || "").replace(/\D/g, "");
}

function normalizeReferenceForProvider(
  value: string,
  provider: PaymentProvider,
): string {
  const raw = value || "";
  if (provider === "gcash") return digitsOnly(raw);
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isBdoPayReference(value: string): boolean {
  return /^BN\d{16}$/.test(normalizeReferenceForProvider(value, "bdopay"));
}

function isMayaReference(value: string): boolean {
  return /^[A-Z0-9]{12}$/.test(normalizeReferenceForProvider(value, "maya"));
}

function flexibleDigitPattern(digits: string): RegExp {
  return new RegExp(digits.split("").join("[^0-9]*"));
}

// Extract candidate 13-digit GCash reference numbers from OCR text.
function extractGcashRef(text: string, typedRef = ""): string | null {
  const normalizedTyped = digitsOnly(typedRef);

  // If the customer-entered ref is visible in the OCR text, trust it. This
  // avoids false mismatches when OCR sees the receiver mobile number before the
  // "Ref No." line and a broad numeric scan accidentally joins nearby digits.
  if (
    normalizedTyped.length === 13 &&
    flexibleDigitPattern(normalizedTyped).test(text)
  ) {
    return normalizedTyped;
  }

  // Prefer numbers immediately following receipt reference labels.
  const labelPattern = /\b(?:ref(?:erence)?(?:\s*(?:no|number|#))?\.?)\s*[:#]?\s*([0-9][0-9\s-]{11,30}[0-9])/gi;
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = labelPattern.exec(text)) !== null) {
    const d = digitsOnly(labelMatch[1]);
    if (d.length === 13) return d;
    if (normalizedTyped.length === 13 && d.includes(normalizedTyped)) {
      return normalizedTyped;
    }
  }

  // Fallback: any standalone 13-digit run.
  const standalone = text.match(/\b\d{13}\b/);
  if (standalone) return standalone[0];

  // Last resort: tolerate OCR spaces inside a single long numeric group.
  // Keep this after label/typed matching because phone numbers and amounts can
  // otherwise be accidentally joined into a fake 13-digit reference.
  const cleaned = text.replace(/[^\d\s-]/g, " ");
  const groups = cleaned.match(/(?:\d[\d\s-]{11,30}\d)/g) || [];
  for (const g of groups) {
    const d = digitsOnly(g);
    if (d.length === 13) return d;
  }
  return null;
}

function extractReference(
  text: string,
  provider: PaymentProvider,
  typedRef: string,
): string | null {
  if (provider === "gcash") return extractGcashRef(text, typedRef);
  if (provider === "bpi") return extractBpiConfirmationNo(text, typedRef);

  // BDO Pay/GoTyme/PNB references are not guaranteed to be 13-digit GCash-style refs.
  // For those providers, trust the customer-entered reference only if OCR sees
  // the same alphanumeric token in the receipt text.
  const normalizedTyped = normalizeReferenceForProvider(typedRef, provider);
  if (normalizedTyped.length >= 6) {
    const normalizedText = normalizeReferenceForProvider(text, provider);
    if (normalizedText.includes(normalizedTyped)) return normalizedTyped;
  }
  return null;
}

function hasBdoPayIndicator(text: string): boolean {
  return isBdoPayReceipt(text);
}

function hasMayaIndicator(text: string): boolean {
  return isMayaReceipt(text);
}

function hasBpiIndicator(text: string): boolean {
  return hasSuccessfulBpiTransfer(text);
}

function hasInstapayQrphIndicator(text: string): boolean {
  return /\binsta\s*pay\b|\bqrph\b|\bqr\s*ph\b/i.test(text);
}

function hasBdoBnReference(text: string): boolean {
  return /\bbn[\s-]*\d{8}[\s-]*\d{8}\b/i.test(text);
}

function isBdoPayReceipt(text: string): boolean {
  const t = text || "";
  const hasBnRef = hasBdoBnReference(t);
  return /\bbdo\s*pay\b/i.test(t) ||
    /\bthank\s+you\s+for\s+using\s+bdo\b/i.test(t) ||
    (hasBnRef && /\binsta\s*pay\b/i.test(t)) ||
    (hasBnRef && /\bbdo\b/i.test(t)) ||
    (hasBnRef && extractBdoInvoiceNumber(t) !== null);
}

function isMayaReceipt(text: string): boolean {
  const t = text || "";
  return /\bmaya\b/i.test(t) &&
    (/\bsent\s+money\s+via\b/i.test(t) ||
      /\breference\s+id\b/i.test(t) ||
      /\binstapay\s+ref\b/i.test(t) ||
      /\bqrph\b|\bqr\s*ph\b/i.test(t));
}

function isGcashToGcashReceipt(text: string): boolean {
  const t = text || "";
  if (isBdoPayReceipt(t) || isMayaReceipt(t) || isBpiReceipt(t)) return false;
  return /\bsent\s+via\s+gcash\b/i.test(t) ||
    /\bsent\s+through\s+gcash\b/i.test(t) ||
    /\bgcash\s+receipt\b/i.test(t) ||
    /\btotal\s+amount\s+sent\b/i.test(t);
}

function selectedMethodMismatch(
  provider: PaymentProvider,
  text: string,
): boolean {
  const bdoReceipt = isBdoPayReceipt(text);
  const mayaReceipt = isMayaReceipt(text);
  const bpiReceipt = isBpiReceipt(text);
  const gcashReceipt = isGcashToGcashReceipt(text);
  if (provider === "gcash") return bdoReceipt || mayaReceipt || bpiReceipt;
  if (provider === "bdopay") return gcashReceipt || mayaReceipt || bpiReceipt;
  if (provider === "maya") return gcashReceipt || bdoReceipt || bpiReceipt;
  if (provider === "bpi") return gcashReceipt || bdoReceipt || mayaReceipt;
  return false;
}

function hasExpectedReceiverName(text: string, expectedName: string): boolean {
  const upper = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const expected = (expectedName || "Korte Dos").toUpperCase().replace(
    /[^A-Z0-9]/g,
    "",
  );
  if (expected.length >= 3 && upper.includes(expected)) return true;
  return upper.includes("KORTEDOS");
}

function extractBdoInvoiceNumber(text: string): string | null {
  const patterns = [
    /\binvoice\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,24}[0-9])\b/i,
    /\binv\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,24}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const invoice = match ? digitsOnly(match[1]) : "";
    if (invoice.length >= 4 && invoice.length <= 20) return invoice;
  }
  return null;
}

function extractMayaInstapayRefNo(text: string): string | null {
  const patterns = [
    /\binstapay\s*ref\.?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
    /\binstapay\s*(?:reference|ref)\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (ref.length >= 4 && ref.length <= 20) return ref;
  }
  return null;
}

function extractAmount(text: string): number | null {
  // Legacy parser for non-Maya layouts. Require a complete money token so a
  // value such as P1,080.00 can never fall through as the suffix ,080.00.
  const near = text.match(
    /(?:amount|total|php|₱|p)\s*[:\-]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d,.])/i,
  );
  if (near) return parseFloat(near[1].replace(/,/g, ""));
  const any = text.match(
    /(?<![A-Za-z0-9,])((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d,.])/,
  );
  return any ? parseFloat(any[1].replace(/,/g, "")) : null;
}

function normalizedProvider(raw: string): PaymentProvider {
  const provider = raw.toLowerCase();
  if (
    provider === "bdopay" || provider === "maya" || provider === "bpi" ||
    provider === "gotyme" || provider === "pnb"
  ) return provider;
  return "gcash";
}

function paymentMethodProvider(raw: unknown): PaymentProvider | null {
  const method = String(raw || "").toLowerCase();
  if (
    method === "gcash" || method === "bdopay" || method === "maya" ||
    method === "bpi" || method === "gotyme" || method === "pnb"
  ) {
    return method as PaymentProvider;
  }
  return null;
}

function expectedMerchantForProvider(
  settings: Record<string, string>,
  provider: PaymentProvider,
): { number: string; name: string } {
  if (provider === "bdopay") {
    return {
      number: settings.bdopay_merchant_number || "",
      name: settings.bdopay_merchant_name || settings.payment_merchant_name ||
        "Korte DOS",
    };
  }
  if (provider === "maya") {
    return {
      number: settings.maya_merchant_number || "",
      name: settings.maya_merchant_name || settings.payment_merchant_name ||
        "Korte DOS",
    };
  }
  if (provider === "bpi") {
    return {
      // BPI is used as the sending bank; the actual destination is the same
      // GCash account displayed to customers in the booking flow.
      number: settings.bpi_merchant_number || settings.gcash_merchant_number || "",
      name: settings.bpi_merchant_name || settings.gcash_merchant_name || settings.payment_merchant_name ||
        "Korte DOS",
    };
  }
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

function expectedOpenPlayAmounts(
  booking: Record<string, unknown>,
  settings: Record<string, string>,
): { total: number; due: number } {
  const cfg = (() => {
    try {
      return settings.open_play_config ? JSON.parse(settings.open_play_config) : {};
    } catch {
      return {};
    }
  })() as Record<string, unknown>;
  const openPlayFee = toNumber(cfg.fee ?? settings.open_play_fee, 100);
  const platformFee = toNumber(
    settings.maintenance_fee ?? settings.service_fee_rate ??
      settings.booking_fee,
  );
  const total = roundMoney(openPlayFee + platformFee);
  const due = chooseExpectedDue(
    total,
    toNumber(booking.downpayment, -1),
    settings.payment_acceptance_mode,
  );
  return { total, due };
}

async function expectedHostSessionAmounts(
  db: any,
  booking: Record<string, unknown>,
): Promise<{ total: number; due: number }> {
  const sessionId = String(booking.host_session_id || "");
  if (!sessionId) throw new Error("Host session id is required");
  const { data: session, error } = await db
    .from("open_play_host_sessions")
    .select("fee_per_player")
    .eq("id", sessionId)
    .single();
  if (error || !session) throw error || new Error("Host session not found");

  const total = roundMoney(toNumber(session.fee_per_player));
  if (!closeMoney(toNumber(booking.downpayment, -1), total)) {
    throw new Error(
      "Host session payment amount does not match the configured fee",
    );
  }
  return { total, due: total };
}

async function expectedBookingAmounts(
  db: any,
  booking: Record<string, unknown>,
  settings: Record<string, string>,
): Promise<{ total: number; due: number }> {
  const courtId = String(booking.court_id || "");
  if (!courtId) return expectedOpenPlayAmounts(booking, settings);

  const { data: court, error: courtErr } = await db
    .from("courts")
    .select("rate,rate_schedule")
    .eq("id", courtId)
    .single();
  if (courtErr || !court) throw courtErr || new Error("Court not found");

  const courtRow = court as Record<string, unknown>;
  return calculateCourtPayment({
    slots: booking.slots,
    courtRate: courtRow.rate,
    courtRateSchedule: courtRow.rate_schedule,
    fallbackRateSchedule: settings.pricing_tiers,
    feeRate: settings.maintenance_fee ?? settings.service_fee_rate ??
      settings.booking_fee,
    feeType: settings.fee_type,
    storedDownpayment: booking.downpayment,
    hostBooking: booking.host_booking === true,
    paymentAcceptanceMode: settings.payment_acceptance_mode,
  });
}

async function loadBookingGroup(
  db: any,
  booking: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const groupRef = String(booking.booking_group_ref || "");
  if (!groupRef) return [booking];
  const { data, error } = await db
    .from("bookings")
    .select(
      "ref, booking_group_ref, court_id, slots, total, downpayment, host_booking, gcash_ref, payment_method, date, payment_status, status, full_name, created_at",
    )
    .eq("booking_group_ref", groupRef)
    .neq("status", "cancelled");
  if (error) throw error;
  return (data || []) as Array<Record<string, unknown>>;
}

function bookingLogicalKey(row: Record<string, unknown>): string {
  const slots = Array.isArray(row.slots) ? row.slots.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  return [
    String(row.court_id || row.courtId || ""),
    String(row.date || ""),
    slots.join(","),
  ].join("|");
}

function uniqueBookingRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = bookingLogicalKey(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function expectedBookingGroupAmounts(
  db: any,
  bookings: Array<Record<string, unknown>>,
  settings: Record<string, string>,
): Promise<{ total: number; due: number }> {
  let total = 0;
  let due = 0;
  for (const row of uniqueBookingRows(bookings)) {
    const amounts = await expectedBookingAmounts(db, row, settings);
    total += amounts.total;
    due += amounts.due;
  }
  return { total: roundMoney(total), due: roundMoney(due) };
}

function bookingUpdateQuery(
  db: any,
  booking: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  const groupRef = String(booking.booking_group_ref || "");
  const query = db.from("bookings").update(update);
  return groupRef ? query.eq("booking_group_ref", groupRef) : query.eq("ref", String(booking.ref || ""));
}

// Loose masked-name match (e.g. "CO**TY**D P*CKL*B*LL" vs "KORTE DOS").
function checkReceiverName(
  text: string,
  expectedName: string,
): "match" | "mismatch" | "unreadable" {
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
    if (upper.replace(/[^A-Z]/g, "").includes(expected.slice(0, 3))) {
      return "match";
    }
    return "unreadable";
  }
  return hits >= Math.ceil(tokens.length / 2) ? "match" : "unreadable";
}

// Best-effort "looks like a real GCash receipt" heuristic (soft signal only).
function looksLikeGcashReceipt(text: string): boolean {
  const t = text.toLowerCase();
  let score = 0;
  if (/ref(?:erence)?\s*(no|number|#)/.test(t)) score++;
  if (
    /gcash|bdo\s*pay|gotyme|maya|bpi|paymongo|qrph|insta\s*pay|pesonet|g-?xchange|gxi/
      .test(t)
  ) score++;
  if (
    /sent|received|paid|transfer|amount|confirmation\s*(no|number|#)/.test(t)
  ) score++;
  if (/\d{4}/.test(t)) score++;
  return score >= 2;
}

// Best-effort JPEG "edited in image software" detector (soft signal only).
function editedBySoftware(bytes: Uint8Array): boolean {
  // Scan the first 64KB for editor signatures embedded in EXIF/XMP.
  const slice = bytes.subarray(0, Math.min(bytes.length, 65536));
  let s = "";
  for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
  return /(adobe\s*photoshop|gimp|pixlr|snapseed|picsart|lightroom|inkscape)/i
    .test(s);
}

function googleVisionConfidence(
  annotation: Record<string, unknown> | null,
  text: string,
): number {
  if (!annotation) return text.length > 40 ? 0.9 : text.length > 0 ? 0.5 : 0;
  const pages = Array.isArray(annotation.pages) ? annotation.pages as Array<Record<string, unknown>> : [];
  if (
    pages.length && typeof pages[0].confidence === "number" &&
    pages[0].confidence > 0
  ) {
    return pages[0].confidence;
  }

  let total = 0;
  let count = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    if (typeof item.confidence === "number" && item.confidence > 0) {
      total += item.confidence;
      count++;
    }
    for (const key of ["blocks", "paragraphs", "words", "symbols"]) {
      const children = item[key];
      if (Array.isArray(children)) children.forEach(visit);
    }
  };
  pages.forEach(visit);
  if (count > 0) return total / count;
  return text.length > 40 ? 0.9 : text.length > 0 ? 0.5 : 0;
}

async function googleVisionOCR(
  apiKey: string,
  base64: string,
): Promise<{ text: string; confidence: number }> {
  const content = base64.startsWith("data:") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let res: Response;
  try {
    res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            image: { content },
            features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
            imageContext: { languageHints: ["en"] },
          }],
        }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    if (controller.signal.aborted) throw new Error("Google Vision request timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vision error ${res.status}: ${errMsg(data)}`);
  const r = data?.responses?.[0];
  if (r?.error) throw new Error(`Vision: ${errMsg(r.error)}`);
  const text: string = r?.fullTextAnnotation?.text ||
    r?.textAnnotations?.[0]?.description || "";
  return {
    text,
    confidence: googleVisionConfidence(r?.fullTextAnnotation || null, text),
  };
}

// Google Vision is the only OCR engine used for receipt verification.
function ocrCriticalGaps(
  text: string,
  provider: PaymentProvider,
  typedRef: string,
): string[] {
  if (!text) return ["text"];
  const gaps: string[] = [];
  if (!extractReference(text, provider, typedRef)) gaps.push("reference");
  const mayaAmount = provider === "maya"
    ? extractReceiptAmount(text, { provider })
    : null;
  const hasReliableAmount = mayaAmount
    ? mayaAmount.amount != null && mayaAmount.reliable
    : extractAmount(text) != null;
  if (!hasReliableAmount) gaps.push("amount");
  if (!parseReceiptDateTime(text).date) gaps.push("date");
  return gaps;
}

async function runOCR(
  visionKey: string,
  base64: string,
  provider: PaymentProvider,
  typedRef: string,
): Promise<OcrResult> {
  if (visionKey) {
    try {
      const v = await googleVisionOCR(visionKey, base64);
      const gaps = ocrCriticalGaps(v.text, provider, typedRef);
      if (v.text && gaps.length === 0) {
        return {
          ...v,
          provider: "google_vision",
          primaryProvider: "google_vision",
        };
      }
      if (v.text) {
        return {
          ...v,
          provider: "google_vision",
          primaryProvider: "google_vision",
          fallbackReason: gaps.length ? `google_missing_${gaps.join("_")}` : undefined,
        };
      }
      console.error("Vision OCR returned no text:", gaps.join(","));
      return {
        ...v,
        provider: "google_vision",
        primaryProvider: "google_vision",
      };
    } catch (e) {
      console.error("Vision OCR failed:", errMsg(e));
      return {
        text: "",
        confidence: 0,
        provider: "none",
        primaryProvider: "google_vision",
        error: errMsg(e),
      };
    }
  }
  return { text: "", confidence: 0, provider: "none" };
}

async function sendTelegram(message: string) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const chatIdRaw = Deno.env.get("TELEGRAM_CHAT_ID") || "";
  if (!botToken || !chatIdRaw) return;
  const chatIds = chatIdRaw.split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.allSettled(
    chatIds.map((chatId) =>
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
        }),
      })
    ),
  );
}

// ── handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ error: "Missing SERVICE_ROLE_KEY" }, 500);
  const db = createClient(supabaseUrl, serviceRoleKey);

  const requestLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(requestLength) && requestLength > MAX_REQUEST_BYTES) {
    return json({ error: "Request too large" }, 413);
  }

  let body: Record<string, unknown>;
  let uploadedImage: File | null = null;
  const requestContentType = req.headers.get("content-type") || "";
  try {
    if (requestContentType.toLowerCase().includes("multipart/form-data")) {
      const form = await req.formData();
      const bookingDataRaw = String(form.get("bookingData") || "");
      let bookingData: Record<string, unknown> | null = null;
      if (bookingDataRaw) {
        try {
          const parsed = JSON.parse(bookingDataRaw);
          if (parsed && typeof parsed === "object") bookingData = parsed;
        } catch {
          return json({ error: "Invalid bookingData JSON" }, 400);
        }
      }
      const receipt = form.get("receipt");
      if (receipt instanceof File) uploadedImage = receipt;
      body = {
        action: String(form.get("action") || "verify"),
        bookingRef: String(form.get("bookingRef") || ""),
        provider: String(form.get("provider") || "gcash"),
        contentType: uploadedImage?.type || String(form.get("contentType") || "image/jpeg"),
        ...(bookingData ? { bookingData } : {}),
      };
    } else {
      body = await req.json();
    }
  } catch {
    return json({ error: requestContentType.toLowerCase().includes("multipart/form-data") ? "Invalid multipart body" : "Invalid JSON body" }, 400);
  }
  const action = (body.action as string) || "verify";

  // ── admin-only: mint a signed URL to view a stored receipt ────────────────
  if (action === "sign") {
    const bookingRef = String(body.bookingRef || "");
    const openPlayRegistrationId = String(body.openPlayRegistrationId || "");
    const hostSessionRegistrationId = String(
      body.hostSessionRegistrationId || "",
    );
    if (!bookingRef && !openPlayRegistrationId && !hostSessionRegistrationId) {
      return json({
        error: "bookingRef, openPlayRegistrationId, or hostSessionRegistrationId required",
      }, 400);
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
      const { data: bk } = await db.from("bookings").select("receipt_image_url")
        .eq("ref", bookingRef).single();
      path = bk?.receipt_image_url || null;
    }
    if (!path) return json({ error: "No receipt on file" }, 404);
    const { data: signed, error: signErr } = await db.storage.from("receipts")
      .createSignedUrl(path, 300);
    if (signErr || !signed) {
      return json({ error: errMsg(signErr || "sign failed") }, 500);
    }
    return json({ ok: true, url: signed.signedUrl });
  }

  // ── verify a freshly-uploaded receipt ─────────────────────────────────────
  try {
    const bookingRef = String(body.bookingRef || "");
    let provider = normalizedProvider(String(body.provider || "gcash"));
    let imageBase64 = String(body.imageBase64 || "");
    const rawContentType = String(uploadedImage?.type || body.contentType || "image/jpeg")
      .toLowerCase().split(";", 1)[0].trim();
    const contentType = rawContentType === "image/jpg" ? "image/jpeg" : rawContentType;
    // Optional inline data supports pre-save Open Play registration receipts.
    // A matching saved booking still takes precedence over every inline field.
    const inlineBookingData = (body.bookingData && typeof body.bookingData === "object") ? body.bookingData as Record<string, unknown> : null;
    if (!bookingRef) return json({ error: "bookingRef required" }, 400);
    if (!imageBase64 && !uploadedImage) return json({ error: "receipt file or imageBase64 required" }, 400);

    const bytes = uploadedImage
      ? new Uint8Array(await uploadedImage.arrayBuffer())
      : base64ToBytes(imageBase64);
    if (bytes.length === 0) return json({ error: "Empty image" }, 400);
    if (bytes.length > MAX_BYTES) {
      return json({ error: "Image too large (max 5 MB)" }, 400);
    }
    // A saved court booking is always authoritative. Inline data exists for
    // pre-save Open Play registrations; it must never override a persisted
    // booking's price, host flag, payment method, or customer identity.
    const { data: persistedRow, error: bookingErr } = await db
      .from("bookings")
      .select(
        "ref, booking_group_ref, court_id, slots, total, downpayment, host_booking, gcash_ref, payment_method, date, payment_status, status, full_name, created_at, receipt_image_url, receipt_image_hash, receipt_phash, receipt_status, receipt_flags, receipt_extracted, receipt_confidence, receipt_verified_at",
      )
      .eq("ref", bookingRef)
      .maybeSingle();
    if (bookingErr) return json({ error: "Booking could not be loaded" }, 500);

    let booking: Record<string, unknown>;
    let inlinePricingKind: "open_play" | "host_session" | null = null;
    const hasPersistedBooking = !!persistedRow;
    if (persistedRow) {
      booking = { ...(persistedRow as Record<string, unknown>) };
      const persistedStatus = String(booking.status || "");
      const persistedPaymentStatus = String(booking.payment_status || "");
      const terminal = ["confirmed", "cancelled", "completed"].includes(persistedStatus) ||
        ["paid", "downpayment_paid", "rejected"].includes(persistedPaymentStatus);
      if (terminal) {
        const storedReceiptStatus = String(booking.receipt_status || "");
        const finalStatus = storedReceiptStatus === "rejected" || persistedStatus === "cancelled" || persistedPaymentStatus === "rejected"
          ? "rejected"
          : storedReceiptStatus === "manual_review"
          ? "manual_review"
          : "auto_approved";
        return json({
          ok: true,
          status: finalStatus,
          flags: [],
          publicReason: finalStatus === "rejected" ? "This booking was already rejected." : finalStatus === "manual_review" ? "This booking is already awaiting owner review." : "Payment was already verified.",
          extracted: booking.receipt_extracted || null,
          confidence: booking.receipt_confidence ?? null,
          receiptImageUrl: booking.receipt_image_url || null,
          receiptImageHash: booking.receipt_image_hash || null,
          receiptPhash: booking.receipt_phash || null,
          receiptVerifiedAt: booking.receipt_verified_at || null,
          message: "This booking has already been processed.",
        });
      }
      // Timing is the only field an inline payload may supplement for a saved
      // booking, and only when the persisted value is absent.
      if (!booking.created_at && inlineBookingData?.created_at) {
        booking.created_at = inlineBookingData.created_at;
      }
      if (!booking.date && inlineBookingData?.date) {
        booking.date = inlineBookingData.date;
      }
    } else {
      if (!inlineBookingData) return json({ error: "Booking not found" }, 404);
      const hasCourtShape = !!(
        inlineBookingData.court_id ||
        inlineBookingData.courtId ||
        inlineBookingData.booking_group_ref ||
        inlineBookingData.groupRef ||
        (Array.isArray(inlineBookingData.slots) &&
          inlineBookingData.slots.length > 0) ||
        inlineBookingData.host_booking === true ||
        inlineBookingData.hostBooking === true
      );
      if (hasCourtShape) {
        return json({
          error: "Court booking must be saved before receipt verification",
        }, 400);
      }
      booking = inlineBookingData;
      inlinePricingKind = booking.host_session_id ? "host_session" : "open_play";
    }
    provider = paymentMethodProvider(booking.payment_method ?? booking.paymentMethod) ||
      provider;

    // Save the evidence before pricing, perceptual hashing, or OCR. Large
    // mobile screenshots can make those later steps slow or memory-heavy; a
    // disconnect there must never leave the owner without the paid receipt.
    const imageHash = await sha256Hex(bytes);
    const ext = contentType.includes("png") ? "png" :
      contentType.includes("webp") ? "webp" :
      contentType.includes("heic") || contentType.includes("heif") ? "heic" : "jpg";
    const objectPath = `${bookingRef}/${imageHash}.${ext}`;
    console.log("receipt checkpoint: storing", {
      bookingRef,
      bytes: bytes.length,
      contentType,
    });
    const { error: upErr } = await db.storage.from("receipts").upload(
      objectPath,
      bytes,
      {
        contentType,
        // The hash-derived path makes a customer retry idempotent.
        upsert: true,
      },
    );
    if (upErr) {
      console.error("receipt upload failed:", errMsg(upErr));
      return json({
        error: "Receipt image could not be stored. Please upload the receipt again.",
      }, 500);
    }

    if (hasPersistedBooking) {
      const { data: safeRows, error: safeStateErr } = await bookingUpdateQuery(
        db,
        booking,
        {
          status: "pending",
          payment_status: "for_verification",
          receipt_image_url: objectPath,
          receipt_image_hash: imageHash,
          receipt_status: "manual_review",
          receipt_flags: [],
        },
      ).in("status", ["verifying", "pending"]).select("ref");
      if (safeStateErr || !safeRows?.length) {
        console.error(
          "receipt safe-state update failed:",
          safeStateErr ? errMsg(safeStateErr) : "no active booking rows updated",
        );
        return json({
          error: "Receipt was stored but could not be attached to the booking. Please contact the owner with your booking reference.",
        }, 500);
      }
      booking = {
        ...booking,
        status: "pending",
        payment_status: "for_verification",
        receipt_image_url: objectPath,
        receipt_image_hash: imageHash,
        receipt_status: "manual_review",
      };
      console.log("receipt checkpoint: attached", {
        bookingRef,
        rows: safeRows.length,
        objectPath,
      });
    }

    const settingsRows = await db.from("settings").select("key,value");
    const settings: Record<string, string> = {};
    (settingsRows.data || []).forEach((r: { key: string; value: string }) => {
      settings[r.key] = r.value;
    });
    const expectedMerchant = expectedMerchantForProvider(settings, provider);
    const expectedNumber = expectedMerchant.number;
    const expectedName = expectedMerchant.name;
    let pricingError = "";
    let expectedAmount = 0;
    let expectedTotal = 0;
    let bookingGroup: Array<Record<string, unknown>> = [booking];
    try {
      if (inlinePricingKind === "host_session") {
        const amounts = await expectedHostSessionAmounts(db, booking);
        expectedTotal = amounts.total;
        expectedAmount = amounts.due;
      } else if (inlinePricingKind === "open_play") {
        const amounts = expectedOpenPlayAmounts(booking, settings);
        expectedTotal = amounts.total;
        expectedAmount = amounts.due;
      } else {
        bookingGroup = await loadBookingGroup(db, booking);
        const amounts = await expectedBookingGroupAmounts(
          db,
          bookingGroup,
          settings,
        );
        expectedTotal = amounts.total;
        expectedAmount = amounts.due;
      }
    } catch (err) {
      pricingError = errMsg(err);
    }
    const bookingGroupRefs = new Set(
      bookingGroup.map((row) => String(row.ref || "")).filter(Boolean),
    );

    // Hashes are stored for audit only. GCash validity is based on receipt details.
    const phash = await dHash(bytes);

    // Google Vision still expects base64. Delay this allocation until after
    // Storage and the manual-review checkpoint have safely completed.
    if (!imageBase64) imageBase64 = bytesToBase64(bytes);

    const flags: string[] = [];

    // Do not flag duplicate-looking images. GCash/BDO Pay/Maya receipt screens
    // share the same layout, so perceptual image matching creates false flags.
    // Reuse protection is handled by exact payment refs/invoices below.

    // ── OCR ─────────────────────────────────────────────────────────────────
    const visionKey = Deno.env.get("GOOGLE_VISION_API_KEY") || "";
    const typedRef = normalizeReferenceForProvider(
      String(booking.gcash_ref || ""),
      provider,
    );
    let ocrText = "";
    let ocrConfidence = 0;
    let ocrProvider: OcrResult["provider"] = "none";
    let ocrPrimaryProvider: OcrResult["primaryProvider"] = "none";
    let ocrFallbackProvider: OcrResult["fallbackProvider"] | null = null;
    let ocrFallbackReason: string | null = null;
    let ocrError: string | null = null;
    try {
      const ocr = await runOCR(visionKey, imageBase64, provider, typedRef);
      ocrText = ocr.text;
      ocrConfidence = ocr.confidence;
      ocrProvider = ocr.provider;
      ocrPrimaryProvider = ocr.primaryProvider || ocr.provider;
      ocrFallbackProvider = ocr.fallbackProvider || null;
      ocrFallbackReason = ocr.fallbackReason || null;
      ocrError = ocr.error || null;
    } catch (e) {
      console.error("Google Vision OCR failed:", errMsg(e));
    }
    if (!visionKey) {
      // No OCR provider configured at all — cannot verify content, manual review.
      flags.push("OCR_UNAVAILABLE");
    } else if (ocrError) {
      // Provider/network failures are uncertain and must go to manual review;
      // they are not evidence that the customer uploaded a fake receipt.
      flags.push("OCR_UNAVAILABLE");
    } else if (!ocrText) {
      // Google Vision ran but found NO text.
      // That means a random photo, a blank image, or a non-receipt upload —
      // auto-reject. A real customer with a poor photo can simply re-upload.
      flags.push("IMAGE_UNREADABLE"); // HARD — random/blank/non-receipt image
    }

    // ── field extraction ────────────────────────────────────────────────────
    const extractedRef = extractReference(ocrText, provider, typedRef);
    const extractedInvoice = provider === "bdopay" ? extractBdoInvoiceNumber(ocrText) : null;
    const extractedInstapayRefNo = provider === "maya" ? extractMayaInstapayRefNo(ocrText) : null;
    const extractedBpiTransactionRefNo = provider === "bpi" ? extractBpiTransactionRefNo(ocrText) : null;
    const amountExtraction = provider === "maya"
      ? extractReceiptAmount(ocrText, { provider })
      : null;
    // A weak or ambiguous Maya read is never evidence of underpayment. It is
    // stored for diagnostics but routed to manual review as unreadable.
    const extractedAmount = amountExtraction
      ? (amountExtraction.reliable ? amountExtraction.amount : null)
      : extractAmount(ocrText);
    const { date: receiptDate, shifted: receiptDateTime } = parseReceiptDateTime(ocrText);
    const bookingStartedAt = toPhWallClockDate(
      booking.created_at || booking.createdAt,
    );
    const bookingStartedDate = bookingStartedAt ? bookingStartedAt.toISOString().slice(0, 10) : null;
    const receiptAgeMinutes = bookingStartedAt && receiptDateTime ? (receiptDateTime.getTime() - bookingStartedAt.getTime()) / 60000 : null;
    if (provider === "gcash" && typedRef.length !== 13) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "bdopay" && !isBdoPayReference(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "maya" && !isMayaReference(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "bpi" && !isBpiConfirmationNo(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }

    // ── content checks (only when OCR text exists) ──────────────────────────
    if (ocrText) {
      if (selectedMethodMismatch(provider, ocrText)) {
        flags.push("METHOD_MISMATCH");
      }

      if (provider === "gcash") {
        // GCash-to-GCash focused path. The receipt layout is consistent but OCR
        // can miss the small right-aligned timestamp, so unreadable date/time is
        // not a failure for GCash. Parsed dates/times are still enforced.
        if (!extractedRef && !flags.includes("REF_FORMAT_INVALID")) {
          flags.push("REF_FORMAT_INVALID");
        } else if (typedRef && extractedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("AMOUNT_MISMATCH");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          flags.push("AMOUNT_MISMATCH");
        }

        if (
          receiptDate && bookingStartedDate &&
          receiptDate !== bookingStartedDate
        ) flags.push("DATE_NOT_TODAY");
        if (receiptDateTime && bookingStartedAt) {
          if (
            (receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES
          ) flags.push("TIME_FUTURE");
          else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
            flags.push("TIME_EXPIRED");
          }
        }

        if (!isGcashToGcashReceipt(ocrText)) {
          flags.push("GCASH_RECEIPT_UNREADABLE");
        }

        const numCheck = checkReceiverNumber(ocrText, expectedNumber);
        if (numCheck === "wrong") flags.push("WRONG_GCASH_NUMBER");
        else if (numCheck === "unreadable" && expectedNumber) {
          flags.push("NUMBER_UNREADABLE");
        }

        const nameCheck = checkReceiverName(ocrText, expectedName);
        if (nameCheck === "mismatch") flags.push("RECEIVER_NAME_MISMATCH");
      } else if (provider === "bdopay") {
        // BDO Pay focused path: do not require GCash/GXI/Maya evidence here.
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("AMOUNT_MISMATCH");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          flags.push("AMOUNT_MISMATCH");
        }

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) {
          flags.push("DATE_NOT_TODAY");
        }
        if (!receiptDateTime) flags.push("TIME_UNREADABLE");
        else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
        else if (
          (receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES
        ) flags.push("TIME_FUTURE");
        else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
          flags.push("TIME_EXPIRED");
        }

        if (!hasBdoPayIndicator(ocrText)) flags.push("BDO_PAY_UNREADABLE");
        if (!hasExpectedReceiverName(ocrText, expectedName)) {
          flags.push("RECEIVER_NAME_UNREADABLE");
        }
        if (!extractedInvoice) flags.push("INVOICE_UNREADABLE");
      } else if (provider === "maya") {
        // Maya focused path: do not require GCash/GXI/BDO Pay evidence here.
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("AMOUNT_MISMATCH");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          // Maya's flattened OCR can still turn a damaged/split thousands
          // value into a plausible smaller number. Keep the booking pending
          // for an owner to compare with the stored image; never auto-approve
          // the short amount and never auto-cancel from this heuristic alone.
          flags.push("AMOUNT_REVIEW");
        }

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) {
          flags.push("DATE_NOT_TODAY");
        }
        if (!receiptDateTime) flags.push("TIME_UNREADABLE");
        else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
        else if (
          (receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES
        ) flags.push("TIME_FUTURE");
        else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
          flags.push("TIME_EXPIRED");
        }

        if (!hasMayaIndicator(ocrText)) flags.push("MAYA_UNREADABLE");
        if (!hasInstapayQrphIndicator(ocrText)) {
          flags.push("INSTAPAY_QRPH_UNREADABLE");
        }
        if (!hasExpectedReceiverName(ocrText, expectedName)) {
          flags.push("RECEIVER_NAME_UNREADABLE");
        }
      } else if (provider === "bpi") {
        // BPI focused path. Current BPI success receipts identify the sender as
        // BPI and the destination as GCash/G-Xchange, but they do not print
        // "InstaPay"/"QRPh" and they mask the receiver name. Verify the exact
        // destination number instead of requiring those unavailable labels.
        if (!extractedRef) flags.push("BPI_CONFIRMATION_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }
        if (!extractedBpiTransactionRefNo) {
          flags.push("BPI_TRANSACTION_UNREADABLE");
        }

        if (pricingError) flags.push("AMOUNT_MISMATCH");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount && !closeMoney(extractedAmount, expectedAmount)) {
          flags.push("AMOUNT_MISMATCH");
        } else if (!closeMoney(extractedAmount, expectedAmount)) {
          flags.push("AMOUNT_REVIEW");
        }

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) {
          flags.push("DATE_NOT_TODAY");
        }
        if (!receiptDateTime) flags.push("TIME_UNREADABLE");
        else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
        else if (
          (receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES
        ) flags.push("TIME_FUTURE");
        else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
          flags.push("TIME_EXPIRED");
        }

        if (!hasBpiIndicator(ocrText)) flags.push("BPI_UNREADABLE");
        if (!hasGcashGxiDestination(ocrText)) {
          flags.push("GXI_DESTINATION_UNREADABLE");
        }
        const numCheck = checkReceiverNumber(ocrText, expectedNumber);
        if (numCheck === "wrong") flags.push("WRONG_GCASH_NUMBER");
        else if (numCheck === "unreadable") {
          flags.push("NUMBER_UNREADABLE");
        }
      } else {
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("AMOUNT_MISMATCH");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          flags.push("AMOUNT_MISMATCH");
        }
      }

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
    const refForDedupe = rawRefForDedupe ? provider === "gcash" ? rawRefForDedupe : `${provider}:${rawRefForDedupe}` : null;
    const dedupeKeys: Array<
      { key: string; providerKey: string; duplicateFlag: string }
    > = [];
    if (refForDedupe) {
      dedupeKeys.push({
        key: refForDedupe,
        providerKey: provider,
        duplicateFlag: "DUPLICATE_REF",
      });
    }
    if (provider === "bdopay" && extractedInvoice) {
      dedupeKeys.push({
        key: `bdopay_invoice:${extractedInvoice}`,
        providerKey: "bdopay_invoice",
        duplicateFlag: "DUPLICATE_INVOICE",
      });
    }
    if (provider === "maya" && extractedInstapayRefNo) {
      dedupeKeys.push({
        key: `maya_instapay:${extractedInstapayRefNo}`,
        providerKey: "maya_instapay",
        duplicateFlag: "DUPLICATE_INSTAPAY_REF",
      });
    }
    if (provider === "bpi" && extractedBpiTransactionRefNo) {
      dedupeKeys.push({
        key: `bpi_transaction:${extractedBpiTransactionRefNo}`,
        providerKey: "bpi_transaction",
        duplicateFlag: "DUPLICATE_BPI_TRANSACTION_REF",
      });
    }

    const alreadyClaimedByThisBooking = new Set<string>();
    for (const item of dedupeKeys) {
      const { data: existingRef } = await db
        .from("used_gcash_refs")
        .select("booking_ref")
        .eq("gcash_ref", item.key)
        .maybeSingle();
      if (
        existingRef &&
        !bookingGroupRefs.has(String(existingRef.booking_ref || ""))
      ) {
        flags.push(item.duplicateFlag);
      } else if (
        existingRef &&
        bookingGroupRefs.has(String(existingRef.booking_ref || ""))
      ) {
        alreadyClaimedByThisBooking.add(item.key);
      }
    }

    // ── decision routing ────────────────────────────────────────────────────
    const hasHard = flags.some((f) => HARD_FLAGS.has(f));
    const hasSoftOrUnreadable = flags.length > 0;
    let result: "auto_approved" | "manual_review" | "rejected";
    if (hasHard) result = "rejected";
    else if (hasSoftOrUnreadable) result = "manual_review";
    else result = "auto_approved";

    // Race-safe claim of payment ledger keys. The table's primary key on
    // gcash_ref is the source of truth if another request claims the same key.
    if (result === "auto_approved") {
      for (const item of dedupeKeys) {
        if (alreadyClaimedByThisBooking.has(item.key)) continue;
        const { error: claimErr } = await db
          .from("used_gcash_refs")
          .insert({
            gcash_ref: item.key,
            booking_ref: bookingRef,
            provider: item.providerKey,
          });
        if (claimErr) {
          console.error("payment ledger claim failed:", errMsg(claimErr));
          // A concurrent retry for the same booking can lose the primary-key
          // insert race. Re-read ownership before treating it as payment reuse.
          const { data: claimedRef } = await db
            .from("used_gcash_refs")
            .select("booking_ref")
            .eq("gcash_ref", item.key)
            .maybeSingle();
          if (claimedRef && bookingGroupRefs.has(String(claimedRef.booking_ref || ""))) {
            alreadyClaimedByThisBooking.add(item.key);
            continue;
          }
          if (!flags.includes(item.duplicateFlag)) flags.push(item.duplicateFlag);
          result = "rejected";
          break;
        }
      }
    }

    const confidence = result === "auto_approved" ? Math.max(0.9, ocrConfidence) : result === "manual_review" ? 0.5 : 0.1;

    const extracted = {
      ref: extractedRef,
      invoice: extractedInvoice,
      instapayRefNo: extractedInstapayRefNo,
      bpiConfirmationNo: provider === "bpi" ? extractedRef : null,
      bpiTransactionRefNo: extractedBpiTransactionRefNo,
      amount: extractedAmount,
      amountReliable: amountExtraction?.reliable ?? (extractedAmount != null),
      amountAmbiguous: amountExtraction?.ambiguous ?? false,
      amountReason: amountExtraction?.reason || "legacy_parser",
      amountEvidence: amountExtraction?.evidence || [],
      amountCandidates: amountExtraction?.candidates.map((candidate) => ({
        amount: candidate.amount,
        score: candidate.score,
        evidence: candidate.evidence,
        excluded: candidate.excluded,
        exclusionReasons: candidate.exclusionReasons,
      })) || [],
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
      ocrProvider,
      ocrPrimaryProvider,
      ocrFallbackProvider,
      ocrFallbackReason,
      ocrConfidence,
      ocrTextLength: ocrText.length,
      expectedReceiverNumber: provider === "bdopay" || provider === "maya" ? null : expectedNumber || null,
      expectedReceiverName: provider === "bpi" ? null : expectedName || null,
    };

    // ── persist outcome on the booking ──────────────────────────────────────
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

    let finalUpdateError: string | null = null;

    // Skip DB update when booking hasn't been saved yet (pre-save verification flow).
    if (hasPersistedBooking) {
      // Metadata and final status must be one conditional update. This acts as
      // a compare-and-set: one concurrent verifier can finalize a row, while a
      // later verifier cannot overwrite that terminal outcome or its evidence.
      const finalUpdate = { ...metadataUpdate, ...statusUpdate };
      const { data: updatedRows, error: updateErr } = await bookingUpdateQuery(
        db,
        booking,
        finalUpdate,
      )
        .in("status", ["verifying", "pending"])
        .select("ref, status, payment_status");
      if (updateErr) {
        finalUpdateError = errMsg(updateErr);
        console.error("booking FINAL update failed:", finalUpdateError);
      } else if (!updatedRows || updatedRows.length === 0) {
        // A zero-row CAS commonly means a concurrent request already finalized
        // the booking. Confirm that before reporting a persistence failure.
        const { data: currentRow } = await db.from("bookings")
          .select("status, payment_status")
          .eq("ref", bookingRef)
          .maybeSingle();
        const currentStatus = String(currentRow?.status || "");
        const currentPayment = String(currentRow?.payment_status || "");
        const concurrentlyFinalized = ["confirmed", "cancelled", "completed"].includes(currentStatus) ||
          ["paid", "downpayment_paid", "rejected"].includes(currentPayment);
        if (!concurrentlyFinalized) {
          finalUpdateError = `No non-terminal row matched ref=${bookingRef}`;
          console.error(finalUpdateError);
        }
      }

      // Last-resort fallback: if a rejected receipt's atomic update failed, try
      // more with just the cancel field. The slot MUST be freed on a rejected
      // receipt — no exceptions.
      if (finalUpdateError && result === "rejected") {
        const { data: fallbackRows, error: fallbackErr } = await bookingUpdateQuery(db, booking, {
          status: "cancelled",
          payment_status: "rejected",
        }).in("status", ["verifying", "pending"]).select("ref");
        if (fallbackErr || !fallbackRows || fallbackRows.length === 0) {
          console.error("FALLBACK cancel also failed:", errMsg(fallbackErr));
        } else {
          console.error(
            "FALLBACK cancel succeeded after status update failure",
          );
          finalUpdateError = null;
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
          (extractedAmount != null ? ` · Seen: ₱${extractedAmount.toFixed(2)}` : "") +
          `\n` +
          `🚩 Flags: <code>${flags.join(", ") || "none"}</code>\n` +
          (result === "rejected" ? `🗑 Booking auto-cancelled. Slot is now free.` : `👉 Open admin panel to review the receipt.`),
      );
    }

    return json({
      ok: true,
      status: result,
      flags: [],
      publicReason: publicReceiptMessage(result, flags),
      extracted,
      confidence,
      receiptImageUrl: objectPath,
      receiptImageHash: imageHash,
      receiptPhash: phash,
      receiptVerifiedAt: metadataUpdate.receipt_verified_at,
      ...(finalUpdateError ? { warning: `booking update failed: ${finalUpdateError}` } : {}),
      message: result === "auto_approved" ? "Payment verified." : result === "manual_review" ? "Received — the owner will verify your payment shortly." : "Your receipt could not be verified. Your booking has been cancelled — please try again with a valid receipt.",
    });
  } catch (err) {
    console.error("verify-gcash-receipt error:", errMsg(err));
    return json({ error: errMsg(err) }, 500);
  }
});
