/**
 * A statement from a bank's CSV export, so PDF to OFX can turn it into OFX or QIF too. Every bank
 * names its columns its own way, so they're found by their headings: a date, an amount (or money in
 * and money out), a balance if there is one, and whatever describes the line.
 */
import { parseMoney, parseStatementAmount, sumCents } from "../money";
import { type DateWords, dateOrder, readDateAt, resolveDate, yearBefore } from "./dates";
import { nzAccount, type ReadLine, type ReadNote, type ReadOptions, type ReadStatement } from "./read";

/** Text from a file: UTF-8, or Windows' own encoding when it isn't (as older bank exports are). */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.replace(/^﻿/, "");
}

/** The fields of each record: commas (or tabs or semicolons, when that's what the file uses), with quotes. */
export function csvRecords(text: string): string[][] {
  const firstLines = text.split(/\r?\n/, 20).join("\n");
  const count = (c: string) => firstLines.split(c).length;
  const sep = count("\t") > count(",") ? "\t" : count(";") > count(",") ? ";" : ",";
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && field.trim() === "") {
      field = "";
      quoted = true;
    } else if (c === sep) {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.map((r) => r.map((f) => f.trim())).filter((r) => r.some((f) => f !== ""));
}

type Role = "date" | "amount" | "moneyOut" | "moneyIn" | "balance" | "description";

/** Headings, matched after lower-casing and squeezing spaces. The first role that matches wins. */
const HEADINGS: [Role, RegExp][] = [
  ["balance", /\bbalance\b/],
  ["date", /^(?:transaction |processed |posted |posting |value |effective )?date(?: (?:processed|posted))?$|^tran(?:saction)? date$/],
  ["moneyOut", /^(?:debits?|withdrawals?|money out|paid out|payments?|debit amount|amount debited|spent)$/],
  ["moneyIn", /^(?:credits?|deposits?|money in|paid in|receipts?|credit amount|amount credited|received)$/],
  ["amount", /^(?:amount|amount \(nzd\)|nzd amount|amount nzd|value|transaction amount)$/],
  [
    "description",
    /^(?:description|details|transaction details|narrative|payee|other party|merchant|merchant name|particulars|code|reference|memo|transaction type|tran type|type)$/,
  ],
];

interface Columns {
  date: number;
  amount: number | null;
  moneyOut: number | null;
  moneyIn: number | null;
  balance: number | null;
  description: number[];
}

/** Which column is which, from a heading row, or null when the row isn't one. */
function columnsOf(record: readonly string[]): Columns | null {
  const roles = record.map((h) => {
    const name = h.toLowerCase().replace(/\s+/g, " ").trim();
    return HEADINGS.find(([, r]) => r.test(name))?.[0] ?? null;
  });
  const first = (role: Role) => {
    const i = roles.indexOf(role);
    return i < 0 ? null : i;
  };
  const date = first("date");
  const amount = first("amount");
  const moneyOut = first("moneyOut");
  const moneyIn = first("moneyIn");
  if (date === null || (amount === null && moneyOut === null && moneyIn === null)) return null;
  const description = roles.flatMap((r, i) => (r === "description" ? [i] : []));
  return { date, amount, moneyOut, moneyIn, balance: first("balance"), description };
}

/** A CSV amount in signed cents: `-12.50`, `12.5`, `$1,200`, `(4.00)`, `45.00 DR`. Null for blank or not money. */
function amountOf(field: string | undefined): number | null {
  const text = (field ?? "").replace(/^NZ\$|^NZD\s?/i, "").trim();
  if (text === "") return null;
  const printed = parseStatementAmount(text);
  if (printed) return printed.sign === "minus" || printed.sign === "dr" ? -printed.cents : printed.cents;
  return parseMoney(text.replace(/^([-+]?)\$/, "$1").replace(/^\+/, ""));
}

const negate = (cents: number) => (cents === 0 ? 0 : -cents);

const NO_HEADINGS =
  "We couldn't find the column headings in this CSV: it needs a row naming a date column and an amount " +
  "column (or money in and money out columns).";

interface Row {
  dates: DateWords;
  description: string;
  amount: number;
  balance: number | null;
}

/** A statement from the text of a bank's CSV export. */
export function readCsvStatement(text: string, options: ReadOptions): ReadStatement {
  const records = csvRecords(text);
  const at = records.findIndex((r, i) => i < 30 && columnsOf(r) !== null);
  const empty = (note: string): ReadStatement => ({
    hasText: true,
    kind: "bank",
    account: null,
    savings: false,
    periodStart: null,
    periodEnd: null,
    opening: null,
    closing: null,
    lines: [],
    assumedYear: null,
    notes: [{ tone: "warn", text: note }],
  });
  if (at < 0) return empty(NO_HEADINGS);
  const cols = columnsOf(records[at]!)!;
  // Banks put the account number in a line or two above the headings, or in a column of its own.
  const preamble = records.slice(0, at).flat().join(" ");
  const accountColumn = records[at]!.findIndex((h) => /^account(?: number| no\.?)?$/i.test(h.trim()));
  const account =
    nzAccount(preamble) ??
    (accountColumn >= 0 ? nzAccount(records[at + 1]?.[accountColumn]?.replace(/\s+/g, "-") ?? "") : null);

  const rows: Row[] = [];
  let undated = 0;
  for (const r of records.slice(at + 1)) {
    const dates = readDateAt((r[cols.date] ?? "").split(/\s+/), 0);
    let amount = cols.amount !== null ? amountOf(r[cols.amount]) : null;
    if (amount === null && (cols.moneyIn !== null || cols.moneyOut !== null)) {
      const moneyIn = cols.moneyIn !== null ? amountOf(r[cols.moneyIn]) : null;
      const moneyOut = cols.moneyOut !== null ? amountOf(r[cols.moneyOut]) : null;
      if (moneyIn !== null || moneyOut !== null) {
        amount = sumCents([Math.abs(moneyIn ?? 0), negate(Math.abs(moneyOut ?? 0))]);
      }
    }
    if (amount === null) continue; // a blank row, a total, or a note under the table
    if (!dates) {
      undated++;
      continue;
    }
    const seen = new Set<string>();
    const description = cols.description
      .map((i) => (r[i] ?? "").replace(/\s+/g, " ").trim())
      .filter((d) => d !== "" && !seen.has(d.toLowerCase()) && seen.add(d.toLowerCase()))
      .join(" ");
    rows.push({ dates, description, amount, balance: cols.balance !== null ? amountOf(r[cols.balance]) : null });
  }
  if (rows.length === 0) return empty("We found the column headings in this CSV, but no lines with a date and an amount under them.");

  const order = dateOrder(rows.map((r) => r.dates));
  const fullYears = rows.flatMap((r) => (r.dates.year === null ? [] : [r.dates]));
  const yearless = rows.some((r) => r.dates.year === null);
  const latest = fullYears
    .map((d) => resolveDate(d, order, () => options.fallbackYear))
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  const yearFor = latest ? yearBefore(latest) : () => options.fallbackYear;
  let lines: ReadLine[] = [];
  let badDates = 0;
  for (const r of rows) {
    const date = resolveDate(r.dates, order, yearFor);
    if (!date) {
      badDates++;
      continue;
    }
    lines.push({ page: 1, date, description: r.description, amount: r.amount, balance: r.balance });
  }
  // Newest first, as many exports are: turn it round (which puts each day's lines in order too).
  if (lines.length > 1 && lines[0]!.date > lines.at(-1)!.date) lines = lines.reverse();

  for (let i = 1; i < lines.length; i++) {
    const before = lines[i - 1]!.balance;
    const line = lines[i]!;
    if (before === null || line.balance === null) continue;
    const off = line.balance - sumCents([before, line.amount]);
    if (off !== 0) line.balanceOff = off;
  }

  const notes: ReadNote[] = [];
  const skipped = undated + badDates;
  if (skipped > 0) {
    notes.push({
      tone: "warn",
      text: `${skipped} ${skipped === 1 ? "line has" : "lines have"} an amount but no date we could read, so ${skipped === 1 ? "it's" : "they're"} left out.`,
    });
  }
  if (yearless && !latest) {
    notes.push({ tone: "warn", text: "This CSV doesn't say which year its dates are in: check the year below." });
  }
  const dates = lines.map((l) => l.date).sort();
  const first = lines[0];
  const last = lines.at(-1);
  return {
    hasText: true,
    kind: "bank",
    account,
    savings: false,
    periodStart: dates[0] ?? null,
    periodEnd: dates.at(-1) ?? null,
    opening: first && first.balance !== null ? { amount: sumCents([first.balance, negate(first.amount)]), printed: false } : null,
    closing: last && last.balance !== null ? { amount: last.balance, printed: false } : null,
    lines,
    assumedYear: yearless && !latest ? options.fallbackYear : null,
    notes,
  };
}
