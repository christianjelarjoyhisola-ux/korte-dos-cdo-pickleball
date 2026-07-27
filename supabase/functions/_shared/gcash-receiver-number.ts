export type GcashReceiverNumberCheck = "match" | "wrong" | "unreadable";

export interface GcashReceiverNumberOptions {
  allowHardWrong?: boolean;
}

interface ReceiptLine {
  index: number;
  text: string;
  allowsHardWrong: boolean;
  isReferenceValue: boolean;
}

const NUMERIC_TOKEN = /\+?\d(?:[\d \t\u00a0\u202f().:#-]*\d)?/g;
const REFERENCE_VALUE_LINE =
  /^\+?[\d \t\u00a0\u202f().:#*xX\u00b7\u2022\u2023\u25e6\u2043\u2219-]+$/;
const REFERENCE_LABEL =
  /\b(?:(?:transaction\s+)?ref(?:erence)?\.?(?:\s*(?:no|number)\.?)?|confirmation(?:\s*(?:no|number)\.?)?|receipt\s*(?:no|number)\.?|trace\s*(?:no|number)\.?)(?![a-z])/i;
const REFERENCE_LABEL_BEFORE_TOKEN = new RegExp(
  `${REFERENCE_LABEL.source}[\\s.:#-]*$`,
  "i",
);
const MASK = "[*xX#\\u00b7\\u2022\\u2023\\u25e6\\u2043\\u2219.]";
const MASK_SEPARATOR = "[ \\t\\u00a0\\u202f()\\-]*";
const MASKED_MOBILE = new RegExp(
  `(?:^|[^\\d])(?:(?:\\+?63|0)${MASK_SEPARATOR})?9` +
    `(?:${MASK_SEPARATOR}${MASK}){5}${MASK_SEPARATOR}(\\d{4})(?!\\d)`,
  "gi",
);
// Google Vision sometimes omits GCash's decorative mask dots entirely while
// retaining the "+63 9" prefix and final four digits. This GCash-only fallback
// deliberately excludes letters and intervening digits, so it cannot turn an
// amount, reference, or complete different mobile number into receiver proof.
const OCR_DROPPED_MASK_MOBILE = new RegExp(
  `(?:^|[^\\d])(?:\\+?63${MASK_SEPARATOR}|0)9` +
    `(?:${MASK_SEPARATOR}${MASK}){0,5}${MASK_SEPARATOR}(\\d{4})(?!\\d)`,
  "gi",
);

function digitsOnly(value: string): string {
  return String(value || "").replace(/\D/g, "");
}

function normalizePhilippineMobile(value: string): string | null {
  const digits = digitsOnly(value);
  if (/^9\d{9}$/.test(digits)) return digits;
  if (/^09\d{9}$/.test(digits)) return digits.slice(1);
  if (/^639\d{9}$/.test(digits)) return digits.slice(2);
  return null;
}

function addRange(
  selected: Set<number>,
  start: number,
  end: number,
  lineCount: number,
): void {
  for (
    let index = Math.max(0, start);
    index <= Math.min(lineCount - 1, end);
    index++
  ) {
    selected.add(index);
  }
}

function findReferenceValueLines(lines: string[]): Set<number> {
  const referenceValues = new Set<number>();

  for (let index = 0; index < lines.length - 1; index++) {
    const label = REFERENCE_LABEL.exec(lines[index]);
    if (!label) continue;

    const valueAfterLabel = lines[index].slice(label.index + label[0].length);
    if (
      !/\d/.test(valueAfterLabel) &&
      REFERENCE_VALUE_LINE.test(lines[index + 1])
    ) {
      referenceValues.add(index + 1);
    }
  }

  return referenceValues;
}

function gcashReceiverContext(text: string): ReceiptLine[] {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const selected = new Set<number>();
  const hardWrongLines = new Set<number>();
  const referenceValueLines = findReferenceValueLines(lines);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const explicitReceiverLabel = /\b(?:receiver|recipient|beneficiary)\b/i
      .test(line);
    const receiverLabel = explicitReceiverLabel ||
      /\b(?:send|sent|transfer)\s+to\b/i.test(line);

    if (receiverLabel) {
      addRange(selected, index, index + 4, lines.length);
      if (explicitReceiverLabel) {
        addRange(hardWrongLines, index, index + 1, lines.length);
      }
    }
    if (/\b(?:express\s+send|send\s+money)\b/i.test(line)) {
      addRange(selected, index, index + 6, lines.length);
    }
    if (/\bsent\s+(?:via|through)\s+gcash\b/i.test(line)) {
      addRange(selected, index - 4, index, lines.length);
    }
  }

  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      text: lines[index],
      allowsHardWrong: hardWrongLines.has(index),
      isReferenceValue: referenceValueLines.has(index),
    }));
}

function tokenHasReferenceLabel(line: string, tokenStart: number): boolean {
  return REFERENCE_LABEL_BEFORE_TOKEN.test(line.slice(0, tokenStart));
}

function extractFullMobiles(lines: ReceiptLine[]): Map<string, boolean> {
  const mobiles = new Map<string, boolean>();

  for (const { allowsHardWrong, isReferenceValue, text } of lines) {
    if (isReferenceValue) continue;
    NUMERIC_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NUMERIC_TOKEN.exec(text)) !== null) {
      if (tokenHasReferenceLabel(text, match.index)) continue;
      const normalized = normalizePhilippineMobile(match[0]);
      if (!normalized) continue;
      mobiles.set(
        normalized,
        allowsHardWrong || (mobiles.get(normalized) ?? false),
      );
    }
  }

  return mobiles;
}

function maskedSearchTexts(lines: ReceiptLine[]): string[] {
  const usable = lines.filter((line) => !line.isReferenceValue);
  const texts = new Set(usable.map((line) => line.text));

  // Preserve only adjacent OCR lines. This repairs a visual receiver row that
  // Google split between mask groups without joining unrelated receipt fields.
  for (let start = 0; start < usable.length; start++) {
    let joined = usable[start].text;
    for (
      let end = start + 1;
      end < usable.length && end <= start + 2 &&
      usable[end].index === usable[end - 1].index + 1;
      end++
    ) {
      joined += ` ${usable[end].text}`;
      texts.add(joined);
    }
  }

  return [...texts];
}

function collectMaskedSuffixes(
  texts: string[],
  pattern: RegExp,
): Set<string> {
  const suffixes = new Set<string>();
  for (const text of texts) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (tokenHasReferenceLabel(text, match.index)) continue;
      suffixes.add(match[1]);
    }
  }
  return suffixes;
}

function extractMaskedSuffixes(lines: ReceiptLine[]): Set<string> {
  const texts = maskedSearchTexts(lines);
  const strict = collectMaskedSuffixes(texts, MASKED_MOBILE);
  const dropped = collectMaskedSuffixes(texts, OCR_DROPPED_MASK_MOBILE);
  return new Set([...strict, ...dropped]);
}

function digitDistance(left: string, right: string): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let differences = 0;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) differences++;
  }
  return differences;
}

export function checkGcashReceiverNumber(
  text: string,
  expectedRaw: string,
  options: GcashReceiverNumberOptions = {},
): GcashReceiverNumberCheck {
  const expected = normalizePhilippineMobile(expectedRaw);
  if (!expected) return "unreadable";

  const context = gcashReceiverContext(text);
  if (context.length === 0) return "unreadable";

  const fullMobiles = extractFullMobiles(context);
  const maskedSuffixes = extractMaskedSuffixes(context);

  // Conflicting receiver evidence is never safe to approve or reject.
  if (fullMobiles.size > 1 || maskedSuffixes.size > 1) return "unreadable";

  const fullEntry = fullMobiles.entries().next().value as
    | [string, boolean]
    | undefined;
  const full = fullEntry?.[0];
  const allowsHardWrong = fullEntry?.[1] ?? false;
  const maskedSuffix = maskedSuffixes.values().next().value as
    | string
    | undefined;

  if (full && maskedSuffix && full.slice(-4) !== maskedSuffix) {
    return "unreadable";
  }
  if (full) {
    if (full === expected) return "match";
    if (digitDistance(full, expected) <= 1) return "unreadable";
    if (!allowsHardWrong || options.allowHardWrong === false) {
      return "unreadable";
    }
    return "wrong";
  }

  return maskedSuffix === expected.slice(-4) ? "match" : "unreadable";
}
