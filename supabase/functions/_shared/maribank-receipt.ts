export type MariBankDestinationCheck =
  | "match"
  | "wrong"
  | "unreadable"
  | "unconfigured";

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

function digitsOnly(value: string): string {
  return String(value || "").replace(/\D/g, "");
}

function flexibleDigitPattern(digits: string): RegExp {
  return new RegExp(digits.split("").join("[\\s-]*"));
}

export function normalizeMariBankAccountId(value: string): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isMariBankAccountId(value: string): boolean {
  const normalized = normalizeMariBankAccountId(value);
  return /^[A-Z0-9]{12,24}$/.test(normalized) &&
    /[A-Z]/.test(normalized) && /\d/.test(normalized);
}

function parseMoney(value: string): number | null {
  const normalized = String(value || "").replace(/,/g, "");
  if (!/^\d+(?:\.\d{2})$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function extractLabeledMoney(text: string, label: RegExp): number | null {
  const value = String(text || "");
  const money = String.raw`((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})`;
  const marker = String.raw`(?:PHP|\u20B1|P)?`;
  const match = value.match(
    new RegExp(
      `${label.source}\\s*[:=\\-]?\\s*${marker}\\s*${money}(?![\\d,.])`,
      "i",
    ),
  );
  return match ? parseMoney(match[1]) : null;
}

// MariBank's current PH transfer receipt shows a six-digit Reference Number.
// Keep it as a string because leading zeroes are significant.
export function isMariBankReference(value: string): boolean {
  return /^\d{6}$/.test(String(value || "").trim());
}

export function extractMariBankReference(
  text: string,
  typedRef = "",
): string | null {
  const value = String(text || "");
  const patterns = [
    /\breference\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9 \t-]{4,12}[0-9])\b/i,
    /\bref\.?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9 \t-]{4,12}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const reference = match ? digitsOnly(match[1]) : "";
    if (isMariBankReference(reference)) return reference;
  }

  // OCR sometimes separates the label and digits more aggressively. Only use
  // the customer-entered value when it is near the receipt's reference label;
  // six bare digits elsewhere can be a time, amount, or account suffix.
  if (!isMariBankReference(typedRef)) return null;
  const normalizedTyped = digitsOnly(typedRef);
  const labelIndex = value.search(
    /\b(?:reference|ref\.?)\s*(?:no|number|#)?\b/i,
  );
  if (labelIndex < 0) return null;
  const referenceWindow = value.slice(labelIndex, labelIndex + 80);
  return flexibleDigitPattern(normalizedTyped).test(referenceWindow)
    ? normalizedTyped
    : null;
}

export function extractMariBankTransferAmount(text: string): number | null {
  return extractLabeledMoney(text, /\btransfer\s+amount\b/i);
}

export function extractMariBankTotalAmount(text: string): number | null {
  return extractLabeledMoney(text, /\btotal\s+amount\b/i);
}

export function isMariBankReceipt(text: string): boolean {
  const value = String(text || "");
  const hasBrand = /\bmari[\s-]*bank\b/i.test(value);
  return hasBrand &&
    (/\btransaction\s+receipt\b/i.test(value) ||
      /\breceipt\s+generated\s+from\s+mari[\s-]*bank\s+app\b/i.test(value) ||
      /\bprocessing\s+time\b/i.test(value));
}

// The supplied layout has no separate "successful" line. Its stable completed
// state is a generated transaction receipt marked Realtime and InstaPay.
export function hasSuccessfulMariBankTransfer(text: string): boolean {
  const value = String(text || "");
  return isMariBankReceipt(value) &&
    /\btransaction\s+receipt\b/i.test(value) &&
    /\btransfer\s+method\b[\s\S]{0,40}\binsta\s*pay\b/i.test(value) &&
    /\bprocessing\s+time\b[\s\S]{0,40}\breal\s*time\b/i.test(value);
}

export function extractMariBankDestinationAccount(
  text: string,
): string | null {
  const value = String(text || "");
  const patterns = [
    /\bto\b[\s\S]{0,240}?\bg-?\s*xchange\s*\/\s*gcash\b[\s\S]{0,120}?\b(?:acct|account)\s*(?:no|number)?\.?\s*[:#]?[ \t]*(?:\r?\n[ \t]*)?([A-Z0-9]{12,24})\b/i,
    /\bg-?\s*xchange\s*\/\s*gcash\b[\s\S]{0,120}?\b(?:acct|account)\s*(?:no|number)?\.?\s*[:#]?[ \t]*(?:\r?\n[ \t]*)?([A-Z0-9]{12,24})\b/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const accountId = match ? normalizeMariBankAccountId(match[1]) : "";
    if (isMariBankAccountId(accountId)) return accountId;
  }
  return null;
}

export function checkMariBankDestinationAccount(
  text: string,
  expectedRaw: string,
): MariBankDestinationCheck {
  const expected = normalizeMariBankAccountId(expectedRaw);
  if (!isMariBankAccountId(expected)) return "unconfigured";
  const extracted = extractMariBankDestinationAccount(text);
  if (!extracted) return "unreadable";
  return extracted === expected ? "match" : "wrong";
}

export function extractMariBankSenderLast4(text: string): string | null {
  const match = String(text || "").match(
    /\bmari[\s-]*bank\s*:\s*[*xX#\u2022\u2023\u25E6\u2219.\s]{2,}(\d{4})\b/i,
  );
  return match ? match[1] : null;
}

// Do not include the optional sender suffix: the same genuine screenshot may
// OCR it as four digits on one pass and unreadable on another. Timestamp,
// reference, and principal amount form the stable receipt replay identity;
// the sender suffix is still retained separately for audit.
export function buildMariBankTransactionKey({
  reference,
  transactionDateTime,
  amount,
}: {
  reference: string;
  transactionDateTime: Date | null;
  amount: number | null;
}): string | null {
  if (
    !isMariBankReference(reference) || !transactionDateTime ||
    Number.isNaN(transactionDateTime.getTime()) || amount == null ||
    !Number.isFinite(amount) || amount < 0
  ) return null;
  const minute = transactionDateTime.toISOString().slice(0, 16);
  return [
    "maribank_transaction",
    minute,
    reference,
    amount.toFixed(2),
  ].join(":");
}

export function parseMariBankDateTime(
  text: string,
): { date: string | null; shifted: Date | null } {
  const value = String(text || "")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const labelIndex = value.search(
    /\btransaction\s+date\s*(?:&|and)\s*time\b/i,
  );
  const searchText = labelIndex >= 0
    ? value.slice(labelIndex, labelIndex + 120)
    : value;
  const dateMatch = searchText.match(
    /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i,
  );
  if (!dateMatch) return { date: null, shifted: null };

  const day = Number(dateMatch[1]);
  const month = MONTHS[dateMatch[2].toLowerCase().slice(0, 3)];
  const year = Number(dateMatch[3]);
  const calendarCheck = new Date(Date.UTC(year, month, day));
  if (
    year < 2000 || year > 2100 || day < 1 || day > 31 ||
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month ||
    calendarCheck.getUTCDate() !== day
  ) {
    return { date: null, shifted: null };
  }

  const date = [
    String(year),
    String(month + 1).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
  const afterDate = searchText.slice(
    (dateMatch.index || 0) + dateMatch[0].length,
    (dateMatch.index || 0) + dateMatch[0].length + 40,
  );
  const timeMatch = afterDate.match(
    /\b([01]?\d|2[0-3])\s*[:;.]\s*([0-5]\d)\s*(AM|PM)?\b/i,
  );
  if (!timeMatch) return { date, shifted: null };

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = String(timeMatch[3] || "").toUpperCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return { date, shifted: null };
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (meridiem === "PM" && hour < 12) hour += 12;
  }
  return {
    date,
    // Match verify-gcash-receipt's PH wall-clock representation: the UTC
    // fields carry Manila local time for direct comparison with shifted dates.
    shifted: new Date(Date.UTC(year, month, day, hour, minute, 0)),
  };
}
