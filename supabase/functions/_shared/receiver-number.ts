export type ReceiverNumberCheck = "match" | "wrong" | "unreadable";

export interface ReceiverNumberOptions {
  allowHardWrong?: boolean;
}

type ReceiptProvider = "gcash" | "bpi";

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

function receiverContext(
  text: string,
  provider: ReceiptProvider,
): ReceiptLine[] {
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
    const commonReceiverLabel = explicitReceiverLabel ||
      /\b(?:send|sent|transfer)\s+to\b/i.test(line);

    if (commonReceiverLabel) {
      addRange(selected, index, index + 4, lines.length);
      if (provider === "bpi") {
        addRange(hardWrongLines, index, index + 4, lines.length);
      } else if (explicitReceiverLabel) {
        // A GCash mismatch is hard evidence only when the full number is on
        // the receiver label itself or the immediately following line.
        addRange(hardWrongLines, index, index + 1, lines.length);
      }
    }

    if (provider === "gcash") {
      if (/\b(?:express\s+send|send\s+money)\b/i.test(line)) {
        addRange(selected, index, index + 6, lines.length);
      }
      if (/\bsent\s+(?:via|through)\s+gcash\b/i.test(line)) {
        addRange(selected, index - 4, index, lines.length);
      }
    } else if (
      /\btransfer\s+to\b/i.test(line) ||
      /\bgcash\s*\/\s*g-?xchange\b/i.test(line) ||
      /\bg-?xchange\b/i.test(line)
    ) {
      addRange(selected, index - 1, index + 4, lines.length);
      addRange(hardWrongLines, index - 1, index + 4, lines.length);
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
  const prefix = line.slice(0, tokenStart);
  return REFERENCE_LABEL_BEFORE_TOKEN.test(prefix);
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
      if (normalized) {
        mobiles.set(
          normalized,
          allowsHardWrong || (mobiles.get(normalized) ?? false),
        );
      }
    }
  }

  return mobiles;
}

function extractMaskedSuffixes(lines: ReceiptLine[]): Set<string> {
  const suffixes = new Set<string>();

  for (const { isReferenceValue, text } of lines) {
    if (isReferenceValue) continue;
    MASKED_MOBILE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MASKED_MOBILE.exec(text)) !== null) {
      if (tokenHasReferenceLabel(text, match.index)) continue;
      suffixes.add(match[1]);
    }
  }

  return suffixes;
}

function digitDistance(left: string, right: string): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let differences = 0;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) differences++;
  }
  return differences;
}

function checkReceiverNumber(
  text: string,
  expectedRaw: string,
  provider: ReceiptProvider,
  options: ReceiverNumberOptions,
): ReceiverNumberCheck {
  const expected = normalizePhilippineMobile(expectedRaw);
  if (!expected) return "unreadable";

  const context = receiverContext(text, provider);
  if (context.length === 0) return "unreadable";

  const fullMobiles = extractFullMobiles(context);
  const maskedSuffixes = extractMaskedSuffixes(context);

  // Conflicting receiver evidence is never safe to auto-approve or auto-reject.
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

    // A single OCR substitution is too uncertain for a hard rejection. It
    // remains visible to an administrator as NUMBER_UNREADABLE for review.
    if (digitDistance(full, expected) <= 1) return "unreadable";
    if (!allowsHardWrong || options.allowHardWrong === false) {
      return "unreadable";
    }
    return "wrong";
  }

  if (maskedSuffix === expected.slice(-4)) return "match";
  return "unreadable";
}

export function checkGcashReceiverNumber(
  text: string,
  expectedRaw: string,
  options: ReceiverNumberOptions = {},
): ReceiverNumberCheck {
  return checkReceiverNumber(text, expectedRaw, "gcash", options);
}

export function checkBpiReceiverNumber(
  text: string,
  expectedRaw: string,
  options: ReceiverNumberOptions = {},
): ReceiverNumberCheck {
  return checkReceiverNumber(text, expectedRaw, "bpi", options);
}
