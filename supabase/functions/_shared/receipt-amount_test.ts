import { extractReceiptAmount } from "./receipt-amount.ts";

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

const suppliedMayaText = `
Sent money via
- P1,080.00
InstaPay QRPh
Jul 13, 2026, 08:03 pm
Account type G-Xchange Inc. / GCash
Account number DWQM4TK496R3UA1BS
Account name Korte Dos
Transfer Fee
P10.00
Reference ID A7B9 7F99 B743
InstaPay Ref. No 336212
maya
`;

Deno.test("Maya principal amount wins over its transfer fee", () => {
  const result = extractReceiptAmount(suppliedMayaText, {
    provider: "maya",
  });

  assertEquals(result.amount, 1080, "principal amount");
  assertEquals(result.reliable, true, "principal reliability");
  assertEquals(result.ambiguous, false, "principal ambiguity");
  assert(
    result.evidence.includes("maya_sent_money_context"),
    "Maya layout evidence should be retained",
  );
  const fee = result.candidates.find((candidate) => candidate.amount === 10);
  assert(fee, "transfer fee should remain visible for audit diagnostics");
  assertEquals(fee.excluded, true, "transfer fee exclusion");
  assert(
    fee.exclusionReasons.includes("transfer_fee"),
    "transfer fee should say why it was excluded",
  );
});

Deno.test("a genuine small Maya principal remains a reliable underpayment read", () => {
  const result = extractReceiptAmount(
    "Sent money via\n- P80.00\nInstaPay QRPh",
    { provider: "maya" },
  );

  assertEquals(result.amount, 80, "small Maya principal");
  assertEquals(result.reliable, true, "small principal reliability");
  assert(
    result.evidence.includes("maya_sent_money_context"),
    "a real small principal must still be eligible for server-side comparison",
  );
});

Deno.test("a fee-only Maya read is not accepted as the principal", () => {
  const result = extractReceiptAmount(
    "Sent money via\nTransfer Fee P10.00\nmaya",
    { provider: "maya" },
  );

  assertEquals(result.amount, null, "fee-only amount");
  assertEquals(result.reliable, false, "fee-only reliability");
  assertEquals(result.reason, "all_candidates_excluded", "fee-only reason");
});

for (
  const [label, value] of [
    ["ASCII P attached", "P1,080.00"],
    ["ASCII P spaced", "P 1,080.00"],
    ["PHP attached", "PHP1,080.00"],
    ["peso sign attached", "₱1,080.00"],
  ] as const
) {
  Deno.test(`parses Maya ${label}`, () => {
    const result = extractReceiptAmount(
      `Sent money via\n- ${value}\nInstaPay QRPh`,
      {
        provider: "maya",
      },
    );
    assertEquals(result.amount, 1080, label);
    assertEquals(result.reliable, true, `${label} reliability`);
    assert(
      !result.evidence.includes("maya_ocr_spacing_repair"),
      `${label} should not report an unnecessary spacing repair`,
    );
  });
}

for (
  const [label, value] of [
    ["split after one thousands digit", "P1,0 80.00"],
    ["space after thousands comma", "P1, 080.00"],
    ["space instead of thousands comma", "P1 080.00"],
  ] as const
) {
  Deno.test(`repairs conservative Maya OCR spacing: ${label}`, () => {
    const result = extractReceiptAmount(
      `Sent money via\n- ${value}\nInstaPay QRPh`,
      { provider: "maya" },
    );
    assertEquals(result.amount, 1080, label);
    assertEquals(result.reliable, true, `${label} reliability`);
    assert(
      result.evidence.includes("maya_ocr_spacing_repair"),
      `${label} repair evidence`,
    );
    assert(
      !result.candidates.some((candidate) => candidate.amount === 80),
      `${label} must not produce a suffix candidate`,
    );
  });
}

Deno.test("spaced thousands repair requires both Maya anchor and currency", () => {
  const withoutAnchor = extractReceiptAmount("Payment P1,0 80.00", {
    provider: "maya",
  });
  assertEquals(withoutAnchor.amount, null, "missing Maya anchor");
  assertEquals(withoutAnchor.reason, "no_candidates", "missing anchor reason");

  const withoutCurrency = extractReceiptAmount(
    "Sent money via\n1,0 80.00\nInstaPay QRPh",
    { provider: "maya" },
  );
  assertEquals(withoutCurrency.amount, null, "missing currency marker");
  assertEquals(
    withoutCurrency.reason,
    "no_candidates",
    "missing currency reason",
  );
});

Deno.test("malformed spaced grouping stays unreadable", () => {
  for (
    const value of [
      "P1 08.00",
      "P1,00 80.00",
      "P1 0800.00",
      "P0 080.00",
    ]
  ) {
    const result = extractReceiptAmount(`Sent money via\n${value}`, {
      provider: "maya",
    });
    assertEquals(result.amount, null, `malformed ${value}`);
    assertEquals(result.reason, "no_candidates", `malformed reason ${value}`);
  }
});

Deno.test("spaced Maya fee candidate remains excluded", () => {
  const result = extractReceiptAmount(
    "Sent money via\nTransfer Fee P1,0 80.00",
    { provider: "maya" },
  );
  assertEquals(result.amount, null, "spaced fee amount");
  assertEquals(result.reason, "all_candidates_excluded", "spaced fee reason");
  const fee = result.candidates.find((candidate) => candidate.amount === 1080);
  assert(fee, "spaced fee should remain in diagnostics");
  assertEquals(fee.excluded, true, "spaced fee exclusion");
  assert(fee.exclusionReasons.includes("transfer_fee"), "spaced fee evidence");
});

Deno.test("never suffix-parses a thousands amount as comma-tail digits", () => {
  const result = extractReceiptAmount("Sent money via\n- P1,080.00", {
    provider: "maya",
  });
  assertEquals(result.amount, 1080, "full thousands amount");
  assert(
    !result.candidates.some((candidate) => candidate.amount === 80),
    "the parser must never create an 80 candidate from ,080.00",
  );

  const bareSuffix = extractReceiptAmount("untrusted OCR fragment ,080.00", {
    provider: "maya",
  });
  assertEquals(bareSuffix.amount, null, "bare comma suffix");
  assertEquals(bareSuffix.reason, "no_candidates", "bare suffix reason");
});

Deno.test("explicit amount label works without a currency marker", () => {
  const result = extractReceiptAmount("Total amount sent: 1,080.00");
  assertEquals(result.amount, 1080, "labeled amount");
  assertEquals(result.reliable, true, "labeled amount reliability");
  assert(result.evidence.includes("total_label"), "total evidence");
});

Deno.test("fee reference date and account candidates are excluded", () => {
  const result = extractReceiptAmount(
    `
Transfer Fee P10.00
Service fee
P20.00
Reference ID P300.00
Date total P400.00
Account balance P500.00
Sent money via
P1,080.00
`,
    { provider: "maya" },
  );

  assertEquals(result.amount, 1080, "only principal remains eligible");
  for (const amount of [10, 20, 300, 400, 500]) {
    const candidate = result.candidates.find((item) => item.amount === amount);
    assert(candidate, `candidate ${amount} should be retained for diagnostics`);
    assertEquals(candidate.excluded, true, `candidate ${amount} exclusion`);
  }
});

Deno.test("fee labels remain attached across blank OCR lines", () => {
  const result = extractReceiptAmount(
    `
Sent money via
P1,080.00
Service Fee

P20.00
`,
    { provider: "maya" },
  );

  assertEquals(result.amount, 1080, "principal across blank OCR lines");
  const fee = result.candidates.find((candidate) => candidate.amount === 20);
  assert(fee, "fee candidate across blank OCR lines");
  assertEquals(fee.excluded, true, "blank-line fee exclusion");
  assert(fee.exclusionReasons.includes("service_fee"), "service fee reason");
});

Deno.test("equivalent receipt-context candidates are ambiguous without expected amount", () => {
  const result = extractReceiptAmount("Amount P500.00\nAmount P600.00");
  assertEquals(result.amount, null, "ambiguous amount");
  assertEquals(result.reliable, false, "ambiguous reliability");
  assertEquals(result.ambiguous, true, "ambiguous flag");
  assertEquals(result.reason, "ambiguous", "ambiguous reason");
});

Deno.test("a weaker amount label cannot override the Maya principal", () => {
  const result = extractReceiptAmount(
    `
Sent money via
P1,080.00
InstaPay QRPh
Amount P500.00
`,
    { provider: "maya" },
  );

  assertEquals(result.amount, 1080, "stronger Maya receipt evidence");
});

Deno.test("an excluded fee can never override the Maya principal", () => {
  const result = extractReceiptAmount(
    `
Sent money via
P1,080.00
Transfer Fee P10.00
`,
    { provider: "maya" },
  );
  assertEquals(result.amount, 1080, "excluded fee must not be selected");
});

Deno.test("a currency-only candidate is returned but conservatively unreliable", () => {
  const result = extractReceiptAmount("Payment receipt\nP750.00");
  assertEquals(result.amount, 750, "currency-only amount");
  assertEquals(result.reliable, false, "currency-only reliability");
  assertEquals(result.ambiguous, false, "currency-only ambiguity");
});
