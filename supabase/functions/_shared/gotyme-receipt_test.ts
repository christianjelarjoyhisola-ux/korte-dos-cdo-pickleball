import {
  checkGoTymeDestinationAccountSuffix,
  checkGoTymeRecipientName,
  extractGoTymeAmount,
  extractGoTymeDestination,
  extractGoTymeDestinationInstitution,
  extractGoTymeFee,
  extractGoTymeProcessingSpeed,
  extractGoTymeRecipientToken,
  extractGoTymeReference,
  extractGoTymeSenderLast4,
  extractGoTymeSourceInstitution,
  extractGoTymeStatus,
  extractGoTymeTotal,
  extractGoTymeTraceId,
  extractGoTymeTransferChannel,
  goTymeReferenceMatchesTrace,
  hasConsistentGoTymeAccounting,
  hasGoTymeGcashDestination,
  hasGoTymeInstapayInstant,
  hasMatchingGoTymeReferenceTrace,
  hasSuccessfulGoTymeTransfer,
  isGoTymeToGcashReceipt,
  parseGoTymePhDateTime,
} from "./gotyme-receipt.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const suppliedReceipt = `
Transferred
₱720.00
Share
InstaPay Instant
To
Korte D**
*************A1BS
G-Xchange, Inc (GCash)
From
NINO J*** R*******
********3100
GoTyme Bank
Amount ₱720.00
Fee ₱0.00
Total ₱720.00
Trace ID 836004
Reference No. ITO260723233836004
Date 24 Jul 2026 at 7:38 AM
`;

Deno.test("extracts all dedicated GoTyme-to-GCash receipt evidence", () => {
  assert(isGoTymeToGcashReceipt(suppliedReceipt), "receipt family");
  assert(hasSuccessfulGoTymeTransfer(suppliedReceipt), "completed transfer");
  assert(hasGoTymeInstapayInstant(suppliedReceipt), "instant InstaPay rail");
  assert(hasGoTymeGcashDestination(suppliedReceipt), "GCash destination");
  assertEquals(
    extractGoTymeDestination(suppliedReceipt),
    "gcash",
    "destination",
  );
  assertEquals(
    extractGoTymeRecipientToken(suppliedReceipt),
    "A1BS",
    "recipient token",
  );
  assertEquals(
    checkGoTymeDestinationAccountSuffix(
      suppliedReceipt,
      "DWQM4TK496R3UA1BS",
    ),
    "match",
    "configured destination suffix",
  );
  assertEquals(
    checkGoTymeDestinationAccountSuffix(
      suppliedReceipt,
      "DWQM4TK496R3UA9ZZ",
    ),
    "wrong",
    "wrong destination suffix",
  );
  assertEquals(
    checkGoTymeRecipientName(suppliedReceipt, "Korte DOS"),
    "match",
    "masked recipient name",
  );
  assertEquals(
    checkGoTymeRecipientName(suppliedReceipt, "Other DOS"),
    "mismatch",
    "different recipient name",
  );
  assertEquals(
    extractGoTymeSenderLast4(suppliedReceipt),
    "3100",
    "sender suffix",
  );
  assertEquals(
    extractGoTymeStatus(suppliedReceipt),
    "transferred",
    "status",
  );
  assertEquals(
    extractGoTymeTransferChannel(suppliedReceipt),
    "InstaPay",
    "channel",
  );
  assertEquals(
    extractGoTymeProcessingSpeed(suppliedReceipt),
    "Instant",
    "processing speed",
  );
  assertEquals(
    extractGoTymeSourceInstitution(suppliedReceipt),
    "GoTyme Bank",
    "source institution",
  );
  assertEquals(
    extractGoTymeDestinationInstitution(suppliedReceipt),
    "G-Xchange, Inc (GCash)",
    "destination institution",
  );
  assertEquals(
    extractGoTymeReference(suppliedReceipt),
    "ITO260723233836004",
    "full reference",
  );
  assertEquals(extractGoTymeTraceId(suppliedReceipt), "836004", "trace ID");
  assertEquals(extractGoTymeAmount(suppliedReceipt), 720, "amount");
  assertEquals(extractGoTymeFee(suppliedReceipt), 0, "fee");
  assertEquals(extractGoTymeTotal(suppliedReceipt), 720, "total");
  assert(
    hasConsistentGoTymeAccounting(suppliedReceipt),
    "accounting evidence",
  );
  assert(
    hasMatchingGoTymeReferenceTrace(suppliedReceipt),
    "reference/trace relationship",
  );

  const parsed = parseGoTymePhDateTime(suppliedReceipt);
  assertEquals(parsed.date, "2026-07-24", "PH date");
  assertEquals(
    parsed.shifted?.toISOString(),
    "2026-07-24T07:38:00.000Z",
    "PH wall-clock time",
  );
});

const spacedOcrReceipt = `
T r a n s f e r r e d
₱ 7 2 0 . 0 0
i n s t a P a y   I n s t a n t
T o
Korte D**
************* A 1 B S
G - X c h a n g e, I n c (G C a s h)
F r o m
NINO J*** R*******
******** 3 1 0 0
G o T y m e B a n k
A m o u n t
₱ 7 2 0 . 0 0
F e e
₱ 0 . 0 0
T o t a l
₱ 7 2 0 . 0 0
T r a c e I D
8 3 6 0 0 4
R e f e r e n c e N o.
I T O 2 6 0 7 2 3 2 3 3 8 3 6 0 0 4
D a t e
2 4 J u l 2 0 2 6 a t 7 : 3 8 A M
`;

Deno.test("normalizes character-spaced OCR without guessing missing fields", () => {
  assert(isGoTymeToGcashReceipt(spacedOcrReceipt), "spaced receipt family");
  assert(hasSuccessfulGoTymeTransfer(spacedOcrReceipt), "spaced completion");
  assertEquals(
    extractGoTymeReference(spacedOcrReceipt, "ITO 260723233836004"),
    "ITO260723233836004",
    "spaced reference",
  );
  assertEquals(
    extractGoTymeTraceId(spacedOcrReceipt),
    "836004",
    "spaced trace",
  );
  assertEquals(
    extractGoTymeRecipientToken(spacedOcrReceipt),
    "A1BS",
    "spaced recipient",
  );
  assertEquals(
    extractGoTymeSenderLast4(spacedOcrReceipt),
    "3100",
    "spaced sender",
  );
  assertEquals(extractGoTymeAmount(spacedOcrReceipt), 720, "spaced amount");
  assertEquals(extractGoTymeFee(spacedOcrReceipt), 0, "spaced fee");
  assertEquals(extractGoTymeTotal(spacedOcrReceipt), 720, "spaced total");
  assert(
    hasConsistentGoTymeAccounting(spacedOcrReceipt),
    "spaced accounting",
  );
  assertEquals(
    parseGoTymePhDateTime(spacedOcrReceipt).shifted?.toISOString(),
    "2026-07-24T07:38:00.000Z",
    "spaced PH time",
  );
});

Deno.test("rejects non-GoTyme and non-GCash transfer receipts", () => {
  const gcashReceipt = suppliedReceipt
    .replace("GoTyme Bank", "Sent via GCash")
    .replace("InstaPay Instant", "Sent via GCash");
  assertEquals(
    isGoTymeToGcashReceipt(gcashReceipt),
    false,
    "GCash receipt detection",
  );
  assertEquals(extractGoTymeReference(gcashReceipt), null, "GCash reference");
  assertEquals(extractGoTymeAmount(gcashReceipt), null, "GCash amount");
  assertEquals(parseGoTymePhDateTime(gcashReceipt).shifted, null, "GCash date");

  const directBankTransfer = suppliedReceipt.replace(
    "G-Xchange, Inc (GCash)",
    "Another Bank, Inc.",
  );
  assertEquals(
    isGoTymeToGcashReceipt(directBankTransfer),
    false,
    "non-GCash destination",
  );
  assertEquals(
    hasSuccessfulGoTymeTransfer(directBankTransfer),
    false,
    "non-GCash completion",
  );

  const pending = suppliedReceipt.replace("Transferred", "Pending");
  assert(isGoTymeToGcashReceipt(pending), "pending receipt family");
  assertEquals(extractGoTymeStatus(pending), "pending", "pending status");
  assertEquals(
    hasSuccessfulGoTymeTransfer(pending),
    false,
    "pending completion",
  );
});

Deno.test("rejects corrupted reference and accounting relationships", () => {
  const wrongTrace = suppliedReceipt.replace(
    "Trace ID 836004",
    "Trace ID 111111",
  );
  assertEquals(
    extractGoTymeReference(wrongTrace),
    "ITO260723233836004",
    "reference remains auditable",
  );
  assertEquals(extractGoTymeTraceId(wrongTrace), "111111", "wrong trace");
  assertEquals(
    hasMatchingGoTymeReferenceTrace(wrongTrace),
    false,
    "wrong suffix relationship",
  );
  assertEquals(
    goTymeReferenceMatchesTrace("ITO260723233836004", "111111"),
    false,
    "direct wrong suffix comparison",
  );

  const malformedReference = suppliedReceipt.replace(
    "ITO260723233836004",
    "ITO26072323383600",
  );
  assertEquals(
    extractGoTymeReference(malformedReference),
    null,
    "short reference",
  );
  assertEquals(
    hasMatchingGoTymeReferenceTrace(malformedReference),
    false,
    "short reference relationship",
  );

  const wrongTotal = suppliedReceipt
    .replace("Fee ₱0.00", "Fee ₱10.00")
    .replace("Total ₱720.00", "Total ₱720.00");
  assertEquals(extractGoTymeFee(wrongTotal), 10, "corrupt fee extraction");
  assertEquals(
    hasConsistentGoTymeAccounting(wrongTotal),
    false,
    "corrupt accounting relationship",
  );

  const conflictingAmount = suppliedReceipt.replace(
    "Amount ₱720.00",
    "Amount ₱720.00\nAmount ₱700.00",
  );
  assertEquals(
    extractGoTymeAmount(conflictingAmount),
    null,
    "ambiguous principal",
  );
  assertEquals(
    hasConsistentGoTymeAccounting(conflictingAmount),
    false,
    "ambiguous accounting",
  );

  const conflictingRail = suppliedReceipt.replace(
    "InstaPay Instant",
    "InstaPay Instant\nPESONet",
  );
  assertEquals(
    extractGoTymeTransferChannel(conflictingRail),
    null,
    "conflicting rail",
  );
  assertEquals(
    hasSuccessfulGoTymeTransfer(conflictingRail),
    false,
    "conflicting rail completion",
  );
});
