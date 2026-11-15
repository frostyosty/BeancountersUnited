/**
 * Text read off pictures of statements (photos, screenshots, scanned PDFs) with Tesseract, an OCR
 * engine that runs in the browser. Nothing is uploaded: the engine and its English data are served
 * beside the app (vite.ocr.ts), and only loaded when someone drops in a picture or a scan.
 *
 * Tesseract finds each word and the box around it. Those become the same text runs a PDF gives,
 * so the statement reader (`read.ts`) works the same way on both.
 */
import type { Block, Line as OcrLine, Worker } from "tesseract.js";
import type { TextRun } from "./layout";

/** Why a picture couldn't be read, worded for the person who dropped it in. */
export class PictureReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PictureReadError";
  }
}

/** The parts of Tesseract's lines that the runs are made from. */
export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface OcrWordIn {
  text: string;
  confidence: number;
  bbox: OcrBox;
}
export interface OcrLineIn {
  bbox: OcrBox;
  baseline?: OcrBox & { has_baseline?: boolean };
  words: OcrWordIn[];
}

/** Table rules and smudges that OCR reads as characters. */
const NOISE = /^[|¦_~=[\]{}<>«»•·]+$/;
/** A word that's only a number: an amount, a date, a reference. */
const FIGURES = /^[-+($]?\d[\d,./)-]*$/;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Where a line's baseline is at `x`, or null when Tesseract didn't find one. */
function baselineAt(line: OcrLineIn, x: number): number | null {
  const b = line.baseline;
  if (!b || b.has_baseline === false || !(b.x1 > b.x0)) return null;
  return b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0);
}

/**
 * One page's words as text runs, in the picture's pixels.
 *
 * - A photo is rarely square to the page, and the reader puts words on one line by how high they
 *   sit. So the page's slant (the usual slope of its baselines) is taken out of each word's height.
 * - Every run gets the page's usual text size, worked out from its line heights: the reader only
 *   compares positions with that size, and one size for a page keeps that steady.
 */
export function ocrPageRuns(lines: readonly OcrLineIn[], page: number): TextRun[] {
  const slopes = lines.flatMap((l) => {
    const b = l.baseline;
    return b && b.has_baseline !== false && b.x1 - b.x0 > 4 * (l.bbox.y1 - l.bbox.y0) ? [(b.y1 - b.y0) / (b.x1 - b.x0)] : [];
  });
  const slope = slopes.length > 0 ? median(slopes) : 0;
  // The type's size from how tall its numbers are: a figure stands about as tall as a capital,
  // some 72% of the size, plus however much the slant drops across it. Numbers are steadier than
  // whole lines, whose boxes take in any table rule touching them (and are then twice the height).
  const tilted = (b: OcrBox) => b.y1 - b.y0 - Math.abs(slope) * (b.x1 - b.x0);
  const figures = lines.flatMap((l) => l.words.filter((w) => FIGURES.test(w.text.trim())).map((w) => tilted(w.bbox)));
  // A line's box runs from the tops of its capitals to the tails of letters like g, about 85% of
  // the type's size: for a page with few numbers on it.
  const size =
    figures.length >= 5
      ? median(figures) / 0.72
      : median(lines.filter((l) => l.words.length > 0).map((l) => tilted(l.bbox))) / 0.85;
  if (!(size > 0)) return [];
  const runs: TextRun[] = [];
  for (const line of lines) {
    for (const w of line.words) {
      const text = w.text.trim();
      if (!text || NOISE.test(text) || (w.confidence < 20 && !/[\p{L}\p{N}]/u.test(text))) continue;
      const mid = (w.bbox.x0 + w.bbox.x1) / 2;
      const y = baselineAt(line, mid) ?? w.bbox.y1;
      runs.push({ page, x: w.bbox.x0, y: y - slope * mid, width: Math.max(1, w.bbox.x1 - w.bbox.x0), size, text });
    }
  }
  return runs;
}

/** Every line on a page of Tesseract's results. */
export function linesOf(blocks: readonly Block[] | null): OcrLine[] {
  return (blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
}

/**
 * The picture at a size Tesseract reads well: type about 30 pixels high. Screenshots are often
 * smaller than that, and phone photos far bigger (and slower to read) than they need to be. EXIF
 * rotation is applied, so a photo taken sideways is read upright.
 */
async function prepare(picture: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(picture, { imageOrientation: "from-image" });
  } catch {
    throw new PictureReadError(
      "This browser can't open this picture. iPhone photos (HEIC) often can't be opened outside Safari: take a screenshot of the photo, or save it as a JPEG or PNG, and drop that in.",
    );
  }
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    const scale = long < 2400 ? Math.min(4, 3200 / long) : long > 4800 ? 4800 / long : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PictureReadError("This browser can't draw the picture to read it.");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasBlob(canvas);
  } finally {
    bitmap.close();
  }
}

/** A canvas as a PNG. */
export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new PictureReadError("This browser couldn't copy the page to read it."))), "image/png"),
  );
}

export interface OcrProgress {
  /** 1-based. */
  page: number;
  pages: number;
  /** "loading" while the engine and its data load (only slow the first time), then "reading". */
  step: "loading" | "reading";
  /** How far through this page, 0 to 1. */
  done: number;
}

async function startWorker(onLog: (m: { status: string; progress: number }) => void): Promise<Worker> {
  const [{ createWorker, OEM, PSM }, worker] = await Promise.all([
    import("tesseract.js"),
    import("tesseract.js/dist/worker.min.js?url"),
  ]);
  const absolute = (path: string) => new URL(path, window.location.href).href;
  const w = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: absolute(worker.default),
    corePath: absolute(__OCR_CORE_PATH__),
    langPath: absolute(__OCR_LANG_PATH__),
    logger: onLog,
  });
  // Sparse text: every word on the page, wherever it is. Automatic layout guesses at blocks first,
  // and can drop a whole column of a table as a picture (a scanned printout lost every amount on a
  // page that way, and a minus here and there). Order doesn't matter: the reader puts words back
  // into rows by where they sit.
  await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  return w;
}

/**
 * Reads each picture as a page, in order, and returns their words as text runs. Pictures may be
 * photos or screenshots of the pages, or pages drawn from a scanned PDF.
 */
export async function ocrTextRuns(pictures: readonly Blob[], onProgress?: (p: OcrProgress) => void): Promise<TextRun[]> {
  let page = 1;
  const pages = pictures.length;
  const worker = await startWorker((m) => {
    const reading = m.status === "recognizing text";
    onProgress?.({ page, pages, step: reading ? "reading" : "loading", done: reading ? m.progress : 0 });
  });
  try {
    const runs: TextRun[] = [];
    for (; page <= pages; page++) {
      const picture = await prepare(pictures[page - 1]!);
      onProgress?.({ page, pages, step: "reading", done: 0 });
      const { data } = await worker.recognize(picture, {}, { blocks: true, text: false });
      runs.push(...ocrPageRuns(linesOf(data.blocks), page));
    }
    return runs;
  } finally {
    await worker.terminate();
  }
}
