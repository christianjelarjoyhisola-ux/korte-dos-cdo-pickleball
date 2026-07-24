export type GoTymeTransferStatus =
  | "transferred"
  | "pending"
  | "processing"
  | "failed"
  | "cancelled"
  | "reversed";

export type GoTymeDestination = "gcash";

export type GoTymeDestinationCheck =
  | "match"
  | "wrong"
  | "unreadable"
  | "unconfigured";

export type GoTymeRecipientNameCheck =
  | "match"
  | "mismatch"
  | "unreadable"
  | "unconfigured";

export type GoTymePhDateTime = {
  date: string | null;
  shifted: Date | null;
};

const MONTHS: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

const MONEY_RE =
  /(?<![\d,])(?:(?:PHP|P|₱|â‚±)\s*)?((?:\d{1,3}(?:,\s*\d{3})+|\d(?:\s+\d)*|\d+)\s*\.\s*\d\s*\d)(?![\d,.])/giu;

/**
 * Normalize only presentation differences introduced by OCR. Field parsing
 * remains label-scoped, so normalization never joins unrelated values.
 */
export function normalizeGoTymeOcrText(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();
}

function nonEmptyLines(value: string): string[] {
  return normalizeGoTymeOcrText(value).split("\n").filter(Boolean);
}

function compact(value: string): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hasGoTymeBrand(value: string): boolean {
  return compact(value).includes("GOTYMEBANK");
}

function isToLabel(line: string): boolean {
  const value = compact(line);
  return value === "TO" ||
    (value.startsWith("TO") && !value.startsWith("TOTAL"));
}

function isFromLabel(line: string): boolean {
  return compact(line).startsWith("FROM");
}

function isAmountLabel(line: string): boolean {
  return compact(line).startsWith("AMOUNT");
}

function section(
  text: string,
  start: (line: string) => boolean,
  end: (line: string) => boolean,
): string {
  const lines = nonEmptyLines(text);
  const startIndex = lines.findIndex(start);
  if (startIndex < 0) return "";
  const relativeEnd = lines.slice(startIndex + 1).findIndex(end);
  const endIndex = relativeEnd < 0
    ? lines.length
    : startIndex + 1 + relativeEnd;
  return lines.slice(startIndex, endIndex).join("\n");
}

function toSection(text: string): string {
  return section(text, isToLabel, isFromLabel);
}

function fromSection(text: string): string {
  return section(text, isFromLabel, isAmountLabel);
}

function rawHasGcashDestination(text: string): boolean {
  const scoped = toSection(text);
  const value = compact(scoped || text);
  return value.includes("GXCHANGE") && value.includes("GCASH");
}

function hasReferenceLabel(text: string): boolean {
  return nonEmptyLines(text).some((line) =>
    /^REFERENCE(?:NO|NUMBER|#)?/.test(compact(line))
  );
}

function hasTraceLabel(text: string): boolean {
  return nonEmptyLines(text).some((line) =>
    /^TRACE(?:ID|NO|NUMBER)?/.test(compact(line))
  );
}

function hasAmountEvidence(text: string): boolean {
  const labels = new Set<string>();
  for (const line of nonEmptyLines(text)) {
    const value = compact(line);
    if (value.startsWith("AMOUNT")) labels.add("amount");
    if (value.startsWith("FEE")) labels.add("fee");
    if (value.startsWith("TOTAL")) labels.add("total");
  }
  return labels.size >= 2;
}

/**
 * Identify the supplied GoTyme Bank -> GCash InstaPay receipt family.
 * Completion is intentionally checked separately by
 * hasSuccessfulGoTymeTransfer().
 */
export function isGoTymeToGcashReceipt(text: string): boolean {
  const value = normalizeGoTymeOcrText(text);
  if (
    !hasGoTymeBrand(value) ||
    !compact(value).includes("INSTAPAY") ||
    !rawHasGcashDestination(value)
  ) return false;

  const anchors = [
    hasReferenceLabel(value),
    hasTraceLabel(value),
    hasAmountEvidence(value),
    nonEmptyLines(value).some(isToLabel) &&
    nonEmptyLines(value).some(isFromLabel),
    compact(value).includes("TRANSFERRED"),
  ];
  return anchors.filter(Boolean).length >= 2;
}

export const isGoTymeReceipt = isGoTymeToGcashReceipt;

export function extractGoTymeDestination(
  text: string,
): GoTymeDestination | null {
  const value = normalizeGoTymeOcrText(text);
  return hasGoTymeBrand(value) && rawHasGcashDestination(value)
    ? "gcash"
    : null;
}

export function hasGoTymeGcashDestination(text: string): boolean {
  return extractGoTymeDestination(text) === "gcash";
}

export const hasGcashGxiDestination = hasGoTymeGcashDestination;

export function hasGoTymeInstapayInstant(text: string): boolean {
  if (!isGoTymeToGcashReceipt(text)) return false;
  const allText = compact(text);
  if (
    allText.includes("PESONET") || allText.includes("NOTINSTANT") ||
    allText.includes("DELAYED")
  ) return false;
  const lines = nonEmptyLines(text);
  const instaPayIndexes: number[] = [];
  const instantIndexes: number[] = [];
  lines.forEach((line, index) => {
    const value = compact(line);
    if (value.includes("INSTAPAY")) instaPayIndexes.push(index);
    if (value.includes("INSTANT") && !value.includes("NOTINSTANT")) {
      instantIndexes.push(index);
    }
  });
  return instaPayIndexes.some((railIndex) =>
    instantIndexes.some((speedIndex) => Math.abs(railIndex - speedIndex) <= 2)
  );
}

export function extractGoTymeTransferChannel(text: string): string | null {
  return isGoTymeToGcashReceipt(text) &&
      !compact(text).includes("PESONET") &&
      compact(text).includes("INSTAPAY")
    ? "InstaPay"
    : null;
}

export function extractGoTymeProcessingSpeed(text: string): string | null {
  return hasGoTymeInstapayInstant(text) ? "Instant" : null;
}

export function extractGoTymeSourceInstitution(text: string): string | null {
  return isGoTymeToGcashReceipt(text) && hasGoTymeBrand(text)
    ? "GoTyme Bank"
    : null;
}

export function extractGoTymeDestinationInstitution(
  text: string,
): string | null {
  return hasGoTymeGcashDestination(text) && isGoTymeToGcashReceipt(text)
    ? "G-Xchange, Inc (GCash)"
    : null;
}

export function extractGoTymeStatus(
  text: string,
): GoTymeTransferStatus | null {
  if (!isGoTymeToGcashReceipt(text)) return null;
  const statuses = new Set<GoTymeTransferStatus>();

  for (const line of nonEmptyLines(text)) {
    const value = compact(line);
    if (value.includes("NOTTRANSFERRED")) return null;
    if (value.startsWith("TRANSFERRED")) statuses.add("transferred");
    if (value.startsWith("PENDING")) statuses.add("pending");
    if (value.startsWith("PROCESSING")) statuses.add("processing");
    if (value.startsWith("FAILED") || value.startsWith("DECLINED")) {
      statuses.add("failed");
    }
    if (value.startsWith("CANCELLED") || value.startsWith("CANCELED")) {
      statuses.add("cancelled");
    }
    if (value.startsWith("REVERSED") || value.startsWith("REVERSAL")) {
      statuses.add("reversed");
    }
  }

  return statuses.size === 1 ? [...statuses][0] : null;
}

export function hasSuccessfulGoTymeTransfer(text: string): boolean {
  return isGoTymeToGcashReceipt(text) &&
    extractGoTymeStatus(text) === "transferred" &&
    hasGoTymeInstapayInstant(text);
}

export function normalizeGoTymeReference(value: string): string {
  return compact(value);
}

export function isGoTymeReference(value: string): boolean {
  return /^ITO\d{15}$/.test(normalizeGoTymeReference(value));
}

function referenceCandidates(text: string): Set<string> {
  const candidates = new Set<string>();
  for (const line of nonEmptyLines(text)) {
    const value = compact(line);
    for (const match of value.matchAll(/ITO\d{15}(?!\d)/g)) {
      if (isGoTymeReference(match[0])) candidates.add(match[0]);
    }
  }
  return candidates;
}

export function extractGoTymeReference(
  text: string,
  typedReference = "",
): string | null {
  if (!isGoTymeToGcashReceipt(text) || !hasReferenceLabel(text)) return null;
  const candidates = referenceCandidates(text);
  if (candidates.size !== 1) return null;
  const only = [...candidates][0];
  const typed = normalizeGoTymeReference(typedReference);
  if (typed && (!isGoTymeReference(typed) || typed !== only)) return null;
  return only;
}

function nextNonEmptyLine(lines: string[], start: number): string {
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index]) return lines[index];
  }
  return "";
}

function traceCandidates(text: string): Set<string> {
  const lines = nonEmptyLines(text);
  const candidates = new Set<string>();
  lines.forEach((line, index) => {
    const value = compact(line);
    const label = value.match(/^TRACE(?:ID|NO|NUMBER)?(.*)$/);
    if (!label) return;
    const sameLine = label[1].match(/^(\d{6})(?!\d)/);
    if (sameLine) {
      candidates.add(sameLine[1]);
      return;
    }
    const adjacent = compact(nextNonEmptyLine(lines, index)).match(
      /^(\d{6})$/,
    );
    if (adjacent) candidates.add(adjacent[1]);
  });
  return candidates;
}

export function extractGoTymeTraceId(text: string): string | null {
  if (!isGoTymeToGcashReceipt(text) || !hasTraceLabel(text)) return null;
  const candidates = traceCandidates(text);
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function goTymeReferenceMatchesTrace(
  reference: string,
  traceId: string,
): boolean {
  const normalizedReference = normalizeGoTymeReference(reference);
  const normalizedTrace = String(traceId || "").replace(/\D/g, "");
  return isGoTymeReference(normalizedReference) &&
    /^\d{6}$/.test(normalizedTrace) &&
    normalizedReference.endsWith(normalizedTrace);
}

export function hasMatchingGoTymeReferenceTrace(
  text: string,
  typedReference = "",
): boolean {
  const reference = extractGoTymeReference(text, typedReference);
  const traceId = extractGoTymeTraceId(text);
  return reference != null && traceId != null &&
    goTymeReferenceMatchesTrace(reference, traceId);
}

export const goTymeTraceMatchesReference = goTymeReferenceMatchesTrace;

export function normalizeGoTymeRecipientToken(value: string): string {
  return compact(value);
}

function isRecipientToken(value: string): boolean {
  const normalized = normalizeGoTymeRecipientToken(value);
  return /^[A-Z0-9]{4}$/.test(normalized) &&
    /[A-Z]/.test(normalized) && /\d/.test(normalized);
}

function maskedSuffixCandidates(
  value: string,
  suffixPattern: RegExp,
): Set<string> {
  const candidates = new Set<string>();
  const pattern =
    /[*xX#\u2022\u2023\u25CF\u25E6\u2219]{2,}\s*([A-Z0-9](?:\s*[A-Z0-9]){3})\b/giu;
  for (const match of value.matchAll(pattern)) {
    const suffix = compact(match[1]);
    if (suffixPattern.test(suffix)) candidates.add(suffix);
  }
  return candidates;
}

export function extractGoTymeRecipientToken(text: string): string | null {
  if (!isGoTymeToGcashReceipt(text)) return null;
  const candidates = maskedSuffixCandidates(
    toSection(text),
    /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{4}$/,
  );
  if (candidates.size !== 1) return null;
  const token = [...candidates][0];
  return isRecipientToken(token) ? token : null;
}

export const extractGoTymeDestinationAccountSuffix =
  extractGoTymeRecipientToken;

export function normalizeGoTymeDestinationAccountSuffix(
  value: string,
): string {
  return compact(value).slice(-4);
}

export function checkGoTymeDestinationAccountSuffix(
  text: string,
  expectedAccountId: string,
): GoTymeDestinationCheck {
  const expected = normalizeGoTymeDestinationAccountSuffix(expectedAccountId);
  if (!isRecipientToken(expected)) return "unconfigured";
  const extracted = extractGoTymeDestinationAccountSuffix(text);
  if (!extracted) return "unreadable";
  return extracted === expected ? "match" : "wrong";
}

function normalizedMaskedName(value: string): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9*]/g, "");
}

export function extractGoTymeRecipientName(text: string): string | null {
  if (!isGoTymeToGcashReceipt(text)) return null;
  const lines = nonEmptyLines(toSection(text));
  if (lines.length === 0) return null;

  const candidates: string[] = [];
  lines.forEach((line, index) => {
    if (!isToLabel(line)) return;
    const sameLine = line.replace(/^\s*T\s*O\s*[:\-]?\s*/i, "").trim();
    if (sameLine && /[A-Z]{2}/i.test(sameLine)) candidates.push(sameLine);
    const next = nextNonEmptyLine(lines, index);
    if (
      next && /[A-Z]{2}/i.test(next) &&
      !/^[*xX#\u2022\u2023\u25CF\u25E6\u2219]/u.test(next) &&
      !compact(next).includes("GXCHANGE")
    ) {
      candidates.push(next);
    }
  });

  const unique = [
    ...new Set(
      candidates
        .map((candidate) => candidate.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
  return unique.length === 1 ? unique[0] : null;
}

export function checkGoTymeRecipientName(
  text: string,
  expectedName: string,
): GoTymeRecipientNameCheck {
  const expected = compact(expectedName);
  if (expected.length < 3) return "unconfigured";
  const receiptName = extractGoTymeRecipientName(text);
  if (!receiptName) return "unreadable";
  const masked = normalizedMaskedName(receiptName);
  if (masked.length !== expected.length) return "unreadable";
  for (let index = 0; index < expected.length; index++) {
    if (masked[index] !== "*" && masked[index] !== expected[index]) {
      return "mismatch";
    }
  }
  return "match";
}

export function extractGoTymeSenderLast4(text: string): string | null {
  if (!isGoTymeToGcashReceipt(text)) return null;
  const candidates = maskedSuffixCandidates(fromSection(text), /^\d{4}$/);
  return candidates.size === 1 ? [...candidates][0] : null;
}

function parseMoneyCandidates(value: string): number[] {
  const amounts: number[] = [];
  MONEY_RE.lastIndex = 0;
  for (const match of normalizeGoTymeOcrText(value).matchAll(MONEY_RE)) {
    const amount = Number(String(match[1] || "").replace(/[,\s]/g, ""));
    if (Number.isFinite(amount) && amount >= 0) amounts.push(amount);
  }
  return amounts;
}

type MoneyLabel = "amount" | "fee" | "total";

function moneyLabel(line: string): MoneyLabel | null {
  const value = compact(line);
  if (value.startsWith("AMOUNT")) return "amount";
  if (value.startsWith("FEE")) return "fee";
  if (value.startsWith("TOTAL")) return "total";
  return null;
}

function extractLabeledMoney(text: string, target: MoneyLabel): number | null {
  const lines = nonEmptyLines(text);
  const amounts = new Map<string, number>();
  let found = false;

  lines.forEach((line, index) => {
    if (moneyLabel(line) !== target) return;
    found = true;
    let candidates = parseMoneyCandidates(line);
    if (candidates.length === 0) {
      const next = nextNonEmptyLine(lines, index);
      if (next && moneyLabel(next) == null) {
        candidates = parseMoneyCandidates(next);
      }
    }
    if (candidates.length === 0 && index > 0) {
      const previous = lines[index - 1];
      if (previous && moneyLabel(previous) == null) {
        candidates = parseMoneyCandidates(previous);
      }
    }
    for (const amount of candidates) amounts.set(amount.toFixed(2), amount);
  });

  return found && amounts.size === 1 ? [...amounts.values()][0] : null;
}

export function extractGoTymeAmount(text: string): number | null {
  return isGoTymeToGcashReceipt(text)
    ? extractLabeledMoney(text, "amount")
    : null;
}

export const extractGoTymeTransferAmount = extractGoTymeAmount;

export function extractGoTymeFee(text: string): number | null {
  return isGoTymeToGcashReceipt(text) ? extractLabeledMoney(text, "fee") : null;
}

export const extractGoTymeTransferFee = extractGoTymeFee;

export function extractGoTymeTotal(text: string): number | null {
  return isGoTymeToGcashReceipt(text)
    ? extractLabeledMoney(text, "total")
    : null;
}

export const extractGoTymeTotalAmount = extractGoTymeTotal;

function cents(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value * 100);
  return Math.abs(value * 100 - rounded) < 0.000001 ? rounded : null;
}

export function hasConsistentGoTymeAccounting(text: string): boolean {
  const amount = extractGoTymeAmount(text);
  const fee = extractGoTymeFee(text);
  const total = extractGoTymeTotal(text);
  if (amount == null || fee == null || total == null || amount <= 0) {
    return false;
  }
  const amountCents = cents(amount);
  const feeCents = cents(fee);
  const totalCents = cents(total);
  return amountCents != null && feeCents != null && totalCents != null &&
    amountCents + feeCents === totalCents;
}

type DateCandidate = {
  date: string;
  shifted: Date;
};

function parseCompactDate(value: string): DateCandidate | null {
  const match = value.match(
    /^DATE(\d{1,2})(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)(\d{4})(?:AT)?(\d{3,4})(AM|PM)$/,
  );
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS[match[2].slice(0, 3)];
  const year = Number(match[3]);
  const timeDigits = match[4];
  let hour = Number(timeDigits.slice(0, -2));
  const minute = Number(timeDigits.slice(-2));
  const meridiem = match[5];
  if (
    month == null || year < 2000 || year > 2100 || day < 1 || day > 31 ||
    hour < 1 || hour > 12 || minute < 0 || minute > 59
  ) return null;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (meridiem === "PM" && hour < 12) hour += 12;

  const calendarCheck = new Date(Date.UTC(year, month, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month ||
    calendarCheck.getUTCDate() !== day
  ) return null;

  return {
    date: `${year}-${String(month + 1).padStart(2, "0")}-${
      String(day).padStart(2, "0")
    }`,
    // This is the PH wall-clock value represented in UTC, matching the
    // verifier's existing receipt-time comparison convention.
    shifted: new Date(Date.UTC(year, month, day, hour, minute, 0)),
  };
}

export function parseGoTymePhDateTime(text: string): GoTymePhDateTime {
  if (!isGoTymeToGcashReceipt(text)) {
    return { date: null, shifted: null };
  }
  const lines = nonEmptyLines(text);
  const candidates = new Map<string, DateCandidate>();

  lines.forEach((line, index) => {
    const value = compact(line);
    if (!value.startsWith("DATE")) return;
    const combinations = [value];
    const next = nextNonEmptyLine(lines, index);
    if (next) combinations.push(`${value}${compact(next)}`);
    for (const candidateText of combinations) {
      const candidate = parseCompactDate(candidateText);
      if (candidate) candidates.set(candidate.shifted.toISOString(), candidate);
    }
  });

  if (candidates.size !== 1) return { date: null, shifted: null };
  return [...candidates.values()][0];
}

export const parseGoTymeDateTime = parseGoTymePhDateTime;
