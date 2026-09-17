import {
  extractBpiConfirmationNo,
  extractBpiTransactionRefNo,
  hasGcashGxiDestination,
  hasSuccessfulBpiTransfer,
  isBpiReceipt,
} from "./bpi-receipt.ts";
import { checkBpiReceiverNumber } from "./receiver-number.ts";

const sample = `
Transfer successful!
Wednesday, Jul 15 2026; 06:32:08 PM (GMT +8)
Confirmation No. 1619618752333
Transaction Ref. No. 716395
Sent via BPI
Transfer to
GCash/G-Xchange
J**KE****H M.
09453984516
Transfer amount
PHP 310.00
Fee
PHP 0.00
`;

const currentQrSample = `
Transfer successful!
Thursday, Sep 17 2026; 04:19:55 PM (GMT +8)
Confirmation No. 1626016391287
Transaction Ref. No. 250735
Sent via BPI
Transfer to
GCash/G-Xchange
Korte Dos (QR Code)
xxxxxxxxxxxxx1BS
Transfer amount
PHP 720.00
Fee
PHP 0.00
`;

Deno.test("recognizes the current BPI transfer-success layout", () => {
  if (!isBpiReceipt(sample)) throw new Error("BPI receipt was not recognized");
  if (!hasSuccessfulBpiTransfer(sample)) {
    throw new Error("BPI success evidence was not recognized");
  }
  if (!hasGcashGxiDestination(sample)) {
    throw new Error("GCash destination was not recognized");
  }
});

Deno.test("extracts both BPI references from the current layout", () => {
  const confirmation = extractBpiConfirmationNo(sample, "1619618752333");
  const transaction = extractBpiTransactionRefNo(sample);
  if (confirmation !== "1619618752333") {
    throw new Error(`Unexpected confirmation: ${confirmation}`);
  }
  if (transaction !== "716395") {
    throw new Error(`Unexpected transaction ref: ${transaction}`);
  }
});

Deno.test("matches the configured GCash receiver number on a BPI receipt", () => {
  const result = checkBpiReceiverNumber(sample, "0945 398 4516");
  if (result !== "match") {
    throw new Error(`Expected receiver match, got ${result}`);
  }
});

Deno.test("rejects a clearly different receiver number", () => {
  const result = checkBpiReceiverNumber(sample, "0917 111 2222");
  if (result !== "wrong") {
    throw new Error(`Expected wrong receiver, got ${result}`);
  }
});

Deno.test("a wrong full mobile number cannot be overridden by other matching digits", () => {
  const receipt = `${sample}\nUnrelated audit value 4516`;
  const result = checkBpiReceiverNumber(receipt, "0917 111 4516");
  if (result !== "wrong") {
    throw new Error(`Expected wrong receiver, got ${result}`);
  }
});

Deno.test("requires both a success heading and BPI evidence", () => {
  if (hasSuccessfulBpiTransfer("Sent via BPI\nTransfer pending")) {
    throw new Error("A pending BPI transfer must not pass the success check");
  }
  if (hasSuccessfulBpiTransfer("Transfer successful\nSent via another bank")) {
    throw new Error("A non-BPI transfer must not pass the BPI check");
  }
});

Deno.test("does not require InstaPay, QRPh, or an unmasked receiver name", () => {
  if (/insta\s*pay|qr\s*ph/i.test(sample)) {
    throw new Error("Sample unexpectedly contains old indicators");
  }
  if (!hasSuccessfulBpiTransfer(sample)) {
    throw new Error("Valid BPI receipt should remain eligible");
  }
});

Deno.test("recognizes the Sep 2026 BPI QR receipt layout", () => {
  if (!isBpiReceipt(currentQrSample)) {
    throw new Error("Current BPI QR receipt was not recognized");
  }
  if (!hasSuccessfulBpiTransfer(currentQrSample)) {
    throw new Error("Current BPI QR success evidence was not recognized");
  }
  if (!hasGcashGxiDestination(currentQrSample)) {
    throw new Error("Current GCash/G-Xchange destination was not recognized");
  }
  if (
    extractBpiConfirmationNo(currentQrSample, "1626016391287") !==
      "1626016391287"
  ) {
    throw new Error("Current BPI confirmation number was not extracted");
  }
  if (extractBpiTransactionRefNo(currentQrSample) !== "250735") {
    throw new Error("Current BPI transaction reference was not extracted");
  }
  if (
    checkBpiReceiverNumber(currentQrSample, "0917 000 0000", {
      expectedQrRecipientName: "Korte DOS",
    }) !== "match"
  ) {
    throw new Error("Current BPI QR recipient block was not accepted");
  }
});
