import {
  checkBpiReceiverNumber,
  checkGcashReceiverNumber,
  type ReceiverNumberCheck,
} from "./receiver-number.ts";

const EXPECTED = "09453984516";

function assertResult(
  actual: ReceiverNumberCheck,
  expected: ReceiverNumberCheck,
): void {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, got ${actual}`);
  }
}

const screenshotStyleGcashReceipt = `
2:41
Express Send
J•• KE••••H M.
+63 9•• ••• 4516
Sent via GCash
Amount
720.00
Total Amount Sent
₱720.00
Ref No. 9043190886590
Jul 23, 2026 2:41 PM
`;

Deno.test("matches the masked receiver on the reported GCash receipt", () => {
  assertResult(
    checkGcashReceiverNumber(screenshotStyleGcashReceipt, EXPECTED),
    "match",
  );
});

Deno.test("a 13-digit GCash reference is not parsed as a mobile number", () => {
  const receipt = `
Express Send
Ref No. 9043190886590
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("a long spaced or hyphenated reference remains one numeric token", () => {
  const receipt = `
Express Send
9043-1908 8659-0123 4516
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("a reference ending with the expected suffix is not receiver proof", () => {
  const receipt = `
Express Send
Ref No. 9043190884516
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("a full mismatch in a generic GCash block requires review", () => {
  const receipt = `
Express Send
0917 111 2222
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("a clearly different receiver-scoped full number is wrong", () => {
  const receipt = `
Express Send
Receiver
0917 111 2222
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "wrong");
});

Deno.test("reference digits cannot override a clearly wrong full receiver", () => {
  const receipt = `
Express Send
Receiver
0917 111 2222
Ref No. 9043190884516
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "wrong");
});

Deno.test("conflicting receiver-scoped full numbers require review", () => {
  const receipt = `
Express Send
Receiver
0945 398 4516
Recipient
0917 111 2222
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("a masked match remains valid alongside long references", () => {
  const receipt = `
Express Send
+63 9•• ••• 4516
Ref No. 9043 1908 8659 0123 4567
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "match");
});

Deno.test("a different masked suffix alone is not a hard rejection", () => {
  const receipt = `
Express Send
+63 9•• ••• 2222
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("incomplete masked mobile shapes are not accepted", () => {
  for (const masked of ["9..4516", "9xx4516", "9##4516"]) {
    const receipt = `
Express Send
${masked}
Sent via GCash
`;
    assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
  }
});

Deno.test("bare matching digits are not accepted as receiver evidence", () => {
  const receipt = `
Express Send
Audit value 4516
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("punctuated reference labels exclude same-line mobile-shaped values", () => {
  const receipt = `
Express Send
Transaction Ref. No. 09453984516
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("reference labels exclude mobile-shaped values on the next line", () => {
  const receipt = `
Express Send
Ref. No.
09453984516
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("reference labels also exclude structurally masked values", () => {
  const sameLine = `
Express Send
Ref. No. +63 9•• ••• 4516
Sent via GCash
`;
  const nextLine = `
Express Send
Reference No.
+63 9•• ••• 4516
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(sameLine, EXPECTED), "unreadable");
  assertResult(checkGcashReceiverNumber(nextLine, EXPECTED), "unreadable");
});

Deno.test("a reference split across lines is not joined into a mobile", () => {
  const receipt = `
Express Send
Ref No. 9043190886
590
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("a one-digit OCR disagreement requires review", () => {
  const receipt = `
Express Send
Receiver
0945 398 4517
Sent via GCash
`;
  assertResult(checkGcashReceiverNumber(receipt, EXPECTED), "unreadable");
});

Deno.test("an invalid configured receiver cannot be auto-validated", () => {
  assertResult(
    checkGcashReceiverNumber(screenshotStyleGcashReceipt, "4516"),
    "unreadable",
  );
});

Deno.test("BPI checks use only the BPI destination block", () => {
  const receipt = `
Transfer successful!
Confirmation No. 9043190886590
Transaction Ref. No. 9043190886
Sent via BPI
Transfer to
GCash/G-Xchange
J**KE****H M.
09453984516
Transfer amount
PHP 720.00
`;
  assertResult(checkBpiReceiverNumber(receipt, EXPECTED), "match");
});

Deno.test("BPI clearly wrong destination is still rejected", () => {
  const receipt = `
Transfer successful!
Sent via BPI
Transfer to
GCash/G-Xchange
J**KE****H M.
09171112222
Transfer amount
PHP 720.00
`;
  assertResult(checkBpiReceiverNumber(receipt, EXPECTED), "wrong");
});

Deno.test("a BPI mismatch cannot hard-reject when OCR is uncertain", () => {
  const receipt = `
Transfer successful!
Sent via BPI
Transfer to
GCash/G-Xchange
J**KE****H M.
09171112222
Transfer amount
PHP 720.00
`;
  assertResult(
    checkBpiReceiverNumber(receipt, EXPECTED, { allowHardWrong: false }),
    "unreadable",
  );
});
