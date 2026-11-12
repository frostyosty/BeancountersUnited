/**
 * Builds the text runs a PDF would give for a made-up statement, for tests. Everything here is
 * synthetic (hard rule 1).
 */
import type { TextRun } from "../lib/pdfToOfx/layout";

/** A cell: its text, and where it starts, or where it ends for right-aligned money (`right: true`). */
export type TestCell = [x: number, text: string, right?: "right"];

/** How wide a character is drawn, in ems: about right for a sans serif font. */
const CHAR = 0.5;

/** One line of cells at baseline `y` on `page`, each cell drawn as a single run. */
export function row(page: number, y: number, cells: readonly TestCell[], size = 9): TextRun[] {
  return cells.map(([x, text, right]) => {
    const width = text.length * CHAR * size;
    return { page, x: right ? x - width : x, y, width, size, text };
  });
}

/** Lines on one page, 14 points apart from `top`. */
export function page(n: number, lines: readonly (readonly TestCell[])[], top = 80): TextRun[] {
  return lines.flatMap((cells, i) => row(n, top + i * 14, cells));
}
