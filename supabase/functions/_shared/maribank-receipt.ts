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

export function normalizeMariBankAccountId(value: string): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isMariBankAccountId(value: string): boolean {
  const normalized = normalizeMariBankAccountId(value);
  return /^[A-Z0-9]{12,24}$/.test(normalized) &&
    /[A-Z]/.test(normalized) && /\d/.test(normalized);
}

function normalizeOcrText(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\r\n?/g, "\n");
}

function nonEmptyLines(value: string): string[] {
  return normalizeOcrText(value)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function sixDigitCandidates(value: string): Set<string> {
  const normalized = normalizeOcrText(value);
  const candidates = new Set<string>();
  for (
    const match of normalized.matchAll(
      /(?<![A-Z0-9])\d{6}(?![A-Z0-9])/gi,
    )
  ) {
    candidates.add(match[0]);
  }
  for (const match of normalized.matchAll(/\d(?:[ \t-]+\d){5}/g)) {
    const start = match.index || 0;
    const end = start + match[0].length;
    const before = normalized.slice(0, start);
    const after = normalized.slice(end);
    // Do not accept a six-digit slice from a longer spaced digit run or an
    // alphanumeric identifier.
    if (
      /(?:[A-Z0-9]|\d[ \t-]*)$/i.test(before) ||
      /^(?:[A-Z0-9]|[ \t-]*\d)/i.test(after)
    ) continue;
    candidates.add(digitsOnly(match[0]));
  }
  return candidates;
}

function parseMoney(value: string): number | null {
  const normalized = String(value || "")
    .replace(/,/g, "")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+/g, "");
  if (!/^\d+(?:\.\d{2})$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

type MoneyCandidate = {
  amount: number;
  hasCurrency: boolean;
};

type LabeledMoneyResult = {
  amount: number | null;
  found: boolean;
  ambiguous: boolean;
};

const MONEY_TOKEN_RE =
  /(?<![A-Z0-9,])(?:(PHP|\u20B1|P)\s*)?((?:\d{1,3}(?:,\s*\d{3})+|\d+)\s*\.\s*\d{2})(?![\d,.])/giu;

function moneyCandidates(value: string): MoneyCandidate[] {
  const candidates: MoneyCandidate[] = [];
  MONEY_TOKEN_RE.lastIndex = 0;
  for (const match of normalizeOcrText(value).matchAll(MONEY_TOKEN_RE)) {
    const amount = parseMoney(match[2] || "");
    if (amount == null) continue;
    candidates.push({ amount, hasCurrency: !!match[1] });
  }
  return candidates;
}

function uniqueAmounts(candidates: MoneyCandidate[]): number[] {
  return [...new Map(
    candidates.map((
      candidate,
    ) => [candidate.amount.toFixed(2), candidate.amount]),
  ).values()];
}

function extractLabeledMoney(
  text: string,
  label: RegExp,
  maxLineDistance = 2,
): LabeledMoneyResult {
  const lines = nonEmptyLines(text);
  const candidates: MoneyCandidate[] = [];
  let foundLabel = false;

  lines.forEach((line, lineIndex) => {
    if (!label.test(line)) return;
    foundLabel = true;
    const sameLine = moneyCandidates(line);
    if (sameLine.length > 0) {
      candidates.push(...sameLine);
      return;
    }
    for (let distance = 1; distance <= maxLineDistance; distance++) {
      const nearby: MoneyCandidate[] = [];
      for (const index of [lineIndex - distance, lineIndex + distance]) {
        if (index < 0 || index >= lines.length) continue;
        const hasOtherMoneyLabel =
          /\b(?:transfer\s+amount|transfer\s+fee|total\s+amount)\b/i.test(
            lines[index],
          ) && !label.test(lines[index]);
        if (hasOtherMoneyLabel) continue;
        nearby.push(...moneyCandidates(lines[index]));
      }
      if (nearby.length > 0) {
        candidates.push(...nearby);
        break;
      }
    }
  });

  const amounts = uniqueAmounts(candidates);
  return {
    amount: amounts.length === 1 ? amounts[0] : null,
    found: foundLabel && candidates.length > 0,
    ambiguous: amounts.length > 1,
  };
}

function repeatedPrincipalAmount(text: string): number | null {
  if (!hasStrongMariBankContext(text)) return null;
  const value = normalizeOcrText(text);
  if (
    !/\btransfer\s+amount\b/i.test(value) ||
    !/\btotal\s+amount\b/i.test(value)
  ) return null;

  const counts = new Map<string, { amount: number; count: number }>();
  for (const line of nonEmptyLines(value)) {
    // A fee is never the principal, even if OCR repeats it.
    if (/\b(?:transfer|service|processing|transaction)\s+fee\b/i.test(line)) {
      continue;
    }
    for (const candidate of moneyCandidates(line)) {
      if (candidate.amount <= 0) continue;
      const key = candidate.amount.toFixed(2);
      const current = counts.get(key) || { amount: candidate.amount, count: 0 };
      current.count++;
      counts.set(key, current);
    }
  }

  if (counts.size !== 1) return null;
  const only = [...counts.values()][0];
  return only.count >= 3 ? only.amount : null;
}

function hasConflictingFreeFeeAmounts(text: string): boolean {
  const value = normalizeOcrText(text);
  if (
    !hasStrongMariBankContext(value) ||
    !/\btransfer\s+fee\b/i.test(value) ||
    !/\bfree\b/i.test(value)
  ) return false;
  return uniqueAmounts(
    moneyCandidates(value).filter((candidate) => candidate.amount > 0),
  ).length > 1;
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
  const value = normalizeOcrText(text);
  const normalizedTyped = String(typedRef || "").trim();
  const globalCandidates = sixDigitCandidates(value);
  // A second standalone six-digit value makes the short MariBank reference
  // ambiguous even when one candidate happens to be closer to the label.
  if (globalCandidates.size !== 1) return null;
  const onlyGlobalCandidate = [...globalCandidates][0];
  const lines = nonEmptyLines(value);
  const nearbyCandidates = new Set<string>();
  lines.forEach((line, lineIndex) => {
    if (!/\b(?:reference|ref\.?)\s*(?:no|number|#)?\b/i.test(line)) return;
    for (let index = lineIndex - 2; index <= lineIndex + 2; index++) {
      if (index < 0 || index >= lines.length) continue;
      sixDigitCandidates(lines[index]).forEach((candidate) =>
        nearbyCandidates.add(candidate)
      );
    }
  });
  if (nearbyCandidates.size > 1) return null;
  if (nearbyCandidates.size === 1) {
    const nearby = [...nearbyCandidates][0];
    return nearby === onlyGlobalCandidate ? nearby : null;
  }

  // Column-based OCR can place all right-hand values before or after all
  // labels. Trust only the exact customer-entered six-digit token, and only
  // when the rest of the text strongly identifies this specific receipt type.
  if (
    !isMariBankReference(normalizedTyped) ||
    !hasStrongMariBankContext(value)
  ) return null;
  return onlyGlobalCandidate === normalizedTyped ? normalizedTyped : null;
}

export function extractMariBankTransferAmount(text: string): number | null {
  if (hasConflictingFreeFeeAmounts(text)) return null;
  const labeled = extractLabeledMoney(text, /\btransfer\s+amount\b/i);
  const repeated = repeatedPrincipalAmount(text);
  if (labeled.ambiguous) return null;
  if (labeled.amount != null) {
    if (repeated != null && repeated !== labeled.amount) return null;
    return labeled.amount;
  }
  return repeated;
}

export function extractMariBankTransferFee(text: string): number | null {
  const value = normalizeOcrText(text);
  const lines = nonEmptyLines(value);
  const feeLabel = /\btransfer\s+fee\b/i;
  const freeToken = /\bfree\b/i;
  let hasLabel = false;
  let nearbyFree = false;

  lines.forEach((line, lineIndex) => {
    if (!feeLabel.test(line)) return;
    hasLabel = true;
    const sameLineFree = freeToken.test(line);
    const sameLineMoney = moneyCandidates(line);
    if (sameLineFree && sameLineMoney.length === 0) nearbyFree = true;
    for (let distance = 1; distance <= 2; distance++) {
      for (const index of [lineIndex - distance, lineIndex + distance]) {
        if (index < 0 || index >= lines.length) continue;
        if (freeToken.test(lines[index])) nearbyFree = true;
      }
    }
  });
  if (!hasLabel) return null;

  const freeMatches = value.match(/\bfree\b/gi) || [];
  const contradictorySameLine = lines.some((line) =>
    feeLabel.test(line) && freeToken.test(line) &&
    moneyCandidates(line).length > 0
  );
  if (contradictorySameLine) return null;
  if (nearbyFree) return 0;
  if (hasStrongMariBankContext(value) && freeMatches.length === 1) return 0;
  if (freeMatches.length > 0) return null;

  const labeled = extractLabeledMoney(value, feeLabel);
  return labeled.ambiguous ? null : labeled.amount;
}

export function extractMariBankTotalAmount(text: string): number | null {
  const labeled = extractLabeledMoney(text, /\btotal\s+amount\b/i);
  return labeled.ambiguous ? null : labeled.amount;
}

export function isMariBankReceipt(text: string): boolean {
  const value = normalizeOcrText(text);
  const hasBrand = /\bmari[\s-]*bank\b/i.test(value);
  return hasBrand &&
    (/\btransaction\s+receipt\b/i.test(value) ||
      /\breceipt\s+generated\s+from\s+mari[\s-]*bank\s+app\b/i.test(value) ||
      /\bprocessing\s+time\b/i.test(value));
}

function hasStrongMariBankContext(text: string): boolean {
  const value = normalizeOcrText(text);
  const hasReceiptHeading = /\btransaction\s+receipt\b/i.test(value);
  const hasSuccessfulTransferHeading =
    /\btransfer\s+result\b/i.test(value) &&
    /\btransfer\s+successful\b/i.test(value);
  if (
    !/\bmari[\s-]*bank\b/i.test(value) ||
    (!hasReceiptHeading && !hasSuccessfulTransferHeading)
  ) return false;
  const anchors = [
    /\btransfer\s+amount\b/i,
    /\btotal\s+amount\b/i,
    /\breference\s*(?:no|number|#)?\b/i,
    /\btransfer\s+method\b/i,
    /\bprocessing\s+time\b/i,
    /\btransaction\s+date\s*(?:&|and)\s*time\b/i,
    /\bg-?\s*xchange\s*\/\s*gcash\b/i,
  ];
  return anchors.filter((anchor) => anchor.test(value)).length >= 4;
}

function exactPairedFieldValue(
  text: string,
  label: RegExp,
  expected: RegExp,
): boolean {
  const lines = nonEmptyLines(text);
  let labelCount = 0;
  let pairedCount = 0;
  const clean = (value: string) =>
    value.replace(/^[\s:|=#.\-–—]+|[\s:|=#.\-–—]+$/g, "").trim();

  lines.forEach((line, lineIndex) => {
    if (!label.test(line)) return;
    labelCount++;
    const sameLine = clean(line.replace(label, ""));
    if (sameLine) {
      if (expected.test(sameLine)) pairedCount++;
      return;
    }

    const adjacentMatches = [lineIndex - 1, lineIndex + 1]
      .filter((index) => index >= 0 && index < lines.length)
      .map((index) => clean(lines[index]))
      .filter((candidate) => expected.test(candidate));
    if (adjacentMatches.length === 1) pairedCount++;
  });

  return labelCount === 1 && pairedCount === 1;
}

type MariBankMethodCheck = "instapay" | "unreadable" | "missing" | "wrong";

function mariBankTransferMethodCheck(text: string): MariBankMethodCheck {
  const lines = nonEmptyLines(text);
  const label = /\btransfer\s+method\b/i;
  const clean = (value: string) =>
    value.replace(/^[\s:|=#.\-â€“â€”]+|[\s:|=#.\-â€“â€”]+$/g, "").trim();
  const labelIndexes = lines
    .map((line, index) => label.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (labelIndexes.length !== 1) return "missing";

  const lineIndex = labelIndexes[0];
  const sameLine = clean(lines[lineIndex].replace(label, ""));
  if (sameLine) {
    return /^insta\s*pay$/i.test(sameLine) ? "instapay" : "wrong";
  }

  const adjacentMethodValues = [lineIndex - 1, lineIndex + 1]
    .filter((index) => index >= 0 && index < lines.length)
    .map((index) => clean(lines[index]))
    .filter((candidate) =>
      /^(?:insta\s*pay|peso\s*net|pesonet|pddts|scheduled)$/i.test(candidate)
    );
  if (adjacentMethodValues.length > 1) return "wrong";
  if (adjacentMethodValues.length === 1) {
    return /^insta\s*pay$/i.test(adjacentMethodValues[0])
      ? "instapay"
      : "wrong";
  }

  // MariBank renders InstaPay as a stylized logo. Google Vision can recognize
  // the "Transfer Method" label while returning no text at all for the logo.
  // Leave that value unreadable rather than treating a missing logo as a
  // contradictory transfer rail.
  return "unreadable";
}

// The supplied layout has no separate "successful" line. Its stable completed
// state is a generated transaction receipt whose Processing Time field reads
// Realtime. Transfer Method normally reads InstaPay, but the app renders that
// value as a logo which OCR may omit completely. A missing logo is allowed only
// when the label remains present; a readable non-InstaPay method still fails.
export function hasSuccessfulMariBankTransfer(text: string): boolean {
  const value = normalizeOcrText(text);
  const withoutProcessingTimeLabel = value
    .replace(/\bprocessing\s+time\b/gi, "")
    .replace(/[_\-‐‑‒–—―]+/g, " ");
  const explicitFailure =
    /\b(?:pending|scheduled|processing|failed|declined|cancelled|canceled|revers(?:ed|al)|reject(?:ed)?|unsuccessful|refund(?:ed)?|return(?:ed)?|void(?:ed)?|expired|error|queued?|submitted|initiated|delayed)\b|\bnot\s+(?:successful|completed|real\s*time)\b|\bin\s+progress\b|\bon\s+hold\b/i
      .test(withoutProcessingTimeLabel);
  const methodCheck = mariBankTransferMethodCheck(value);
  return hasStrongMariBankContext(value) &&
    (methodCheck === "instapay" || methodCheck === "unreadable") &&
    exactPairedFieldValue(
      value,
      /\bprocessing\s+time\b/i,
      /^real\s*time$/i,
    ) &&
    !explicitFailure;
}

const MARIBANK_ACCOUNT_LABEL = /\b(?:acct|account)\s*(?:no|number)?\b/i;
const MARIBANK_MOBILE_LABEL = /\bmobile\s*(?:no|number)?\.?\b/i;
const ACCOUNT_FRAGMENT_FIELD =
  /\b(?:transfer|amount|fee|total|reference|method|processing|transaction|date|time|from|to|gcash|xchange|maribank|receipt|realtime|instapay|free)\b/i;

function normalizePhilippineMobile(value: string): string | null {
  const digits = digitsOnly(value);
  if (/^9\d{9}$/.test(digits)) return digits;
  if (/^09\d{9}$/.test(digits)) return digits.slice(1);
  if (/^639\d{9}$/.test(digits)) return digits.slice(2);
  return null;
}

function philippineMobileCandidates(value: string): Set<string> {
  const candidates = new Set<string>();
  const pattern = /(?<!\d)(?:(?:\+?63|0)[\s().-]*)?9(?:[\s().-]*\d){9}(?!\d)/g;
  for (const match of String(value || "").matchAll(pattern)) {
    const normalized = normalizePhilippineMobile(match[0]);
    if (normalized) candidates.add(normalized);
  }
  return candidates;
}

export function hasMariBankDestinationAccountLabel(text: string): boolean {
  return nonEmptyLines(text).some((line) => MARIBANK_ACCOUNT_LABEL.test(line));
}

// New MariBank transaction receipts identify the GCash destination with a
// labeled Mobile No. instead of the older opaque QR account token. Only read a
// mobile from the reconstructed To -> G-Xchange/GCash destination block; a
// sender/account number elsewhere on the receipt is never destination proof.
export function extractMariBankDestinationMobileNumber(
  text: string,
): string | null {
  const value = normalizeOcrText(text);
  if (
    !hasStrongMariBankContext(value) ||
    !/\bg-?\s*xchange\s*\/\s*gcash\b/i.test(value)
  ) return null;

  const lines = nonEmptyLines(value);
  const labelIndexes = lines
    .map((line, index) => MARIBANK_MOBILE_LABEL.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (labelIndexes.length !== 1) return null;

  const labelIndex = labelIndexes[0];
  const destinationWindow = lines.slice(
    Math.max(0, labelIndex - 5),
    Math.min(lines.length, labelIndex + 3),
  ).join("\n");
  if (
    !/\bg-?\s*xchange\s*\/\s*gcash\b/i.test(destinationWindow) ||
    !/(?:^|\n)\s*to(?:\s|$)/i.test(destinationWindow)
  ) return null;

  const candidates = new Set<string>();
  for (const index of [labelIndex - 1, labelIndex, labelIndex + 1]) {
    if (index < 0 || index >= lines.length) continue;
    const source = index === labelIndex
      ? lines[index].replace(MARIBANK_MOBILE_LABEL, "")
      : lines[index];
    philippineMobileCandidates(source).forEach((candidate) =>
      candidates.add(candidate)
    );
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function checkMariBankDestinationMobileNumber(
  text: string,
  expectedRaw: string,
): MariBankDestinationCheck {
  const expected = normalizePhilippineMobile(expectedRaw);
  if (!expected) return "unconfigured";
  const extracted = extractMariBankDestinationMobileNumber(text);
  if (!extracted) return "unreadable";
  return extracted === expected ? "match" : "wrong";
}

export function hasMariBankDestinationRecipient(
  text: string,
  expectedRaw: string,
): boolean {
  const aliases = [expectedRaw, "Korte Dos"]
    .map((value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .filter((value) => value.length >= 3);
  if (!aliases.length) return false;

  const lines = nonEmptyLines(text);
  const matchingBlocks = new Set<string>();
  lines.forEach((line, index) => {
    if (!/\bg-?\s*xchange\s*\/\s*gcash\b/i.test(line)) return;
    const block = lines.slice(Math.max(0, index - 3), index + 3).join("\n");
    if (!/(?:^|\n)\s*to(?:\s|$)/i.test(block)) return;
    const normalizedBlock = block.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (aliases.some((alias) => normalizedBlock.includes(alias))) {
      matchingBlocks.add(normalizedBlock);
    }
  });
  return matchingBlocks.size === 1;
}

function fragmentedMariBankAccountCandidate(lines: string[]): string | null {
  if (!lines.length) return null;
  for (const line of lines) {
    if (ACCOUNT_FRAGMENT_FIELD.test(line)) return null;
    if (!/^[A-Z0-9\s:|=#.\-]+$/i.test(line)) return null;
  }
  const normalized = normalizeMariBankAccountId(lines.join(""));
  return isMariBankAccountId(normalized) ? normalized : null;
}

export function extractMariBankDestinationAccount(
  text: string,
): string | null {
  const value = normalizeOcrText(text);
  const lines = nonEmptyLines(value);
  const nearby = new Set<string>();
  lines.forEach((line, lineIndex) => {
    if (!MARIBANK_ACCOUNT_LABEL.test(line)) return;
    for (let index = lineIndex - 2; index <= lineIndex + 2; index++) {
      if (index < 0 || index >= lines.length) continue;
      const tokens = lines[index].match(/\b[A-Z0-9]{12,24}\b/gi) || [];
      tokens.forEach((token) => {
        const normalized = normalizeMariBankAccountId(token);
        if (isMariBankAccountId(normalized)) nearby.add(normalized);
      });
    }

    const sameLineRemainder = line.replace(MARIBANK_ACCOUNT_LABEL, "");
    const sequences = [
      [sameLineRemainder],
      [lines[lineIndex - 1]],
      [lines[lineIndex + 1]],
      [lines[lineIndex - 2], lines[lineIndex - 1]],
      [lines[lineIndex + 1], lines[lineIndex + 2]],
      [lines[lineIndex - 1], sameLineRemainder],
      [sameLineRemainder, lines[lineIndex + 1]],
    ];
    for (const sequence of sequences) {
      const candidate = fragmentedMariBankAccountCandidate(
        sequence.filter((part): part is string => typeof part === "string"),
      );
      if (candidate) nearby.add(candidate);
    }
  });
  if (nearby.size > 1) return null;

  // In a column-group OCR layout, the destination token may be separated from
  // its label. Only accept a unique mixed alphanumeric token on a strongly
  // recognized MariBank-to-GCash receipt.
  if (
    !hasStrongMariBankContext(value) ||
    !/\bg-?\s*xchange\s*\/\s*gcash\b/i.test(value)
  ) return null;
  const allTokens = new Set<string>();
  for (const token of value.match(/\b[A-Z0-9]{12,24}\b/gi) || []) {
    const normalized = normalizeMariBankAccountId(token);
    if (isMariBankAccountId(normalized)) allTokens.add(normalized);
  }
  if (allTokens.size > 1) return null;
  if (nearby.size === 1) return [...nearby][0];
  return allTokens.size === 1 ? [...allTokens][0] : null;
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
  const value = String(text || "");
  const masked = value.match(
    /\bmari[\s-]*bank\s*:\s*[*xX#\u2022\u2023\u25E6\u2219.\s]{2,}(\d{4})\b/i,
  );
  if (masked) return masked[1];
  const unmasked = value.match(
    /\bmari[\s-]*bank\s*:\s*(\d{7,20})\b/i,
  );
  return unmasked ? unmasked[1].slice(-4) : null;
}

// MariBank's six-digit reference is short, so pair it with the exact principal
// amount and keep the provider namespace. Do not depend on receipt date/time:
// the current MariBank share screen can obscure that row, while the reference
// and amount remain visible and stable across OCR passes.
export function buildMariBankTransactionKey({
  reference,
  amount,
}: {
  reference: string;
  amount: number | null;
}): string | null {
  if (
    !isMariBankReference(reference) || amount == null ||
    !Number.isFinite(amount) || amount <= 0
  ) return null;
  return [
    "maribank_transaction",
    reference,
    amount.toFixed(2),
  ].join(":");
}

type MariBankDateCandidate = {
  date: string;
  shifted: Date | null;
};

function mariBankMonthIndex(value: string): number | null {
  const key = String(value || "")
    .toLowerCase()
    .replace(/[i1]/g, "l")
    .slice(0, 3);
  return Object.prototype.hasOwnProperty.call(MONTHS, key) ? MONTHS[key] : null;
}

function mariBankDateCandidates(text: string): MariBankDateCandidate[] {
  const value = normalizeOcrText(text).replace(/\s+/g, " ").trim();
  const datePattern = /\b(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{4})\b/giu;
  const candidates: MariBankDateCandidate[] = [];

  for (const match of value.matchAll(datePattern)) {
    const day = Number(match[1]);
    const month = mariBankMonthIndex(match[2]);
    const year = Number(match[3]);
    if (month == null || year < 2000 || year > 2100 || day < 1 || day > 31) {
      continue;
    }
    const calendarCheck = new Date(Date.UTC(year, month, day));
    if (
      calendarCheck.getUTCFullYear() !== year ||
      calendarCheck.getUTCMonth() !== month ||
      calendarCheck.getUTCDate() !== day
    ) continue;

    const date = [
      String(year),
      String(month + 1).padStart(2, "0"),
      String(day).padStart(2, "0"),
    ].join("-");
    const start = match.index || 0;
    const end = start + match[0].length;
    const afterDate = value.slice(end, end + 50);
    const beforeDate = value.slice(Math.max(0, start - 30), start);
    const afterTime = afterDate.match(
      /^[\s,|\-–—]{0,16}(?:at\s*)?([01]?\d|2[0-3])\s*[:;.]\s*([0-5]\d)\s*(AM|PM)?\b/i,
    );
    const beforeTime = beforeDate.match(
      /\b([01]?\d|2[0-3])\s*[:;.]\s*([0-5]\d)\s*(AM|PM)?[\s,|\-–—]{0,16}$/i,
    );
    const time = afterTime || beforeTime;
    if (!time) {
      candidates.push({ date, shifted: null });
      continue;
    }

    let hour = Number(time[1]);
    const minute = Number(time[2]);
    const meridiem = String(time[3] || "").toUpperCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) {
        candidates.push({ date, shifted: null });
        continue;
      }
      if (meridiem === "AM" && hour === 12) hour = 0;
      if (meridiem === "PM" && hour < 12) hour += 12;
    }
    candidates.push({
      date,
      shifted: new Date(Date.UTC(year, month, day, hour, minute, 0)),
    });
  }
  return candidates;
}

function selectMariBankDateCandidate(
  candidates: MariBankDateCandidate[],
): { candidate: MariBankDateCandidate | null; ambiguous: boolean } {
  const timed = new Map<string, MariBankDateCandidate>();
  const dates = new Map<string, MariBankDateCandidate>();
  for (const candidate of candidates) {
    dates.set(candidate.date, candidate);
    if (candidate.shifted) {
      timed.set(candidate.shifted.toISOString(), candidate);
    }
  }
  if (timed.size === 1) {
    const candidate = [...timed.values()][0];
    return dates.size === 1 && dates.has(candidate.date)
      ? { candidate, ambiguous: false }
      : { candidate: null, ambiguous: true };
  }
  if (timed.size > 1) return { candidate: null, ambiguous: true };
  if (dates.size === 1) {
    const candidate = [...dates.values()][0];
    return {
      candidate: { date: candidate.date, shifted: null },
      ambiguous: false,
    };
  }
  return { candidate: null, ambiguous: dates.size > 1 };
}

export function parseMariBankDateTime(
  text: string,
): { date: string | null; shifted: Date | null } {
  const value = normalizeOcrText(text).replace(/[|]/g, " ");
  const labelPattern = /\btransaction\s+date\s*(?:&|and)\s*time\b/gi;
  const scopedCandidates: MariBankDateCandidate[] = [];
  for (const match of value.matchAll(labelPattern)) {
    const index = match.index || 0;
    const window = value.slice(
      Math.max(0, index - 180),
      Math.min(value.length, index + match[0].length + 220),
    );
    scopedCandidates.push(...mariBankDateCandidates(window));
  }
  const scoped = selectMariBankDateCandidate(scopedCandidates);
  const whole = selectMariBankDateCandidate(mariBankDateCandidates(value));
  if (whole.ambiguous) return { date: null, shifted: null };
  if (scoped.ambiguous) return { date: null, shifted: null };
  if (scoped.candidate) {
    if (!whole.candidate) return { date: null, shifted: null };
    const scopedTime = scoped.candidate.shifted?.toISOString() || null;
    const wholeTime = whole.candidate.shifted?.toISOString() || null;
    if (
      scoped.candidate.date !== whole.candidate.date ||
      scopedTime !== wholeTime
    ) return { date: null, shifted: null };
    return scoped.candidate;
  }

  // Some Vision layouts emit the right-column value before the left-column
  // label or place all values in a separate block. Fall back only when the
  // entire receipt contains one unique valid transaction date/time.
  return whole.candidate || { date: null, shifted: null };
}
