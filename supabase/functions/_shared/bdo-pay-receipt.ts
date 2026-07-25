const BDO_REFERENCE_SEPARATOR = String.raw`[\s\-‐‑‒–—_.:/]{0,4}`;
const BDO_EIGHT_DIGITS = String
  .raw`[0-9](?:${BDO_REFERENCE_SEPARATOR}[0-9]){7}`;
const BDO_REFERENCE_BODY = String
  .raw`B${BDO_REFERENCE_SEPARATOR}N(?:${BDO_REFERENCE_SEPARATOR}N${BDO_REFERENCE_SEPARATOR}B)?${BDO_REFERENCE_SEPARATOR}${BDO_EIGHT_DIGITS}${BDO_REFERENCE_SEPARATOR}${BDO_EIGHT_DIGITS}`;

function bdoReferencePattern(): RegExp {
  // Avoid matching a valid-looking reference inside a longer OCR token.
  return new RegExp(
    String.raw`(?:^|[^A-Z0-9])(${BDO_REFERENCE_BODY})(?![A-Z0-9])`,
    "gi",
  );
}

export function normalizeBdoPayReference(value: string): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isBdoPayReference(value: string): boolean {
  return /^BN(?:NB)?\d{16}$/.test(normalizeBdoPayReference(value));
}

/**
 * Reads a BDO Pay reference from OCR without relying on the value entered by
 * the customer. Both known receipt layouts are supported:
 *
 *   BN-YYYYMMDD-########
 *   BN-NB-YYYYMMDD-########
 *
 * Google Vision may remove, replace, or add whitespace around separators, so
 * matching tolerates common dash characters, spaces, line breaks, and compact
 * normalized tokens. A candidate next to "Reference no." wins when the OCR
 * contains more than one reference.
 */
export function extractBdoPayReference(text: string): string | null {
  const source = String(text || "");
  const candidates: Array<{
    reference: string;
    index: number;
    labeled: boolean;
  }> = [];

  for (const match of source.matchAll(bdoReferencePattern())) {
    const rawReference = match[1] || "";
    const reference = normalizeBdoPayReference(rawReference);
    if (!isBdoPayReference(reference)) continue;

    const rawIndex = match.index ?? 0;
    const offsetWithinMatch = match[0].indexOf(rawReference);
    const index = rawIndex + Math.max(0, offsetWithinMatch);
    const before = source.slice(Math.max(0, index - 60), index);
    const labeled =
      /\breference\s*(?:no|number|#)?\.?\s*[:#]?\s*$/i.test(before) ||
      /\bref(?:erence)?\s*(?:no|number|#)?\.?\s*[:#]?\s*$/i.test(before);
    candidates.push({ reference, index, labeled });
  }

  return (candidates.find((candidate) => candidate.labeled) || candidates[0])
    ?.reference || null;
}

export function hasBdoPayReference(text: string): boolean {
  return extractBdoPayReference(text) !== null;
}

function hasBdoInvoiceNumber(text: string): boolean {
  const patterns = [
    /\binvoice\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,24}[0-9])\b/i,
    /\binv\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,24}[0-9])\b/i,
  ];
  return patterns.some((pattern) => {
    const match = String(text || "").match(pattern);
    const digits = match?.[1]?.replace(/\D/g, "") || "";
    return digits.length >= 4 && digits.length <= 20;
  });
}

export function isBdoPayReceipt(text: string): boolean {
  const value = String(text || "");
  const hasReference = hasBdoPayReference(value);
  return /\bbdo\s*pay\b/i.test(value) ||
    /\bthank\s+you\s+for\s+using\s+bdo\b/i.test(value) ||
    (hasReference && /\binsta\s*pay\b/i.test(value)) ||
    (hasReference && /\bbdo\b/i.test(value)) ||
    (hasReference && hasBdoInvoiceNumber(value));
}
