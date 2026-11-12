/**
 * The text a PDF draws, and where, read with pdf.js in the browser. Nothing is uploaded: the file
 * is read on this device, and pdf.js is only loaded when someone drops a PDF in.
 */
import type * as PdfJs from "pdfjs-dist";
import type { TextRun } from "./layout";

type PdfJsModule = Pick<typeof PdfJs, "getDocument" | "Util">;

/** Why a PDF couldn't be read, worded for the person who dropped it in. */
export class PdfReadError extends Error {
  constructor(message: string, readonly reason: "password" | "invalid" | "other") {
    super(message);
    this.name = "PdfReadError";
  }
}

/** pdf.js for the browser, with its worker served beside the app. Loaded once, on first use. */
let browserPdfJs: Promise<PdfJsModule> | null = null;
function loadBrowserPdfJs(): Promise<PdfJsModule> {
  browserPdfJs ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    },
  );
  return browserPdfJs;
}

/** Whether the bytes start like a PDF (`%PDF-`), allowing for a little junk before it, as the format does. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

/**
 * Every run of text on every page, with its position in points from the page's top left. Text
 * drawn at an angle (a watermark, a sideways margin note) is left out: it isn't part of the table.
 */
export async function pdfTextRuns(data: Uint8Array, pdfjs?: PdfJsModule): Promise<TextRun[]> {
  const lib = pdfjs ?? (await loadBrowserPdfJs());
  // pdf.js takes ownership of the buffer it's given, so it gets a copy.
  const task = lib.getDocument({ data: data.slice(), verbosity: 0 });
  let doc: PdfJs.PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy();
    const name = e instanceof Error ? e.name : "";
    if (name === "PasswordException") {
      throw new PdfReadError(
        "This PDF is locked with a password. Open it, print it to a new PDF (Save as PDF), and drop that in instead.",
        "password",
      );
    }
    if (name === "InvalidPDFException") {
      throw new PdfReadError("This file isn't a PDF we can open: it may be damaged, or not really a PDF.", "invalid");
    }
    throw new PdfReadError(`We couldn't open this PDF: ${e instanceof Error ? e.message : String(e)}`, "other");
  }
  try {
    const runs: TextRun[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        // Into the page's own coordinates: y runs down from the top, and a rotated page is turned upright.
        const [a, b, c, d, x, y] = lib.Util.transform(viewport.transform, item.transform) as number[];
        if (a! <= 0 || Math.abs(b!) > 0.01 * Math.abs(a!)) continue;
        const size = Math.hypot(c!, d!);
        if (!(size > 0)) continue;
        runs.push({ page: n, x: x!, y: y!, width: item.width * viewport.scale, size, text: item.str });
      }
      page.cleanup();
    }
    return runs;
  } finally {
    // Ends the worker's copy of the document too.
    await task.destroy();
  }
}
