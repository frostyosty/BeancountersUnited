import type { Account } from "@acct/types/Account";
import { describe, expect, it } from "vitest";
import { blankRow, describeJournalError, evaluate } from "./journalGrid";

const chart: Account[] = [
  { code: "100", name: "Sales", account_type: "income", active: true },
  { code: "600", name: "Bank", account_type: "asset", active: true },
  { code: "A10", name: "Old", account_type: "asset", active: false },
];

describe("evaluate", () => {
  it("turns debit and credit columns into signed cents and skips blank rows", () => {
    const e = evaluate(
      [
        { account: "600", debit: "1,150.10", credit: "" },
        blankRow(),
        { account: " 100 ", debit: "", credit: "1150.1" },
      ],
      chart,
    );
    expect(e.lines).toEqual([
      { account: "600", amount: 115010 },
      { account: "100", amount: -115010 },
    ]);
    expect(e.rowOf).toEqual([0, 2]);
    expect(e.rowErrors.size).toBe(0);
    expect(e.totalDebit).toBe(115010);
    expect(e.totalCredit).toBe(115010);
    expect(e.difference).toBe(0);
  });

  it("shows the live difference without float drift", () => {
    const e = evaluate(
      [
        { account: "600", debit: "0.10", credit: "" },
        { account: "600", debit: "0.20", credit: "" },
        { account: "100", debit: "", credit: "0.3" },
      ],
      chart,
    );
    expect(e.difference).toBe(0);
    expect(evaluate([{ account: "600", debit: "5", credit: "" }], chart).difference).toBe(500);
  });

  it("flags each bad row", () => {
    const e = evaluate(
      [
        { account: "", debit: "5", credit: "" },
        { account: "999", debit: "5", credit: "" },
        { account: "a10", debit: "5", credit: "" },
        { account: "600", debit: "5x", credit: "" },
        { account: "600", debit: "-5", credit: "" },
        { account: "600", debit: "5", credit: "5" },
        { account: "600", debit: "0", credit: "" },
      ],
      chart,
    );
    expect([...e.rowErrors.entries()]).toEqual([
      [0, "Choose an account."],
      [1, "There's no account 999."],
      [2, "A10 is inactive."],
      [3, "That isn't an amount."],
      [4, "Put credits in the Credit column, not as negative debits."],
      [5, "A line takes a debit or a credit, not both."],
      [6, "Enter an amount."],
    ]);
    expect(e.lines).toEqual([]);
  });
});

describe("describeJournalError", () => {
  it("points line problems at their grid row", () => {
    expect(describeJournalError({ code: "unknown_account", line: 1, account: "999" }, [0, 3])).toEqual({
      row: 3,
      message: "There's no account 999.",
    });
    expect(
      describeJournalError({ code: "outside_year", date: "2027-01-01", start: "2025-04-01", end: "2026-03-31" }, []),
    ).toEqual({ row: null, message: "The date must be from 2025-04-01 to 2026-03-31." });
  });
});
