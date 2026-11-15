import { describe, expect, it } from "vitest";
import { page, type TestCell } from "../../test/statementRuns";
import { fileKind, inPageOrder } from "./files";
import type { TextRun } from "./layout";
import { type OcrLineIn, ocrPageRuns } from "./ocr";
import { readStatement } from "./read";

/** A made-up statement, as a PDF would give it. */
const STATEMENT: TestCell[][] = [
  [[40, "Example Bank"]],
  [
    [40, "Everyday account"],
    [200, "12-3456-0123456-00"],
  ],
  [[40, "Statement period 1 March 2026 to 31 March 2026"]],
  [
    [40, "Date"],
    [110, "Transaction details"],
    [380, "Withdrawals", "right"],
    [450, "Deposits", "right"],
    [530, "Balance", "right"],
  ],
  [
    [40, "1 Mar"],
    [110, "Opening balance"],
    [530, "1,000.00", "right"],
  ],
  [
    [40, "3 Mar"],
    [110, "COFFEE CART WELLINGTON"],
    [380, "4.50", "right"],
    [530, "995.50", "right"],
  ],
  [
    [40, "5 Mar"],
    [110, "SALARY ACME LTD"],
    [450, "350.00", "right"],
    [530, "1,345.50", "right"],
  ],
  [
    [40, "9 Mar"],
    [110, "POWER COMPANY DIRECT DEBIT"],
    [380, "120.00", "right"],
    [530, "1,225.50", "right"],
  ],
];

/**
 * What Tesseract would find in a photo of that page: four pixels to the point, tilted so the right
 * of the page sits `slope` lower, and each cell found as a line of its own (as when it reads a
 * table's columns as separate blocks).
 */
function photographed(runs: readonly TextRun[], slope: number): OcrLineIn[] {
  const px = 4;
  const at = (x: number, y: number) => ({ x: x * px, y: y * px + slope * x * px });
  return runs.map((run) => {
    const charWidth = run.width / run.text.length;
    const words = [...run.text.matchAll(/\S+/g)].map((m) => {
      const x0 = run.x + m.index * charWidth;
      const x1 = x0 + m[0].length * charWidth;
      const top = at(x0, run.y - 0.7 * run.size);
      const bottom = at(x1, run.y + 0.15 * run.size);
      return { text: m[0], confidence: 90, bbox: { x0: top.x, y0: top.y, x1: bottom.x, y1: bottom.y } };
    });
    const start = at(run.x, run.y);
    const end = at(run.x + run.width, run.y);
    return {
      bbox: {
        x0: start.x,
        y0: start.y - 0.7 * run.size * px,
        x1: end.x,
        y1: end.y + 0.15 * run.size * px,
      },
      baseline: { x0: start.x, y0: start.y, x1: end.x, y1: end.y, has_baseline: true },
      words,
    };
  });
}

const summary = (runs: TextRun[]) => {
  const read = readStatement(runs, { fallbackYear: 2026 });
  return {
    account: read.account,
    period: [read.periodStart, read.periodEnd],
    opening: read.opening?.amount,
    closing: read.closing?.amount,
    lines: read.lines.map((l) => [l.date, l.description, l.amount, l.balance, l.balanceOff]),
  };
};

describe("ocrPageRuns", () => {
  it("reads a tilted photo of a statement the same as the PDF", () => {
    const pdf = page(1, STATEMENT);
    const fromPdf = summary(pdf);
    expect(fromPdf.lines).toEqual([
      ["2026-03-03", "COFFEE CART WELLINGTON", -450, 99550, undefined],
      ["2026-03-05", "SALARY ACME LTD", 35000, 134550, undefined],
      ["2026-03-09", "POWER COMPANY DIRECT DEBIT", -12000, 122550, undefined],
    ]);
    // Tilted enough that the right of a row sits most of a row lower than its left.
    expect(summary(ocrPageRuns(photographed(pdf, 0.02), 1))).toEqual(fromPdf);
    expect(summary(ocrPageRuns(photographed(pdf, -0.015), 1))).toEqual(fromPdf);
  });

  it("leaves out table rules and smudges, and copes without baselines", () => {
    const lines = photographed(page(1, STATEMENT), 0);
    lines.push({
      bbox: { x0: 10, y0: 10, x1: 20, y1: 400 },
      words: [
        { text: "|", confidence: 80, bbox: { x0: 10, y0: 10, x1: 20, y1: 400 } },
        { text: "~,", confidence: 10, bbox: { x0: 30, y0: 10, x1: 40, y1: 40 } },
      ],
    });
    for (const l of lines) delete l.baseline;
    const runs = ocrPageRuns(lines, 2);
    expect(runs.some((r) => r.text === "|" || r.text === "~,")).toBe(false);
    expect(runs.every((r) => r.page === 2)).toBe(true);
    expect(summary(runs).lines).toHaveLength(3);
  });

  it("gives nothing for a page with no words", () => {
    expect(ocrPageRuns([], 1)).toEqual([]);
  });
});

describe("fileKind and inPageOrder", () => {
  const bytes = (...b: (number | string)[]) =>
    new Uint8Array(b.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));

  it("knows PDFs, pictures and bank files by their first bytes", () => {
    expect(fileKind(bytes("%PDF-1.7"), "statement.png")).toBe("pdf");
    expect(fileKind(bytes(0x89, "PNG", 0x0d, 0x0a), "page.pdf")).toBe("picture");
    expect(fileKind(bytes(0xff, 0xd8, 0xff, 0xe0), "IMG_0001.JPG")).toBe("picture");
    expect(fileKind(bytes("RIFF", 0, 0, 0, 0, "WEBP"), "page.webp")).toBe("picture");
    expect(fileKind(bytes(0, 0, 0, 0x18, "ftypheic"), "IMG_0002.HEIC")).toBe("picture");
    expect(fileKind(bytes("OFXHEADER:100"), "march.ofx")).toBe("bankFile");
    expect(fileKind(bytes("hello"), "notes.txt")).toBe("other");
  });

  it("puts pages in order by name, numbers and all", () => {
    const names = ["Page 10.png", "page 2.png", "page 1.png", "IMG_0009.jpg"].map((name) => ({ name }));
    expect(inPageOrder(names).map((f) => f.name)).toEqual(["IMG_0009.jpg", "page 1.png", "page 2.png", "Page 10.png"]);
  });
});
