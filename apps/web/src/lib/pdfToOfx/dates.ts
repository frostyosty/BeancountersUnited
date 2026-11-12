import { addDays, daysInMonth, isoOf, partsOf } from "../dates";

/**
 * A date as a statement prints it, read from the words of a line. The year may be missing
 * (`12 Mar`), and a numeric date (`03/04/2026`) may be day-first or month-first: the reader settles
 * both once it has seen the whole statement.
 */
export interface DateWords {
  /** How many words the date takes up. */
  words: number;
  /** The two leading numbers for a numeric date, as printed; a named month is never ambiguous. */
  numeric: { first: number; second: number } | null;
  day: number;
  month: number;
  year: number | null;
  /**
   * The year was a separate two-digit word (`12 Mar 26`). That could as well be the start of the
   * description (`12 Mar 24 HOUR PHARMACY`), so the reader keeps it only when it fits the statement.
   */
  shortYear?: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const FULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** 1–12 for a month name (`Mar`, `MARCH`, `Sept.`), or 0. */
export function monthNumber(word: string): number {
  const w = word.toLowerCase().replace(/[.,]$/, "");
  const short = MONTHS.indexOf(w);
  if (short >= 0) return short + 1;
  if (w === "sept") return 9;
  return FULL.indexOf(w) + 1;
}

function year(text: string): number {
  const n = Number(text);
  return text.length === 2 ? (n < 70 ? 2000 + n : 1900 + n) : n;
}

function dayOf(word: string): number | null {
  const m = /^(\d{1,2})(?:st|nd|rd|th)?,?$/i.exec(word);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 31 ? n : null;
}

function yearOf(word: string | undefined): { year: number; short: boolean } | null {
  const m = word ? /^(\d{4}|'?\d{2}),?$/.exec(word) : null;
  if (!m) return null;
  const digits = m[1]!.replace("'", "");
  return { year: year(digits), short: digits.length === 2 };
}

function withYear(words: number, day: number, month: number, y: { year: number; short: boolean } | null): DateWords {
  if (!y) return { words, numeric: null, day, month, year: null };
  const date: DateWords = { words: words + 1, numeric: null, day, month, year: y.year };
  if (y.short) date.shortYear = true;
  return date;
}

/** A date in one word: `2026-03-12`, `12/03/2026`, `12.03.26`, `12/03`, `12-Mar-2026`, `12MAR26`, `12Mar`. */
function oneWord(word: string): DateWords | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(word);
  if (m) return { words: 1, numeric: null, year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  m = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/.exec(word);
  if (m) {
    const first = Number(m[1]);
    const second = Number(m[3]);
    return { words: 1, numeric: { first, second }, day: first, month: second, year: year(m[4]!) };
  }
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(word);
  if (m) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    return { words: 1, numeric: { first, second }, day: first, month: second, year: null };
  }
  m = /^(\d{1,2})[-\s]?([A-Za-z]{3,9})\.?(?:[-\s]?(\d{4}|\d{2}))?$/.exec(word);
  if (m) {
    const month = monthNumber(m[2]!);
    if (month) return { words: 1, numeric: null, day: Number(m[1]), month, year: m[3] ? year(m[3]) : null };
  }
  return null;
}

/**
 * The date that starts at `words[at]`, if one does: the longest reading wins, so `12 Mar 2026` is
 * one date of three words rather than `12 Mar` followed by a stray year. Day and month are checked
 * only loosely here (a day up to 31); the reader checks the whole date once it knows the year.
 */
export function readDateAt(words: readonly string[], at: number): DateWords | null {
  const [a, b, c] = [words[at], words[at + 1], words[at + 2]];
  if (a === undefined) return null;
  // 12 Mar 2026, 12 March, 2026, 12th Mar
  const day = dayOf(a);
  const monthAfter = b ? monthNumber(b) : 0;
  if (day && monthAfter) return withYear(2, day, monthAfter, yearOf(c));
  // Mar 12, 2026 or Mar 12
  const monthFirst = monthNumber(a);
  const dayAfter = b ? dayOf(b) : null;
  if (monthFirst && dayAfter) return withYear(2, dayAfter, monthFirst, yearOf(c));
  const single = oneWord(a);
  if (single && single.day >= 1 && single.day <= 31 && single.month >= 1 && single.month <= 31) {
    return single;
  }
  return null;
}

/** Day-first (as NZ prints dates) or month-first, for numeric dates. */
export type DateOrder = "dmy" | "mdy";

/**
 * Which way round the statement's numeric dates go. A first number over 12 proves day-first, a
 * second over 12 proves month-first; with no proof either way it's day-first.
 */
export function dateOrder(dates: Iterable<DateWords>): DateOrder {
  let monthFirst = false;
  for (const d of dates) {
    if (!d.numeric) continue;
    if (d.numeric.first > 12) return "dmy";
    if (d.numeric.second > 12) monthFirst = true;
  }
  return monthFirst ? "mdy" : "dmy";
}

/** The ISO date, or null when there's no such day. A missing year is chosen by `yearFor`. */
export function resolveDate(d: DateWords, order: DateOrder, yearFor: (month: number, day: number) => number): string | null {
  const [day, month] = d.numeric && order === "mdy" ? [d.numeric.second, d.numeric.first] : [d.day, d.month];
  if (month < 1 || month > 12 || day < 1) return null;
  const y = d.year ?? yearFor(month, day);
  if (y < 1900 || y > 2999 || day > daysInMonth(y, month)) return null;
  return isoOf(y, month, day);
}

/**
 * The year for a date printed without one, given the latest date the statement covers: the year
 * that puts it on or before that date (with a month's grace), so a December line on a statement
 * ending in January falls in the year before.
 */
export function yearBefore(latest: string): (month: number, day: number) => number {
  const { year } = partsOf(latest);
  const limit = addDays(latest, 31);
  return (month, day) => {
    const sameYear = isoOf(year, month, Math.min(day, daysInMonth(year, month)));
    return sameYear <= limit ? year : year - 1;
  };
}
