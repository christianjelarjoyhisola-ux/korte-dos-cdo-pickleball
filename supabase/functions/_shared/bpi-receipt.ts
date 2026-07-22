export type ReceiverNumberCheck = "match" | "wrong" | "unreadable";

function digitsOnly(value: string): string {
  return String(value || "").replace(/\D/g, "");
}

function flexibleDigitPattern(digits: string): RegExp {
  return new RegExp(digits.split("").join("[\\s-]*"));
}

function normalizeMobile(value: string): string {
  let normalized = digitsOnly(value);
  if (normalized.startsWith("63")) normalized = normalized.slice(2);
  if (normalized.startsWith("0")) normalized = normalized.slice(1);
  return normalized;
}

function maskedDigitPattern(digits: string): RegExp {
  const mask = "[\\s\\-.*xX#\\u2022\\u2023\\u25E6\\u2043\\u2219]*";
  return new RegExp(digits.split("").join(mask));
}

export function isBpiConfirmationNo(value: string): boolean {
  return /^\d{10,20}$/.test(digitsOnly(value));
}

export function extractBpiConfirmationNo(
  text: string,
  typedRef = "",
): string | null {
  const normalizedTyped = digitsOnly(typedRef);
  if (
    isBpiConfirmationNo(normalizedTyped) &&
    flexibleDigitPattern(normalizedTyped).test(text)
  ) {
    return normalizedTyped;
  }

  const patterns = [
    /\bconfirmation\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{8,24}[0-9])\b/i,
    /\bconfirm(?:ation)?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{8,24}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (isBpiConfirmationNo(ref)) return ref;
  }
  return null;
}

export function extractBpiTransactionRefNo(text: string): string | null {
  const patterns = [
    /\btransaction\s*ref\.?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
    /\btransaction\s*(?:reference|ref)\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (ref.length >= 4 && ref.length <= 20) return ref;
  }
  return null;
}

export function isBpiReceipt(text: string): boolean {
  const value = text || "";
  return /\bsent\s+via\s+bpi\b/i.test(value) ||
    /\bbpi\b/i.test(value) ||
    (/\btransfer\s+successful\b/i.test(value) &&
      /\bconfirmation\s*(?:no|number|#)?\.?\b/i.test(value));
}

// BPI's current success screen does not show "InstaPay" or "QRPh". Its stable
// evidence is the success heading together with the explicit BPI sender label.
export function hasSuccessfulBpiTransfer(text: string): boolean {
  const value = text || "";
  return /\btransfer\s+successful\b/i.test(value) &&
    (/\bsent\s+via\s+bpi\b/i.test(value) || /\bbpi\b/i.test(value));
}

export function hasGcashGxiDestination(text: string): boolean {
  return /\bgcash\s*\/\s*g-?xchange\b/i.test(text) ||
    /\bg-?xchange\b/i.test(text) ||
    /\bgcash\b/i.test(text);
}

export function checkReceiverNumber(
  text: string,
  expectedRaw: string,
): ReceiverNumberCheck {
  const expected = normalizeMobile(expectedRaw);
  if (expected.length !== 10) return "unreadable";
  const last4 = expected.slice(-4);

  const fullMatches = text.match(
    /(?:\+?63|0)?9\d{2}[\s\-\u2022\u2023\u25E6\u2043\u2219*x.]*\d{2,3}[\s\-\u2022\u2023\u25E6\u2043\u2219*x.]*\d{2,4}/gi,
  ) || [];
  let sawFull = false;
  for (const match of fullMatches) {
    const normalized = normalizeMobile(match);
    if (normalized.length >= 10) {
      sawFull = true;
      if (normalized === expected) return "match";
    }
  }

  // A complete number is stronger evidence than unrelated digits elsewhere in
  // the receipt. Do not let a confirmation/reference suffix override it.
  if (sawFull) return "wrong";

  if (maskedDigitPattern(last4).test(text)) return "match";
  if (new RegExp(`(?:[\u2022*xX#\\s\\-]{2,}|\\d)${last4}\\b`).test(text)) {
    return "match";
  }
  if (text.includes(last4)) return "match";
  return "unreadable";
}
