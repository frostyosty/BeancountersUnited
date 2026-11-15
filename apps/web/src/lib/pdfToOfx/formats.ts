/**
 * The files a read statement can be saved as: OFX (`ofx.ts`), QIF and CSV. Like the OFX writer,
 * these use only what's passed in, so the same statement always gives byte-identical files.
 */
import { formatPlainMoney } from "../money";
import { asciiText, buildOfx, type OfxLine, type OfxStatement, splitName } from "./ofx";

export type StatementFormat = "ofx" | "qif" | "csv";

export const STATEMENT_FORMATS: { value: StatementFormat; label: string; mime: string }[] = [
  { value: "ofx", label: "OFX: Xero, MYOB and most accounting software", mime: "application/x-ofx" },
  { value: "qif", label: "QIF: older software, such as Quicken", mime: "application/qif" },
  { value: "csv", label: "CSV: a spreadsheet", mime: "text/csv" },
];

/** A line with the running balance printed beside it, for the CSV. */
export interface StatementFileLine extends OfxLine {
  balance?: number | null;
}

export interface StatementFile extends OfxStatement {
  lines: readonly StatementFileLine[];
}

/** `dd/mm/yyyy`, as NZ software reads QIF and CSV dates. */
function dayFirst(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * QIF, as our own importer and most software read it: an `!Account` header naming the account,
 * then a `!Type:Bank` (or `!Type:CCard`) section with day-first dates. The description is split
 * as OFX splits it, the first 32 characters in `P` and the rest in `M`.
 */
export function buildQif(s: StatementFile): string {
  const account = asciiText(s.account);
  if (!account) throw new Error("A QIF file needs an account number.");
  const type = s.accountType === "card" ? "CCard" : "Bank";
  const out = ["!Account", `N${account}`, `T${type}`, "^", `!Type:${type}`];
  for (const l of s.lines) {
    const { name, memo } = splitName(l.description);
    out.push(`D${dayFirst(l.date)}`, `T${formatPlainMoney(l.amount)}`, `P${name}`);
    if (memo) out.push(`M${memo}`);
    out.push("^");
  }
  return `${out.join("\r\n")}\r\n`;
}

/** A CSV cell: quoted when it must be, and never read as a formula by a spreadsheet. */
function cell(text: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A plain CSV: `Date,Description,Amount,Balance`, day-first dates, money in positive. */
export function buildCsv(s: StatementFile): string {
  const rows = [["Date", "Description", "Amount", "Balance"].join(",")];
  for (const l of s.lines) {
    const balance = l.balance === null || l.balance === undefined ? "" : formatPlainMoney(l.balance);
    rows.push([dayFirst(l.date), cell(asciiText(l.description)), formatPlainMoney(l.amount), balance].join(","));
  }
  return `${rows.join("\r\n")}\r\n`;
}

export function buildStatementFile(format: StatementFormat, s: StatementFile): string {
  return format === "qif" ? buildQif(s) : format === "csv" ? buildCsv(s) : buildOfx(s);
}

/** A file name for the statement: `statement-12-3456-0123456-00-2026-03-31.qif`. */
export function statementFileName(account: string, periodEnd: string, format: StatementFormat): string {
  const safe = asciiText(account)
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `statement-${safe ? `${safe}-` : ""}${periodEnd}.${format}`;
}
