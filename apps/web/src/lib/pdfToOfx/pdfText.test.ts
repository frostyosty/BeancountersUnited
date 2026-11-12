import { readFileSync } from "node:fs";
import { jsPDF } from "jspdf";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { buildOfx } from "./ofx";
import { looksLikePdf, PdfReadError, pdfTextRuns } from "./pdfText";
import { readStatement } from "./read";

/** A made-up statement drawn into a real PDF (hard rule 1: synthetic only). */
function statementPdf(): Uint8Array {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setFontSize(9);
  doc.text("Example Bank  Everyday account  12-3456-0123456-00", 40, 60);
  doc.text("Statement period 1 March 2026 to 31 March 2026", 40, 74);
  const rows: [string, string, string, string, string][] = [
    ["Date", "Transaction details", "Withdrawals", "Deposits", "Balance"],
    ["1 Mar", "Opening balance", "", "", "1,000.00"],
    ["3 Mar", "POS W/D COFFEE CART", "4.50", "", "995.50"],
    ["5 Mar", "SALARY ACME LTD", "", "2,000.00", "2,995.50"],
    ["31 Mar", "Closing balance", "", "", "2,995.50"],
  ];
  rows.forEach(([date, details, out, into, balance], i) => {
    const y = 110 + i * 14;
    doc.text(date, 40, y);
    doc.text(details, 110, y);
    if (out) doc.text(out, 380, y, { align: "right" });
    if (into) doc.text(into, 450, y, { align: "right" });
    if (balance) doc.text(balance, 530, y, { align: "right" });
  });
  return new Uint8Array(doc.output("arraybuffer"));
}

describe("pdfTextRuns", () => {
  it("reads a real PDF through to OFX", async () => {
    const bytes = statementPdf();
    expect(looksLikePdf(bytes)).toBe(true);
    const runs = await pdfTextRuns(bytes, pdfjs);
    expect(runs.length).toBeGreaterThan(10);
    const date = runs.find((r) => r.text === "3 Mar")!;
    expect(date.page).toBe(1);
    expect(date.x).toBeCloseTo(40, 0);
    expect(date.y).toBeCloseTo(138, 0);
    expect(date.size).toBeCloseTo(9, 1);

    const s = readStatement(runs, { fallbackYear: 2026 });
    expect(s.lines.map((l) => [l.date, l.description, l.amount, l.balance])).toEqual([
      ["2026-03-03", "POS W/D COFFEE CART", -450, 99550],
      ["2026-03-05", "SALARY ACME LTD", 200000, 299550],
    ]);
    const ofx = buildOfx({
      accountType: "cheque",
      account: s.account!,
      periodStart: s.periodStart!,
      periodEnd: s.periodEnd!,
      closing: s.closing!.amount,
      lines: s.lines,
    });
    expect(ofx).toContain("<ACCTID>12-3456-0123456-00</ACCTID>");
    expect(ofx).toContain("<TRNAMT>-4.50</TRNAMT>");
    expect(ofx).toContain("<BALAMT>2995.50</BALAMT>");
  });

  it("finds no text in a scan", async () => {
    // A synthetic scanned invoice from the invoice scanner's fixtures: an image, no text.
    const scan = new Uint8Array(
      readFileSync(new URL("../../../../../fixtures/invoices/scan-manuka-flate.pdf", import.meta.url)),
    );
    const s = readStatement(await pdfTextRuns(scan, pdfjs), { fallbackYear: 2026 });
    expect(s.hasText).toBe(false);
  });

  it("says when a file isn't a PDF", async () => {
    const fake = new Uint8Array(
      readFileSync(new URL("../../../../../fixtures/invoices/not-really-a-pdf.pdf", import.meta.url)),
    );
    await expect(pdfTextRuns(fake, pdfjs)).rejects.toBeInstanceOf(PdfReadError);
    const junk = new TextEncoder().encode("Date,Amount\n01/03/2026,4.50\n");
    expect(looksLikePdf(junk)).toBe(false);
    await expect(pdfTextRuns(junk, pdfjs)).rejects.toBeInstanceOf(PdfReadError);
  });
});
