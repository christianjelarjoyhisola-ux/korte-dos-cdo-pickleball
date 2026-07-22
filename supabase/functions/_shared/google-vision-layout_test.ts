import { reconstructGoogleVisionRows } from "./google-vision-layout.ts";
import {
  extractMariBankDestinationAccount,
  extractMariBankReference,
  extractMariBankTotalAmount,
  extractMariBankTransferAmount,
  extractMariBankTransferFee,
  hasSuccessfulMariBankTransfer,
  parseMariBankDateTime,
} from "./maribank-receipt.ts";

type TestWord = Record<string, unknown>;

function visionWord(text: string, left: number, top: number): TestWord {
  const width = Math.max(12, text.length * 9);
  const height = 22;
  return {
    symbols: [...text].map((character) => ({ text: character })),
    boundingBox: {
      vertices: [
        { x: left, y: top },
        { x: left + width, y: top },
        { x: left + width, y: top + height },
        { x: left, y: top + height },
      ],
    },
  };
}

function wordsAt(text: string, left: number, top: number): TestWord[] {
  let x = left;
  return text.split(/\s+/).map((part) => {
    const word = visionWord(part, x, top);
    x += Math.max(12, part.length * 9) + 8;
    return word;
  });
}

function paragraph(text: string, left: number, top: number) {
  return { words: wordsAt(text, left, top) };
}

Deno.test("reconstructs two-column receipt fields in visual row order", () => {
  // Blocks deliberately arrive column-first, matching the problematic Google
  // raw-text ordering: all labels, then all right-aligned values.
  const annotation = {
    pages: [{
      width: 1200,
      height: 1600,
      blocks: [
        {
          paragraphs: [
            paragraph("MariBank", 400, 40),
            paragraph("Transaction Receipt", 360, 75),
            paragraph("To", 40, 120),
            paragraph("G-Xchange / GCash", 600, 150),
            paragraph("Acct No.:", 600, 180),
            paragraph("Transfer Amount", 40, 240),
            paragraph("Transfer Fee", 40, 280),
            paragraph("Total Amount", 40, 320),
            paragraph("Reference Number", 40, 360),
            paragraph("Transfer Method", 40, 400),
            paragraph("Processing Time", 40, 440),
            paragraph("Transaction Date & Time", 40, 480),
          ],
        },
        {
          paragraphs: [
            paragraph("Korte Dos", 760, 120),
            paragraph("DWQM4TK496R3UA1BS", 780, 180),
            paragraph("PHP 720.00", 820, 240),
            paragraph("FREE", 900, 280),
            paragraph("PHP 720.00", 820, 320),
            paragraph("693634", 900, 360),
            paragraph("InstaPay", 880, 400),
            paragraph("Realtime", 880, 440),
            paragraph("22 Jul 2026, 23:54", 730, 480),
          ],
        },
      ],
    }],
  };

  const reconstructed = reconstructGoogleVisionRows(annotation);
  if (!reconstructed) throw new Error("Expected reconstructed layout text");
  for (
    const expected of [
      "To Korte Dos",
      "Acct No.: DWQM4TK496R3UA1BS",
      "Transfer Amount PHP 720.00",
      "Transfer Fee FREE",
      "Total Amount PHP 720.00",
      "Reference Number 693634",
      "Transfer Method InstaPay",
      "Processing Time Realtime",
      "Transaction Date & Time 22 Jul 2026, 23:54",
    ]
  ) {
    if (!reconstructed.includes(expected)) {
      throw new Error(
        `Missing reconstructed row: ${expected}\n${reconstructed}`,
      );
    }
  }

  if (extractMariBankReference(reconstructed, "693634") !== "693634") {
    throw new Error("MariBank reference was not recoverable from layout text");
  }
  if (extractMariBankTransferAmount(reconstructed) !== 720) {
    throw new Error("MariBank amount was not recoverable from layout text");
  }
  if (extractMariBankTransferFee(reconstructed) !== 0) {
    throw new Error("MariBank fee was not recoverable from layout text");
  }
  if (extractMariBankTotalAmount(reconstructed) !== 720) {
    throw new Error("MariBank total was not recoverable from layout text");
  }
  if (
    extractMariBankDestinationAccount(reconstructed) !==
      "DWQM4TK496R3UA1BS"
  ) {
    throw new Error(
      "MariBank destination was not recoverable from layout text",
    );
  }
  const parsed = parseMariBankDateTime(reconstructed);
  if (parsed.shifted?.toISOString() !== "2026-07-22T23:54:00.000Z") {
    throw new Error(`Unexpected reconstructed time: ${parsed.shifted}`);
  }
  if (!hasSuccessfulMariBankTransfer(reconstructed)) {
    throw new Error("MariBank completion markers were not reconstructed");
  }
});

Deno.test("returns null even at 80% coverage so no raw word is discarded", () => {
  const annotation = {
    pages: [{
      blocks: [{
        paragraphs: [{
          words: [
            visionWord("Reference", 20, 20),
            visionWord("Number", 150, 20),
            visionWord("693634", 700, 20),
            visionWord("Realtime", 700, 60),
            {
              symbols: [..."Pending"].map((character) => ({ text: character })),
            },
          ],
        }],
      }],
    }],
  };
  if (reconstructGoogleVisionRows(annotation) !== null) {
    throw new Error("80% geometry must fall back to complete raw OCR text");
  }
});

Deno.test("supports normalized word vertices", () => {
  const normalizedWord = (text: string, left: number) => ({
    text,
    boundingBox: {
      normalizedVertices: [
        { x: left, y: 0.25 },
        { x: left + 0.1, y: 0.25 },
        { x: left + 0.1, y: 0.3 },
        { x: left, y: 0.3 },
      ],
    },
  });
  const annotation = {
    pages: [{
      width: 1000,
      height: 1000,
      blocks: [{
        paragraphs: [{
          words: [
            normalizedWord("Reference", 0),
            normalizedWord("693634", 0.75),
          ],
        }],
      }],
    }],
  };
  const reconstructed = reconstructGoogleVisionRows(annotation);
  if (reconstructed !== "Reference 693634") {
    throw new Error(`Unexpected normalized layout: ${reconstructed}`);
  }
});
