import {
  extractBdoPayReference,
  hasBdoPayReference,
  isBdoPayReceipt,
  isBdoPayReference,
  normalizeBdoPayReference,
} from "./bdo-pay-receipt.ts";

const currentBdoPaySample = `
Sent!
PHP 1,080.00
Jul 25, 2026 11:33 AM
Amount PHP 1,080.00
Service Fee PHP 0.00
Send Money via InstaPay
To
Korte Dos
G-XCHANGE, INC. / GCASH
DWM4TK496R3UA1BS
From
PERA AGAD ATM SA PINOY RES-TAX
Invoice number
967179
Reference no.
BN-NB-20260725-02534395
`;

Deno.test("extracts the current BN-NB BDO Pay reference independently", () => {
  const reference = extractBdoPayReference(currentBdoPaySample);
  if (reference !== "BNNB2026072502534395") {
    throw new Error(`Unexpected BDO Pay reference: ${reference}`);
  }
});

Deno.test("supports the legacy BN BDO Pay reference", () => {
  const reference = extractBdoPayReference(
    "Reference no. BN-20260725-02534395",
  );
  if (reference !== "BN2026072502534395") {
    throw new Error(`Unexpected legacy reference: ${reference}`);
  }
});

Deno.test("accepts normalized and OCR separator-tolerant references", () => {
  const variants = [
    "BNNB2026072502534395",
    "BN NB 2026 07 25 0253 4395",
    "BN—NB—20260725—02534395",
    "B N - N B\n2026 07 25\n0253 4395",
  ];
  for (const variant of variants) {
    const extracted = extractBdoPayReference(`Reference no.: ${variant}`);
    if (extracted !== "BNNB2026072502534395") {
      throw new Error(`Could not normalize ${variant}: ${extracted}`);
    }
  }
});

Deno.test("does not echo a customer-entered value absent from OCR", () => {
  const entered = "BN-20260725-02534395";
  const extracted = extractBdoPayReference(
    `${currentBdoPaySample}\nEntered by customer: ${entered}`,
  );
  if (extracted !== "BNNB2026072502534395") {
    throw new Error(`Expected the labeled OCR reference, got ${extracted}`);
  }
});

Deno.test("recognizes current receipt from BN-NB reference and InstaPay", () => {
  if (!hasBdoPayReference(currentBdoPaySample)) {
    throw new Error("BN-NB reference was not recognized");
  }
  if (!isBdoPayReceipt(currentBdoPaySample)) {
    throw new Error("Current BDO Pay receipt was not recognized");
  }
});

Deno.test("validates both BDO Pay formats and rejects malformed values", () => {
  const valid = [
    "BN-20260725-02534395",
    "BN-NB-20260725-02534395",
    "BNNB2026072502534395",
  ];
  for (const reference of valid) {
    if (!isBdoPayReference(reference)) {
      throw new Error(`Expected valid reference: ${reference}`);
    }
  }

  const invalid = [
    "BN-NB-20260725-0253439",
    "BN-XX-20260725-02534395",
    "BN-NB-20260725-025343951",
  ];
  for (const reference of invalid) {
    if (isBdoPayReference(reference)) {
      throw new Error(`Expected invalid reference: ${reference}`);
    }
  }

  if (
    normalizeBdoPayReference("BN-NB-20260725-02534395") !==
      "BNNB2026072502534395"
  ) {
    throw new Error("Reference normalization changed unexpectedly");
  }
});
