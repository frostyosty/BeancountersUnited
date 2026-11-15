import { describe, expect, it } from "vitest";
import {
  addLineAfter,
  applyFixes,
  balanceSuggestions,
  dateSuggestions,
  editLine,
  type Fixes,
  NO_FIXES,
  undoLine,
} from "./fixes";
import { markBalances, type ReadLine, type ReadStatement } from "./read";

/** A made-up statement as read, its running balances checked as the reader checks them. */
function statement(lines: Omit<ReadLine, "page">[], opening: number | null = 100000): ReadStatement {
  const read: ReadLine[] = lines.map((l) => ({ page: 1, ...l }));
  markBalances(read, opening);
  return {
    hasText: true,
    kind: "bank",
    account: "12-3456-0123456-00",
    savings: false,
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    opening: opening === null ? null : { amount: opening, printed: true },
    closing: null,
    lines: read,
    assumedYear: null,
    notes: [],
  };
}

// Opening 1,000.00; the coffee's balance misread as 905.50 (it's 995.50).
const misread = statement([
  { date: "2026-03-03", description: "COFFEE", amount: -450, balance: 90550 },
  { date: "2026-03-05", description: "SALARY", amount: 35000, balance: 134550 },
  { date: "2026-03-09", description: "RENT", amount: -65000, balance: 69550 },
]);

describe("applyFixes", () => {
  it("lays the fixes over the lines as read, and checks the running balances again", () => {
    expect(applyFixes(misread, NO_FIXES).issues).toBe(2);
    const fixed = applyFixes(misread, editLine(NO_FIXES, { read: 0 }, { balance: 99550 }));
    expect(fixed.issues).toBe(0);
    expect(fixed.changes).toBe(1);
    expect(fixed.lines[0]).toMatchObject({ balance: 99550, changed: true });
    expect(fixed.lines[0]!.balanceOff).toBeUndefined();
    // The statement as read is never changed.
    expect(misread.lines[0]!.balance).toBe(90550);
    expect(misread.lines[0]!.balanceOff).toBe(-9000);
  });

  it("leaves a line taken out in the list, but not in the file or the balances", () => {
    const f = editLine(NO_FIXES, { read: 2 }, { removed: true });
    const fixed = applyFixes(misread, f);
    expect(fixed.all.map((l) => [l.description, l.removed])).toEqual([
      ["COFFEE", false],
      ["SALARY", false],
      ["RENT", true],
    ]);
    expect(fixed.lines.map((l) => l.description)).toEqual(["COFFEE", "SALARY"]);
    expect(fixed.closing).toEqual({ amount: 134550, printed: false });
    expect(applyFixes(misread, undoLine(f, { read: 2 })).lines).toHaveLength(3);
  });

  it("puts an added line where it was added, and can change or drop it", () => {
    const { fixes: f, key } = addLineAfter(NO_FIXES, { read: 0 }, { date: "2026-03-04", description: "FEE", amount: -500, balance: null });
    expect(applyFixes(misread, f).lines.map((l) => [l.description, l.added])).toEqual([
      ["COFFEE", false],
      ["FEE", true],
      ["SALARY", false],
      ["RENT", false],
    ]);
    const changed = editLine(f, { added: key }, { amount: -700 });
    expect(applyFixes(misread, changed).lines[1]!.amount).toBe(-700);
    expect(applyFixes(misread, editLine(changed, { added: key }, { removed: true })).lines).toHaveLength(3);
  });

  it("uses an opening or closing balance the person sets", () => {
    const s = statement([{ date: "2026-03-03", description: "COFFEE", amount: -450, balance: 99550 }], 50000);
    expect(applyFixes(s, NO_FIXES).issues).toBe(1);
    const fixed = applyFixes(s, { ...NO_FIXES, opening: 100000, closing: 99550 });
    expect(fixed.issues).toBe(0);
    expect(fixed.opening).toEqual({ amount: 100000, printed: true });
    expect(fixed.closing).toEqual({ amount: 99550, printed: true });
    expect(fixed.changes).toBe(2);
  });
});

describe("balanceSuggestions", () => {
  const ways = (s: ReadStatement, f: Fixes, at: number) => {
    const fixed = applyFixes(s, f);
    return balanceSuggestions(s, f, fixed, fixed.lines[at]!).map((w) => [w.kind, w.value, w.best]);
  };

  it("offers only what makes the balances follow, the one that clears the most first", () => {
    // Putting the coffee's balance right clears both marks; the rest, only its own.
    expect(ways(misread, NO_FIXES, 0)).toEqual([
      ["balance", 99550, true],
      ["amount", -9450, false],
      ["missing", -9000, false],
      ["opening", 91000, false],
    ]);
    // From the salary's side, its own balance put "right" would break the rent line after it, so it isn't offered.
    expect(ways(misread, NO_FIXES, 1).map(([kind]) => kind)).toEqual(["amount", "missing"]);
  });

  it("offers a line of the difference, or a new opening balance, when lines before the first are missing", () => {
    const s = statement([
      { date: "2026-03-03", description: "COFFEE", amount: -450, balance: 194550 },
      { date: "2026-03-05", description: "SALARY", amount: 35000, balance: 229550 },
    ]);
    expect(ways(s, NO_FIXES, 0)).toEqual([
      ["amount", 94550, false],
      ["missing", 95000, false],
      ["opening", 195000, false],
    ]);
  });

  it("offers taking out a line that doubles another", () => {
    const s = statement([
      { date: "2026-03-03", description: "COFFEE", amount: -450, balance: 99550 },
      { date: "2026-03-03", description: "COFFEE", amount: -450, balance: 99550 },
    ]);
    expect(ways(s, NO_FIXES, 1).map(([kind]) => kind)).toEqual(["balance", "missing", "remove"]);
  });
});

describe("dateSuggestions", () => {
  it("offers the date it has and its neighbours' dates", () => {
    const s = statement(
      [
        { date: "2026-03-03", description: "COFFEE", amount: -450, balance: null },
        { date: "2026-03-03", description: "LUNCH", amount: -1500, balance: null, dateUnread: true },
        { date: "2026-03-09", description: "RENT", amount: -65000, balance: null },
      ],
      null,
    );
    const fixed = applyFixes(s, NO_FIXES);
    expect(fixed.issues).toBe(1);
    const ways = dateSuggestions(NO_FIXES, fixed, fixed.lines[1]!);
    expect(ways.map((w) => [w.kind, w.value])).toEqual([
      ["dateRight", "2026-03-03"],
      ["date", "2026-03-09"],
    ]);
    expect(applyFixes(s, ways[0]!.fixes).issues).toBe(0);
    expect(applyFixes(s, ways[1]!.fixes).lines[1]!.date).toBe("2026-03-09");
  });
});
