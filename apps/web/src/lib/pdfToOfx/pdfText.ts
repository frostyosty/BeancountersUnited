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
 * Where pdf.js fetches the WebAssembly decoders for a scan's pictures (vite.ocr.ts serves them).
 * Without them, black-and-white (CCITT fax, JBIG2) and JPEG 2000 scans draw as blank pages.
 */
function browserWasmUrl(): string {
  return new URL(`${__PDFJS_WASM_PATH__}/`, window.location.href).href;
}

/** Opens a PDF, with errors worded for the person who dropped it in. Destroy the task when done. */
async function openPdf(
  lib: PdfJsModule,
  data: Uint8Array,
  wasmUrl?: string,
): Promise<{ task: PdfJs.PDFDocumentLoadingTask; doc: PdfJs.PDFDocumentProxy }> {
  // pdf.js takes ownership of the buffer it's given, so it gets a copy.
  const task = lib.getDocument({ data: data.slice(), verbosity: 0, ...(wasmUrl ? { wasmUrl } : {}) });
  try {
    return { task, doc: await task.promise };
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
}

/**
 * Every run of text on every page, with its position in points from the page's top left. Text
 * drawn at an angle (a watermark, a sideways margin note) is left out: it isn't part of the table.
 */
export async function pdfTextRuns(data: Uint8Array, pdfjs?: PdfJsModule): Promise<TextRun[]> {
  const lib = pdfjs ?? (await loadBrowserPdfJs());
  const { task, doc } = await openPdf(lib, data, pdfjs ? undefined : browserWasmUrl());
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

/** The most pages of a scan that get read: a statement longer than this isn't one person's month. */
export const MAX_SCAN_PAGES = 20;

/**
 * Each page drawn as a picture, for reading a scan with OCR: at three times the PDF's size (about
 * 216 dots per inch), which is sharp enough for OCR without being slow. Browser only.
 */
export async function pdfPagePictures(data: Uint8Array, toBlob: (canvas: HTMLCanvasElement) => Promise<Blob>): Promise<Blob[]> {
  const lib = await loadBrowserPdfJs();
  const { task, doc } = await openPdf(lib, data, browserWasmUrl());
  try {
    if (doc.numPages > MAX_SCAN_PAGES) {
      throw new PdfReadError(
        `This scan has ${doc.numPages} pages, more than the ${MAX_SCAN_PAGES} we read. Split it into shorter PDFs and convert each one.`,
        "other",
      );
    }
    const pictures: Blob[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 3 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      pictures.push(await toBlob(canvas));
      page.cleanup();
    }
    return pictures;
  } finally {
    await task.destroy();
  }
}
