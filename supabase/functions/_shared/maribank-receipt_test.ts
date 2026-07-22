import {
  buildMariBankTransactionKey,
  checkMariBankDestinationAccount,
  extractMariBankDestinationAccount,
  extractMariBankReference,
  extractMariBankSenderLast4,
  extractMariBankTotalAmount,
  extractMariBankTransferAmount,
  extractMariBankTransferFee,
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

const actual720Layout = `
MariBank
Transaction Receipt
PHP
720.00
From
CUSTOMER B.
MariBank: *******8412
To
Korte Dos
G-Xchange / GCash
Acct No.: DWQM4TK496R3UA1BS
Transfer Amount
PHP
720.00
Transfer Fee
FREE
Total Amount
PHP
720.00
Reference Number
693634
Transfer Method
InstaPay
Processing Time
Realtime
Transaction Date & Time
22 Jul 2026, 23:54
Receipt generated from MariBank app
`;

const reversed720Layout = `
MariBank
Transaction Receipt
PHP 720.00
From CUSTOMER B.
To Korte Dos
G-Xchange / GCash
DWQM4TK496R3UA1BS
Acct No.
PHP 720.00
Transfer Amount
FREE
Transfer Fee
PHP 720.00
Total Amount
693634
Reference Number
InstaPay
Transfer Method
Realtime
Processing Time
22 Jul 2026, 23:54
Transaction Date & Time
Receipt generated from MariBank app
`;

const grouped720Layout = `
MariBank
Transaction Receipt
From
To
G-Xchange / GCash
Acct No.
Transfer Amount
Transfer Fee
Total Amount
Reference Number
Transfer Method
Processing Time
Transaction Date & Time
CUSTOMER B.
Korte Dos
DWQM4TK496R3UA1BS
PHP 720.00
FREE
PHP 720.00
693634
InstaPay
Realtime
22 Jul 2026, 23:54
PHP 720.00
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

Deno.test("extracts the attached 720 receipt fields across ordinary line breaks", () => {
  const reference = extractMariBankReference(actual720Layout, "693634");
  const amount = extractMariBankTransferAmount(actual720Layout);
  const fee = extractMariBankTransferFee(actual720Layout);
  const total = extractMariBankTotalAmount(actual720Layout);
  const account = extractMariBankDestinationAccount(actual720Layout);
  const parsed = parseMariBankDateTime(actual720Layout);
  if (reference !== "693634") {
    throw new Error(`Unexpected 720 reference: ${reference}`);
  }
  if (amount !== 720) throw new Error(`Unexpected 720 amount: ${amount}`);
  if (fee !== 0) throw new Error(`Unexpected 720 fee: ${fee}`);
  if (total !== 720) throw new Error(`Unexpected 720 total: ${total}`);
  if (account !== "DWQM4TK496R3UA1BS") {
    throw new Error(`Unexpected 720 destination account: ${account}`);
  }
  if (parsed.date !== "2026-07-22") {
    throw new Error(`Unexpected 720 date: ${parsed.date}`);
  }
  if (parsed.shifted?.toISOString() !== "2026-07-22T23:54:00.000Z") {
    throw new Error(`Unexpected 720 time: ${parsed.shifted?.toISOString()}`);
  }
  if (!hasSuccessfulMariBankTransfer(actual720Layout)) {
    throw new Error("The attached Realtime receipt was not recognized");
  }
});

Deno.test("supports bounded value-before-label OCR ordering", () => {
  if (extractMariBankReference(reversed720Layout, "693634") !== "693634") {
    throw new Error("Reversed reference was not extracted");
  }
  if (extractMariBankTransferAmount(reversed720Layout) !== 720) {
    throw new Error("Reversed transfer amount was not extracted");
  }
  if (extractMariBankTransferFee(reversed720Layout) !== 0) {
    throw new Error("Reversed FREE transfer fee was not extracted");
  }
  if (
    extractMariBankDestinationAccount(reversed720Layout) !==
      "DWQM4TK496R3UA1BS"
  ) {
    throw new Error("Reversed destination account was not extracted");
  }
  const parsed = parseMariBankDateTime(reversed720Layout);
  if (parsed.shifted?.toISOString() !== "2026-07-22T23:54:00.000Z") {
    throw new Error(
      `Reversed date/time failed: ${parsed.shifted?.toISOString()}`,
    );
  }
  if (!hasSuccessfulMariBankTransfer(reversed720Layout)) {
    throw new Error("Reversed completion markers were not recognized");
  }
});

Deno.test("supports Google Vision column-group ordering conservatively", () => {
  if (extractMariBankReference(grouped720Layout, "693634") !== "693634") {
    throw new Error("Grouped reference was not extracted");
  }
  if (extractMariBankTransferAmount(grouped720Layout) !== 720) {
    throw new Error("Repeated grouped amount was not extracted");
  }
  if (extractMariBankTransferFee(grouped720Layout) !== 0) {
    throw new Error("Grouped FREE transfer fee was not extracted");
  }
  if (
    extractMariBankDestinationAccount(grouped720Layout) !==
      "DWQM4TK496R3UA1BS"
  ) {
    throw new Error("Grouped destination account was not extracted");
  }
  const parsed = parseMariBankDateTime(grouped720Layout);
  if (parsed.shifted?.toISOString() !== "2026-07-22T23:54:00.000Z") {
    throw new Error(
      `Grouped date/time failed: ${parsed.shifted?.toISOString()}`,
    );
  }
  if (hasSuccessfulMariBankTransfer(grouped720Layout)) {
    throw new Error("Unpaired grouped completion markers were accepted");
  }
});

Deno.test("uses a unique whole-receipt date when OCR separates the columns", () => {
  const separated = grouped720Layout.replace(
    "Transaction Date & Time\nCUSTOMER B.",
    `Transaction Date & Time\n${"unrelated OCR text ".repeat(20)}\nCUSTOMER B.`,
  );
  const parsed = parseMariBankDateTime(separated);
  if (parsed.shifted?.toISOString() !== "2026-07-22T23:54:00.000Z") {
    throw new Error(
      `Whole-receipt date fallback failed: ${parsed.shifted?.toISOString()}`,
    );
  }
});

Deno.test("leaves conflicting principal amounts for manual review", () => {
  const labeledDisagreement = actual720Layout.replace(
    "Transfer Amount\nPHP\n720.00",
    "Transfer Amount\nPHP\n710.00",
  );
  if (extractMariBankTransferAmount(labeledDisagreement) !== null) {
    throw new Error("A labeled/repeated amount disagreement was accepted");
  }

  const repeatedDisagreement = grouped720Layout.replace(
    "PHP 720.00\n693634",
    "PHP 710.00\n693634",
  );
  if (extractMariBankTransferAmount(repeatedDisagreement) !== null) {
    throw new Error("A grouped 720/720/710 amount set was accepted");
  }

  const onlyTwoCopies = grouped720Layout.replace(
    "\nPHP 720.00\nReceipt",
    "\nReceipt",
  );
  if (extractMariBankTransferAmount(onlyTwoCopies) !== null) {
    throw new Error("A two-copy grouped amount fallback was accepted");
  }
});

Deno.test("leaves conflicting receipt dates for manual review", () => {
  const conflicting = actual720Layout.replace(
    "MariBank\nTransaction Receipt",
    `23 Jul 2026, 00:10\n${
      "unrelated OCR text ".repeat(20)
    }\nMariBank\nTransaction Receipt`,
  );
  const parsed = parseMariBankDateTime(conflicting);
  if (parsed.date !== null || parsed.shifted !== null) {
    throw new Error("Conflicting MariBank dates were accepted");
  }
});

Deno.test("requires strong receipt context for a typed reference fallback", () => {
  const reference = extractMariBankReference(
    "MariBank transfer confirmation 693634",
    "693634",
  );
  if (reference !== null) {
    throw new Error(`Weak-context typed reference was accepted: ${reference}`);
  }

  const decorated = extractMariBankReference(grouped720Layout, "MB693634");
  if (decorated !== null) {
    throw new Error(`Non-exact typed reference was accepted: ${decorated}`);
  }
});

Deno.test("rejects competing global candidates in the typed reference fallback", () => {
  for (const other of ["111111", "1 1 1 1 1 1"]) {
    const conflicting = grouped720Layout.replace(
      "Receipt generated from MariBank app",
      `${other}\nReceipt generated from MariBank app`,
    );
    const reference = extractMariBankReference(conflicting, "693634");
    if (reference !== null) {
      throw new Error(`Competing global reference was accepted: ${reference}`);
    }
  }
});

Deno.test("rejects a distant competing reference even when one is labeled", () => {
  const conflicting = actual720Layout.replace(
    "Receipt generated from MariBank app",
    "Audit token 111111\nReceipt generated from MariBank app",
  );
  const reference = extractMariBankReference(conflicting, "693634");
  if (reference !== null) {
    throw new Error(
      `A distant conflicting reference was accepted: ${reference}`,
    );
  }
});

Deno.test("leaves conflicting nearby references for manual review", () => {
  const conflicting = actual720Layout.replace(
    "Reference Number\n693634",
    "111111\nReference Number\n693634",
  );
  const reference = extractMariBankReference(conflicting, "693634");
  if (reference !== null) {
    throw new Error(`Conflicting references were accepted: ${reference}`);
  }
});

Deno.test("requires every independent completion marker without contradictions", () => {
  const missingLabel = actual720Layout.replace("Processing Time\n", "");
  if (hasSuccessfulMariBankTransfer(missingLabel)) {
    throw new Error("Receipt without a Processing Time label passed");
  }
  const failures = [
    "Pending",
    "Scheduled",
    "Processing",
    "Rejected",
    "Reject",
    "Unsuccessful",
    "Not successful",
    "Not completed",
    "Not-Successful",
    "Not-Completed",
    "Not—Realtime",
    "Refund",
    "Refunded",
    "Reversal",
    "Returned",
    "Void",
    "Voided",
    "Expired",
    "Error",
    "In progress",
    "In-Progress",
    "On-Hold",
  ];
  for (const failure of failures) {
    const contradictory = actual720Layout.replace(
      "Realtime",
      `Realtime\n${failure}`,
    );
    if (hasSuccessfulMariBankTransfer(contradictory)) {
      throw new Error(`Receipt with a ${failure} marker passed`);
    }
  }
});

Deno.test("requires status and method values to be paired with their labels", () => {
  const scheduledWithStrayRealtime = actual720Layout.replace(
    "Processing Time\nRealtime",
    "Processing Time Scheduled\nRealtime",
  );
  if (hasSuccessfulMariBankTransfer(scheduledWithStrayRealtime)) {
    throw new Error("A stray Realtime token overrode Scheduled");
  }

  const notRealtime = actual720Layout.replace(
    "Processing Time\nRealtime",
    "Processing Time Not Realtime",
  );
  if (hasSuccessfulMariBankTransfer(notRealtime)) {
    throw new Error("Not Realtime was accepted as Realtime");
  }

  const wrongMethodWithStrayInstapay = actual720Layout.replace(
    "Transfer Method\nInstaPay",
    "Transfer Method PESONet\nInstaPay",
  );
  if (hasSuccessfulMariBankTransfer(wrongMethodWithStrayInstapay)) {
    throw new Error("A stray InstaPay token overrode PESONet");
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

Deno.test("destination extraction leaves multiple account candidates unreadable", () => {
  const withSenderAccount = sample.replace(
    "MariBank: *******5910",
    "MariBank: *******5910\nAccount No.: SENDER4TK496R3UA999",
  );
  if (extractMariBankDestinationAccount(withSenderAccount) !== null) {
    throw new Error("Multiple sender/destination accounts were accepted");
  }

  const matchingFirst = sample.replace(
    "Acct No.: DWQM4TK496R3UA1BS",
    "Acct No.: DWQM4TK496R3UA1BS\nAccount No.: SENDER4TK496R3UA999",
  );
  if (extractMariBankDestinationAccount(matchingFirst) !== null) {
    throw new Error(
      "A matching first account hid a conflicting second account",
    );
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

Deno.test("extracts FREE and labeled numeric transfer fees conservatively", () => {
  if (extractMariBankTransferFee(sample) !== 0) {
    throw new Error("Same-row FREE fee was not extracted");
  }
  if (extractMariBankTransferFee(actual720Layout) !== 0) {
    throw new Error("Label-before-value FREE fee was not extracted");
  }

  const labeledAmount = sample.replace(
    "Transfer Fee FREE",
    "Transfer Fee PHP 10.00",
  );
  if (extractMariBankTransferFee(labeledAmount) !== 10) {
    throw new Error("Same-row numeric fee was not extracted");
  }
  const valueBefore = sample.replace(
    "Transfer Fee FREE",
    "PHP 10.00\nTransfer Fee",
  );
  if (extractMariBankTransferFee(valueBefore) !== 10) {
    throw new Error("Value-before-label numeric fee was not extracted");
  }

  const contradictory = sample.replace(
    "Transfer Fee FREE",
    "Transfer Fee FREE PHP 10.00",
  );
  if (extractMariBankTransferFee(contradictory) !== null) {
    throw new Error("Contradictory FREE/numeric fee was accepted");
  }
  const groupedNumeric = grouped720Layout.replace("FREE", "PHP 10.00");
  if (extractMariBankTransferFee(groupedNumeric) !== null) {
    throw new Error("Unassociated grouped numeric fee was accepted");
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
