export type MariBankRecipientDecision = "match" | "wrong" | "unreadable";

export type MariBankAutomatedResult = "auto_approved" | "manual_review";

export function mariBankExpectedRecipientName(
  settings: Readonly<Record<string, string>>,
): string {
  return String(settings.maribank_recipient_name || "").trim() || "Korte Dos";
}

export function mariBankRecipientReviewFlag({
  recipientCheck,
  exactQrAccountMatches,
  hasCoherentGcashRoute,
}: {
  recipientCheck: MariBankRecipientDecision;
  exactQrAccountMatches: boolean;
  hasCoherentGcashRoute: boolean;
}): "RECEIVER_NAME_MISMATCH" | "RECEIVER_NAME_UNREADABLE" | null {
  // A clearly readable contradiction always requires the owner. The exact QR
  // account is strong destination evidence, but it must never hide a different
  // readable receiver printed in the destination block.
  if (recipientCheck === "wrong") return "RECEIVER_NAME_MISMATCH";
  if (recipientCheck === "match") return null;

  // OCR can lose the display name while retaining the exact, server-configured
  // opaque QR account. Permit that narrow case only when the receipt also has a
  // coherent GCash destination route. A name or mobile suffix alone is weaker
  // evidence and must remain pending.
  return exactQrAccountMatches && hasCoherentGcashRoute
    ? null
    : "RECEIVER_NAME_UNREADABLE";
}

export function mariBankResultForFlags(
  flags: readonly string[],
): MariBankAutomatedResult {
  // MariBank automation has only two lanes: completely clean receipts can be
  // approved; every uncertainty or contradiction is retained for owner review.
  // In particular, duplicate/replay evidence must never cancel a paid booking.
  return flags.length === 0 ? "auto_approved" : "manual_review";
}
