import {
  buildMariBankTransactionKey,
  checkMariBankDestinationAccount,
  extractMariBankDestinationAccount,
  extractMariBankReference,
  extractMariBankSenderLast4,
  extractMariBankTotalAmount,
  extractMariBankTransferAmount,
  hasSuccessfulMariBankTransfer,
  isMariBankReceipt,
  isMariBankReference,
  parseMariBankDateTime,
} from "./maribank-receipt.ts";

const sample = `
MariBank
Transaction Receipt
PHP 360.00
From
CUSTOMER A.
MariBank: *******5910
To
Korte Dos
G-Xchange / GCash
Acct No.: DWQM4TK496R3UA1BS
Transfer Amount PHP 360.00
Transfer Fee FREE
Total Amount PHP 360.00
Reference Number 012710
Transfer Method InstaPay
Processing Time Realtime
Transaction Date & Time 22 Jul 2026, 14:33
Receipt generated from MariBank app
`;

Deno.test("recognizes the current MariBank realtime InstaPay receipt", () => {
  if (!isMariBankReceipt(sample)) {
    throw new Error("MariBank receipt not recognized");
  }
  if (!hasSuccessfulMariBankTransfer(sample)) {
    throw new Error("MariBank completion evidence not recognized");
  }
});

Deno.test("extracts the six-digit reference without dropping its leading zero", () => {
  if (!isMariBankReference("012710")) throw new Error("Reference rejected");
  if (isMariBankReference("MB012710")) {
    throw new Error("Reference validator accepted extra characters");
  }
  const reference = extractMariBankReference(sample, "012710");
  if (reference !== "012710") {
    throw new Error(`Unexpected reference: ${reference}`);
  }
});

Deno.test("requires a reference label before trusting a six-digit token", () => {
  const reference = extractMariBankReference(
    "MariBank Transaction Receipt 22 Jul 2026 PHP 127.10",
    "012710",
  );
  if (reference !== null) {
    throw new Error(`Unexpected bare reference: ${reference}`);
  }
});

Deno.test("tolerates OCR spacing inside the labeled reference", () => {
  const reference = extractMariBankReference(
    "Reference Number\n0 1 2 7 1 0",
    "012710",
  );
  if (reference !== "012710") {
    throw new Error(`Unexpected spaced reference: ${reference}`);
  }
});

Deno.test("extracts and validates the GCash destination account token", () => {
  const account = extractMariBankDestinationAccount(sample);
  if (account !== "DWQM4TK496R3UA1BS") {
    throw new Error(`Unexpected destination: ${account}`);
  }
  if (
    checkMariBankDestinationAccount(sample, "DWQM4TK496R3UA1BS") !== "match"
  ) {
    throw new Error("Expected destination match");
  }
  if (
    checkMariBankDestinationAccount(sample, "ZZZZ4TK496R3UA999") !== "wrong"
  ) {
    throw new Error("Expected wrong destination");
  }
  if (checkMariBankDestinationAccount(sample, "") !== "unconfigured") {
    throw new Error("Expected unconfigured destination");
  }
  if (
    checkMariBankDestinationAccount(
      sample.replace("Acct No.: DWQM4TK496R3UA1BS", "Acct No.: unreadable"),
      "DWQM4TK496R3UA1BS",
    ) !== "unreadable"
  ) {
    throw new Error("Expected unreadable destination");
  }
});

Deno.test("extracts only the masked sender account suffix", () => {
  const suffix = extractMariBankSenderLast4(sample);
  if (suffix !== "5910") throw new Error(`Unexpected sender suffix: ${suffix}`);
});

Deno.test("builds a replay key from more than the short reference", () => {
  const parsed = parseMariBankDateTime(sample);
  const key = buildMariBankTransactionKey({
    reference: "012710",
    transactionDateTime: parsed.shifted,
    amount: 360,
  });
  if (
    key !== "maribank_transaction:2026-07-22T14:33:012710:360.00"
  ) {
    throw new Error(`Unexpected transaction key: ${key}`);
  }
  const nextDay = buildMariBankTransactionKey({
    reference: "012710",
    transactionDateTime: new Date("2026-07-23T14:33:00.000Z"),
    amount: 360,
  });
  if (nextDay === key) throw new Error("Reference collided across dates");
});

Deno.test("destination extraction ignores a sender-side account number", () => {
  const withSenderAccount = sample.replace(
    "MariBank: *******5910",
    "MariBank: *******5910\nAccount No.: SENDER4TK496R3UA999",
  );
  const account = extractMariBankDestinationAccount(withSenderAccount);
  if (account !== "DWQM4TK496R3UA1BS") {
    throw new Error(`Selected the wrong account section: ${account}`);
  }
});

Deno.test("uses Transfer Amount as principal and keeps Total Amount for audit", () => {
  const principal = extractMariBankTransferAmount(sample);
  const total = extractMariBankTotalAmount(sample);
  if (principal !== 360) throw new Error(`Unexpected principal: ${principal}`);
  if (total !== 360) throw new Error(`Unexpected total: ${total}`);

  const feeExample = sample
    .replace("Transfer Fee FREE", "Transfer Fee PHP 10.00")
    .replace("Total Amount PHP 360.00", "Total Amount PHP 370.00");
  if (extractMariBankTransferAmount(feeExample) !== 360) {
    throw new Error("Fee changed the principal transfer amount");
  }
  if (extractMariBankTotalAmount(feeExample) !== 370) {
    throw new Error("Total amount was not retained separately");
  }
});

Deno.test("parses MariBank day-first 24-hour transaction time", () => {
  const parsed = parseMariBankDateTime(sample);
  if (parsed.date !== "2026-07-22") {
    throw new Error(`Unexpected date: ${parsed.date}`);
  }
  if (parsed.shifted?.toISOString() !== "2026-07-22T14:33:00.000Z") {
    throw new Error(`Unexpected time: ${parsed.shifted?.toISOString()}`);
  }
});

Deno.test("parses MariBank AM/PM transaction time", () => {
  const afternoon = sample.replace("14:33", "2:33 PM");
  const parsedAfternoon = parseMariBankDateTime(afternoon);
  if (parsedAfternoon.shifted?.toISOString() !== "2026-07-22T14:33:00.000Z") {
    throw new Error(
      `Unexpected PM time: ${parsedAfternoon.shifted?.toISOString()}`,
    );
  }

  const midnight = sample.replace("14:33", "12:05 AM");
  const parsedMidnight = parseMariBankDateTime(midnight);
  if (parsedMidnight.shifted?.toISOString() !== "2026-07-22T00:05:00.000Z") {
    throw new Error(
      `Unexpected midnight: ${parsedMidnight.shifted?.toISOString()}`,
    );
  }
});

Deno.test("does not treat a pending transfer as completed", () => {
  const pending = sample.replace(
    "Processing Time Realtime",
    "Processing Time Pending",
  );
  if (hasSuccessfulMariBankTransfer(pending)) {
    throw new Error("Pending transfer passed completion check");
  }
});

Deno.test("rejects invalid calendar dates instead of normalizing them", () => {
  const invalid = sample.replace("22 Jul 2026, 14:33", "31 Feb 2026, 14:33");
  const parsed = parseMariBankDateTime(invalid);
  if (parsed.date !== null || parsed.shifted !== null) {
    throw new Error("Invalid MariBank date was normalized");
  }
});
