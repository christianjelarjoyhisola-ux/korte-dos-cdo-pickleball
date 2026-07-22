type VisionRecord = Record<string, unknown>;

type PositionedWord = {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerY: number;
  height: number;
};

type VisualRow = {
  words: PositionedWord[];
  centerY: number;
  height: number;
};

const MAX_LAYOUT_WORDS = 5000;
// Dropping even one unpositioned word could hide a negative status such as
// "Pending". Fall back to Google's raw text unless every recognized word can
// be placed, preserving the verifier's fail-safe behavior.
const REQUIRED_POSITIONED_WORD_RATIO = 1;

function asRecord(value: unknown): VisionRecord | null {
  return value && typeof value === "object" ? value as VisionRecord : null;
}

function records(value: unknown): VisionRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is VisionRecord => !!item)
    : [];
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function textForWord(word: VisionRecord): string {
  const symbols = records(word.symbols);
  if (symbols.length) {
    return symbols.map((symbol) => String(symbol.text || "")).join("").trim();
  }
  return typeof word.text === "string" ? word.text.trim() : "";
}

function positionedWord(
  word: VisionRecord,
  text: string,
  pageWidth: number,
  pageHeight: number,
): PositionedWord | null {
  const box = asRecord(word.boundingBox || word.boundingPoly);
  if (!box) return null;

  let vertices = records(box.vertices);
  let normalized = false;
  if (vertices.length < 2) {
    vertices = records(box.normalizedVertices);
    normalized = vertices.length >= 2;
  }
  if (vertices.length < 2) return null;

  const xs = vertices.map((vertex) => {
    const coordinate = finiteNumber(vertex.x);
    return normalized && pageWidth > 0 ? coordinate * pageWidth : coordinate;
  });
  const ys = vertices.map((vertex) => {
    const coordinate = finiteNumber(vertex.y);
    return normalized && pageHeight > 0 ? coordinate * pageHeight : coordinate;
  });
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  if (
    ![left, right, top, bottom].every(Number.isFinite) || right <= left ||
    bottom <= top
  ) return null;

  return {
    text,
    left,
    right,
    top,
    bottom,
    centerY: (top + bottom) / 2,
    height: bottom - top,
  };
}

function updateRowMetrics(row: VisualRow): void {
  row.centerY = median(row.words.map((word) => word.centerY));
  row.height = median(row.words.map((word) => word.height));
}

function rowMatchScore(row: VisualRow, word: PositionedWord): number | null {
  const rowTop = row.centerY - row.height / 2;
  const rowBottom = row.centerY + row.height / 2;
  const overlap = Math.max(
    0,
    Math.min(rowBottom, word.bottom) - Math.max(rowTop, word.top),
  );
  const smallerHeight = Math.max(1, Math.min(row.height, word.height));
  const overlapRatio = overlap / smallerHeight;
  const centerDistance = Math.abs(row.centerY - word.centerY);
  const centerTolerance = Math.max(2, smallerHeight * 0.65);

  if (overlapRatio < 0.25 && centerDistance > centerTolerance) return null;
  return centerDistance / smallerHeight - overlapRatio;
}

function reconstructPage(words: PositionedWord[]): string {
  const ordered = [...words].sort((a, b) =>
    a.centerY - b.centerY || a.left - b.left
  );
  const rows: VisualRow[] = [];

  for (const word of ordered) {
    let bestRow: VisualRow | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      const distanceBelow = word.centerY - row.centerY;
      if (distanceBelow > Math.max(word.height, row.height) * 2 + 8) break;
      const score = rowMatchScore(row, word);
      if (score != null && score < bestScore) {
        bestRow = row;
        bestScore = score;
      }
    }

    if (bestRow) {
      bestRow.words.push(word);
      updateRowMetrics(bestRow);
    } else {
      rows.push({ words: [word], centerY: word.centerY, height: word.height });
    }
  }

  return rows
    .sort((a, b) => a.centerY - b.centerY)
    .map((row) =>
      row.words
        .sort((a, b) => a.left - b.left || a.right - b.right)
        .map((word) => word.text)
        .join(" ")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Rebuild Google Vision DOCUMENT_TEXT_DETECTION output in visual row order.
 *
 * Vision's `fullTextAnnotation.text` can follow block/column order. On a receipt
 * that often separates a left-hand label from its right-hand value, even though
 * they occupy the same visual row. This helper uses only recognized words and
 * their bounding boxes; it never invents OCR content. Unless 100% of non-empty
 * recognized words have usable geometry, it returns null so callers retain the
 * complete raw text, including any unpositioned failure/status marker.
 */
export function reconstructGoogleVisionRows(
  annotation: unknown,
): string | null {
  const root = asRecord(annotation);
  if (!root) return null;

  const pages = records(root.pages);
  if (!pages.length) return null;

  let seenWords = 0;
  let positionedWords = 0;
  const pageWords: PositionedWord[][] = [];

  for (const page of pages) {
    const width = finiteNumber(page.width);
    const height = finiteNumber(page.height);
    const wordsForPage: PositionedWord[] = [];
    for (const block of records(page.blocks)) {
      for (const paragraph of records(block.paragraphs)) {
        for (const word of records(paragraph.words)) {
          const text = textForWord(word);
          if (!text) continue;
          seenWords++;
          if (seenWords > MAX_LAYOUT_WORDS) return null;
          const positioned = positionedWord(word, text, width, height);
          if (!positioned) continue;
          positionedWords++;
          wordsForPage.push(positioned);
        }
      }
    }
    pageWords.push(wordsForPage);
  }

  if (
    positionedWords < 2 || seenWords === 0 ||
    positionedWords / seenWords < REQUIRED_POSITIONED_WORD_RATIO
  ) return null;

  const text = pageWords
    .map(reconstructPage)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || null;
}
