/**
 * Turns the text on a PDF's pages into lines of words, each word knowing where it sits across the
 * page. Bank statements are tables, so where a word sits says which column it's in.
 */

/** A run of text as the PDF draws it. Coordinates are points from the page's top left; `y` is the baseline. */
export interface TextRun {
  /** 1-based. */
  page: number;
  x: number;
  y: number;
  /** How wide the run is drawn. */
  width: number;
  /** The font size. */
  size: number;
  text: string;
}

/** A word, with the left and right edges it's drawn between. */
export interface Word {
  text: string;
  x0: number;
  x1: number;
}

/** Words close enough together to read as one phrase: one cell of the table. */
export interface Cell {
  text: string;
  x0: number;
  x1: number;
}

export interface Line {
  page: number;
  /** The baseline, from the top of the page. */
  y: number;
  /** The typical font size on the line. */
  size: number;
  words: Word[];
  cells: Cell[];
}

/** Words further apart than this (in ems) are in different cells. A space is about a third of an em. */
const CELL_GAP = 0.8;
/** Pieces closer than this (in ems) are one word: a PDF often draws a word in several runs. */
const SAME_WORD = 0.12;

interface Placed extends Word {
  size: number;
  run: number;
}

/**
 * A run's words, spread across its width in proportion to their characters. Two or more spaces in
 * a row are a column gap that some PDFs type out, so they're kept as a gap.
 */
function wordsOf(run: TextRun, index: number): Placed[] {
  const text = run.text.replace(/\s/g, " ");
  if (text.trim() === "" || run.width <= 0) return [];
  const charWidth = run.width / text.length;
  const out: Placed[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const x0 = run.x + m.index * charWidth;
    out.push({ text: m[0], x0, x1: x0 + m[0].length * charWidth, size: run.size, run: index });
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Groups runs into lines, top to bottom and page by page, and each line's words into cells. */
export function buildLines(runs: readonly TextRun[]): Line[] {
  const usable = runs
    .map((run, index) => ({ run, index }))
    .filter(({ run }) => run.size > 0 && run.text.trim() !== "" && Number.isFinite(run.x + run.y + run.width));
  usable.sort((a, b) => a.run.page - b.run.page || a.run.y - b.run.y || a.run.x - b.run.x);

  // Runs whose baselines are within half a font size of the line's first run share its line.
  const groups: { page: number; y: number; size: number; runs: { run: TextRun; index: number }[] }[] = [];
  for (const item of usable) {
    const last = groups.at(-1);
    if (last && last.page === item.run.page && Math.abs(item.run.y - last.y) <= 0.5 * Math.min(last.size, item.run.size)) {
      last.runs.push(item);
    } else {
      groups.push({ page: item.run.page, y: item.run.y, size: item.run.size, runs: [item] });
    }
  }

  return groups.map((g) => {
    const placed = g.runs.flatMap(({ run, index }) => wordsOf(run, index)).sort((a, b) => a.x0 - b.x0);
    const size = median(placed.map((w) => w.size)) || g.size;
    const words: Placed[] = [];
    for (const w of placed) {
      const prev = words.at(-1);
      if (prev && prev.run !== w.run && w.x0 - prev.x1 < SAME_WORD * size) {
        prev.text += w.text;
        prev.x1 = Math.max(prev.x1, w.x1);
        prev.run = w.run;
      } else {
        words.push({ ...w });
      }
    }
    const cells: Cell[] = [];
    let prev: Placed | undefined;
    for (const w of words) {
      const cell = cells.at(-1);
      if (cell && prev && w.x0 - prev.x1 <= CELL_GAP * size) {
        cell.text += ` ${w.text}`;
        cell.x1 = Math.max(cell.x1, w.x1);
      } else {
        cells.push({ text: w.text, x0: w.x0, x1: w.x1 });
      }
      prev = w;
    }
    return {
      page: g.page,
      y: median(g.runs.map(({ run }) => run.y)),
      size,
      words: words.map(({ text, x0, x1 }) => ({ text, x0, x1 })),
      cells,
    };
  });
}

/** The line as text, cells two spaces apart. */
export function lineText(line: Line): string {
  return line.cells.map((c) => c.text).join("  ");
}
