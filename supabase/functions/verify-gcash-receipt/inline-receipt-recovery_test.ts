function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("inline receipt checkpoint is pending before image processing", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const flowStart = source.indexOf(
    "// Save the evidence before pricing, perceptual hashing, or OCR.",
  );
  assert(flowStart >= 0, "inline receipt flow marker is missing");
  const flow = source.slice(flowStart);
  const upload = flow.indexOf(
    'db.storage.from("receipts").upload',
  );
  const audit = flow.indexOf(
    "inlineRecoveryState.auditId = await ensureInlineReceiptAuditCheckpoint",
  );
  const pendingRegistration = flow.indexOf(
    "const checkpointPersistence = await persistPreparedInlineRegistration",
  );
  const perceptualHash = flow.indexOf("const phash = await dHash(bytes)");
  const ocr = flow.indexOf("const ocr = await runOCR");

  assert(upload >= 0, "receipt upload is missing");
  assert(audit > upload, "receipt audit must follow successful upload");
  assert(
    pendingRegistration > audit,
    "pending registration must follow its receipt audit",
  );
  assert(
    perceptualHash > pendingRegistration,
    "pending registration must exist before perceptual hashing",
  );
  assert(
    ocr > pendingRegistration,
    "pending registration must exist before OCR",
  );
  assert(
    flow.includes("{ notifyPending: false }"),
    "checkpoint must defer owner email until the final outcome",
  );
});

Deno.test("inline receipt failures route through durable recovery", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assert(
    source.includes("await recoverInlineReceiptAfterFailure("),
    "verify catch must invoke inline receipt recovery",
  );
  assert(
    source.includes('"VERIFICATION_PROCESSING_ERROR"'),
    "recovery audit must record a processing failure",
  );
  assert(
    source.includes("await deliverPaymentReviewNotification({"),
    "recovery must retain an owner-notification path",
  );
});
