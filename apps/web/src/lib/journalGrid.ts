import type { Account } from "@acct/types/Account";
import type { JournalError } from "@acct/types/JournalError";
import type { JournalLine } from "@acct/types/JournalLine";
import { parseMoney } from "./money";

/** One row of the entry grid as typed. Debit and credit are separate columns, like AO. */
export type GridRow = { account: string; debit: string; credit: string };

export const blankRow = (): GridRow => ({ account: "", debit: "", credit: "" });

export type Evaluated = {
  /** The lines to submit: blank rows left out. Debits positive, credits negative, in cents. */
  lines: JournalLine[];
  /** For each submitted line, the grid row it came from. */
  rowOf: number[];
  /** Problems by grid row. */
  rowErrors: Map<number, string>;
  totalDebit: number;
  totalCredit: number;
  /** Debits less credits: zero when the journal balances. */
  difference: number;
};

/**
 * Turns the grid into journal lines, checking each row as the server will. The server checks
 * everything again; this is for showing problems as they're typed.
 */
export function evaluate(rows: GridRow[], chart: Account[]): Evaluated {
  const accounts = new Map(chart.map((a) => [a.code, a]));
  const out: Evaluated = { lines: [], rowOf: [], rowErrors: new Map(), totalDebit: 0, totalCredit: 0, difference: 0 };

  rows.forEach((row, i) => {
    const code = normaliseCode(row.account);
    const debitText = row.debit.trim();
    const creditText = row.credit.trim();
    if (code === "" && debitText === "" && creditText === "") {
      return;
    }
    const debit = debitText === "" ? 0 : parseMoney(debitText);
    const credit = creditText === "" ? 0 : parseMoney(creditText);
    const account = accounts.get(code);
    let error: string | null = null;
    if (code === "") {
      error = "Choose an account.";
    } else if (!account) {
      error = `There's no account ${code}.`;
    } else if (!account.active) {
      error = `${code} is inactive.`;
    } else if (debit === null || credit === null) {
      error = "That isn't an amount.";
    } else if (debit < 0 || credit < 0) {
      error = "Put credits in the Credit column, not as negative debits.";
    } else if (debit !== 0 && credit !== 0) {
      error = "A line takes a debit or a credit, not both.";
    } else if (debit === 0 && credit === 0) {
      error = "Enter an amount.";
    }
    if (error) {
      out.rowErrors.set(i, error);
      return;
    }
    out.totalDebit += debit!;
    out.totalCredit += credit!;
    out.lines.push({ account: code, amount: debit! - credit! });
    out.rowOf.push(i);
  });
  out.difference = out.totalDebit - out.totalCredit;
  return out;
}

/** Account codes are case-insensitive and stored upper case, as the server normalises them. */
export function normaliseCode(text: string): string {
  return text.trim().toUpperCase();
}

/** A server-side journal problem, in words, and the grid row it's about if it's about one. */
export function describeJournalError(e: JournalError, rowOf: number[]): { row: number | null; message: string } {
  switch (e.code) {
    case "too_few_lines":
      return { row: null, message: "A journal needs at least two lines." };
    case "unbalanced":
      return { row: null, message: "The journal doesn't balance." };
    case "unknown_account":
      return { row: rowOf[e.line] ?? null, message: `There's no account ${e.account}.` };
    case "inactive_account":
      return { row: rowOf[e.line] ?? null, message: `${e.account} is inactive.` };
    case "outside_year":
      return { row: null, message: `The date must be from ${e.start} to ${e.end}.` };
  }
}
