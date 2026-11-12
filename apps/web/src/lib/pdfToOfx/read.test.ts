import { describe, expect, it } from "vitest";
import { page, row, type TestCell } from "../../test/statementRuns";
import { buildLines, lineText } from "./layout";
import { nzAccount, readStatement } from "./read";

const options = { fallbackYear: 2026 };

// Columns: date at 40, description at 110, money right-aligned on 380 (out), 450 (in), 530 (balance).
const HEADINGS: TestCell[] = [
  [40, "Date"],
  [110, "Transaction details"],
  [380, "Withdrawals", "right"],
  [450, "Deposits", "right"],
  [530, "Balance", "right"],
];

function chequeStatement(salaryBalance = "2,995.50") {
  return [
    ...page(1, [
      [[40, "Example Bank"]],
      [
        [40, "Everyday account"],
        [200, "12-3456-0123456-00"],
      ],
      [[40, "Statement period 1 March 2026 to 31 March 2026"]],
      HEADINGS,
      [
        [40, "1 Mar"],
        [110, "Opening balance"],
        [530, "1,000.00", "right"],
      ],
      [
        [40, "3 Mar"],
        [110, "POS W/D COFFEE CART"],
        [380, "4.50", "right"],
        [530, "995.50", "right"],
      ],
      [[110, "WELLINGTON"]],
    ]),
    ...row(1, 780, [[260, "Page 1 of 2"]]),
    ...page(2, [
      HEADINGS,
      [
        [40, "5 Mar"],
        [110, "SALARY ACME LTD"],
        [450, "2,000.00", "right"],
        [530, salaryBalance, "right"],
      ],
      [
        [110, "AUTOMATIC PAYMENT RENT"],
        [380, "650.00", "right"],
        [530, "2,345.50", "right"],
      ],
      [
        [110, "Totals"],
        [380, "654.50", "right"],
        [450, "2,000.00", "right"],
      ],
      [
        [40, "31 Mar"],
        [110, "Closing balance"],
        [530, "2,345.50", "right"],
      ],
    ]),
  ];
}

describe("readStatement: a cheque account with headings", () => {
  const s = readStatement(chequeStatement(), options);

  it("reads the account, period and balances", () => {
    expect(s.hasText).toBe(true);
    expect(s.kind).toBe("bank");
    expect(s.account).toBe("12-3456-0123456-00");
    expect(s.savings).toBe(false);
    expect([s.periodStart, s.periodEnd]).toEqual(["2026-03-01", "2026-03-31"]);
    expect(s.opening).toEqual({ amount: 100000, printed: true });
    expect(s.closing).toEqual({ amount: 234550, printed: true });
    expect(s.assumedYear).toBeNull();
    expect(s.notes).toEqual([]);
  });

  it("reads each transaction, across pages, carrying dates down and descriptions on", () => {
    expect(s.lines).toEqual([
      { page: 1, date: "2026-03-03", description: "POS W/D COFFEE CART WELLINGTON", amount: -450, balance: 99550 },
      { page: 2, date: "2026-03-05", description: "SALARY ACME LTD", amount: 200000, balance: 299550 },
      { page: 2, date: "2026-03-05", description: "AUTOMATIC PAYMENT RENT", amount: -65000, balance: 234550 },
    ]);
  });

  it("marks running balances that don't follow", () => {
    const off = readStatement(chequeStatement("2,995.00"), options);
    expect(off.lines.map((l) => l.balanceOff)).toEqual([undefined, -50, 50]);
    expect(off.notes.map((n) => n.text)).toEqual([
      "2 running balances don't follow from the line before. Those lines are marked: check them against the PDF.",
    ]);
  });
});

describe("readStatement: a credit card", () => {
  const card = [
    ...page(1, [
      [[40, "Example Bank Visa credit card"]],
      [[40, "Card number 4000 XXXX XXXX 4417"]],
      [[40, "Statement period 1 March 2026 to 31 March 2026"]],
      [
        [40, "Credit limit"],
        [200, "5,000.00", "right"],
      ],
      [
        [40, "Minimum payment due"],
        [200, "25.00", "right"],
      ],
      [
        [40, "Date"],
        [110, "Details"],
        [450, "Amount", "right"],
      ],
      [
        [110, "Opening balance"],
        [450, "100.00", "right"],
      ],
      [
        [40, "02 Mar 03 Mar"],
        [110, "COUNTDOWN AUCKLAND"],
        [450, "85.20", "right"],
      ],
      [
        [40, "10 Mar 10 Mar"],
        [110, "PAYMENT RECEIVED - THANK YOU"],
        [463, "300.00 CR", "right"],
      ],
      [
        [40, "15 Mar 16 Mar"],
        [110, "AIR NZ USD 120.00"],
        [450, "210.35", "right"],
      ],
      [
        [110, "Closing balance"],
        [450, "95.55", "right"],
      ],
    ]),
  ];
  const s = readStatement(card, options);

  it("knows it's a card, and masks the number", () => {
    expect(s.kind).toBe("card");
    expect(s.account).toBe("XXXX-XXXX-XXXX-4417");
  });

  it("signs purchases as money out and payments as money in, and what's owed as negative", () => {
    expect(s.lines).toEqual([
      { page: 1, date: "2026-03-03", madeOn: "2026-03-02", description: "COUNTDOWN AUCKLAND", amount: -8520, balance: null },
      { page: 1, date: "2026-03-10", description: "PAYMENT RECEIVED - THANK YOU", amount: 30000, balance: null },
      // The amount in US dollars is part of the description, not money.
      { page: 1, date: "2026-03-16", madeOn: "2026-03-15", description: "AIR NZ USD 120.00", amount: -21035, balance: null },
    ]);
    expect(s.opening).toEqual({ amount: -10000, printed: true });
    expect(s.closing).toEqual({ amount: -9555, printed: true });
  });
});

describe("readStatement: no headings", () => {
  // One column of plain amounts (right edge 450) and a running balance (530); dates day-first.
  const lines: TestCell[][] = [
    [
      [40, "02/04/2026"],
      [110, "EFTPOS PAK N SAVE"],
      [450, "45.10", "right"],
      [530, "454.90", "right"],
    ],
    [
      [40, "05/04/2026"],
      [110, "INTEREST"],
      [450, "0.25", "right"],
      [530, "455.15", "right"],
    ],
    [
      [40, "13/04/2026"],
      [110, "DIRECT CREDIT J SMITH"],
      [450, "100.00", "right"],
      [530, "555.15", "right"],
    ],
    [
      [40, "20/04/2026"],
      [110, "POWER CO"],
      [450, "80.00", "right"],
      [530, "475.15", "right"],
    ],
  ];
  const header: TestCell[][] = [
    [[40, "Example Bank Online Saver"]],
    [[40, "Account 12-3456-0123456-001"]],
    [
      [40, "01/04/2026"],
      [110, "Opening Balance"],
      [530, "500.00", "right"],
    ],
  ];

  it("finds the balance column and signs plain amounts from it", () => {
    const s = readStatement(page(1, [...header, ...lines]), options);
    expect(s.account).toBe("12-3456-0123456-01");
    expect(s.savings).toBe(true);
    expect(s.lines.map((l) => [l.date, l.description, l.amount, l.balance])).toEqual([
      ["2026-04-02", "EFTPOS PAK N SAVE", -4510, 45490],
      ["2026-04-05", "INTEREST", 25, 45515],
      ["2026-04-13", "DIRECT CREDIT J SMITH", 10000, 55515],
      ["2026-04-20", "POWER CO", -8000, 47515],
    ]);
    expect(s.opening).toEqual({ amount: 50000, printed: true });
    expect(s.closing).toEqual({ amount: 47515, printed: false });
    expect(s.notes).toEqual([]);
  });

  it("turns a newest-first statement round, and says when a sign is a guess", () => {
    const s = readStatement(page(1, [header[0]!, header[1]!, ...[...lines].reverse()]), options);
    expect(s.lines.map((l) => l.date)).toEqual(["2026-04-02", "2026-04-05", "2026-04-13", "2026-04-20"]);
    // With no opening balance, nothing says which way the first line went.
    expect(s.lines.slice(1).map((l) => l.amount)).toEqual([25, 10000, -8000]);
    expect(s.notes.map((n) => n.text)).toContainEqual(expect.stringContaining("Swap money in and out"));
  });
});

describe("readStatement: what it can't read", () => {
  it("says when a PDF is only a picture", () => {
    const s = readStatement([], options);
    expect(s.hasText).toBe(false);
    expect(s.lines).toEqual([]);
    expect(s.notes[0]!.text).toContain("scan or a photo");
  });

  it("says when there's no table of transactions", () => {
    const s = readStatement(page(1, [[[40, "Dear customer, thank you for banking with us. Your statement is attached."]]]), options);
    expect(s.hasText).toBe(true);
    expect(s.lines).toEqual([]);
    expect(s.notes[0]!.text).toContain("couldn't find any transactions");
  });

  it("assumes this year when the statement never gives one, and says so", () => {
    const s = readStatement(
      page(1, [
        HEADINGS,
        [
          [40, "3 Mar"],
          [110, "COFFEE"],
          [380, "4.50", "right"],
          [530, "95.50", "right"],
        ],
        [
          [40, "4 Mar"],
          [110, "REFUND"],
          [450, "1.00", "right"],
          [530, "96.50", "right"],
        ],
      ]),
      { fallbackYear: 2025 },
    );
    expect(s.assumedYear).toBe(2025);
    expect(s.lines.map((l) => l.date)).toEqual(["2025-03-03", "2025-03-04"]);
    expect(s.notes[0]!.text).toContain("used 2025");
  });
});

describe("buildLines", () => {
  it("joins runs on one baseline into cells, and keeps column gaps apart", () => {
    const lines = buildLines([
      ...row(1, 100, [
        [40, "3 Mar"],
        [110, "COFFEE"],
      ]),
      // Drawn in two pieces, as PDFs often do.
      { page: 1, x: 200, y: 100.4, width: 9, size: 9, text: "12" },
      { page: 1, x: 209, y: 100.4, width: 13.5, size: 9, text: ".50" },
      ...row(1, 114, [[40, "next line"]]),
    ]);
    expect(lines.map(lineText)).toEqual(["3 Mar  COFFEE  12.50", "next line"]);
  });
});

describe("nzAccount", () => {
  it("reads NZ account numbers in their usual forms", () => {
    expect(nzAccount("Acc 12-3456-0123456-00")).toBe("12-3456-0123456-00");
    expect(nzAccount("12 3456 00123456 000")).toBe("12-3456-0123456-00");
    expect(nzAccount("12-3456-0123456-001")).toBe("12-3456-0123456-01");
    expect(nzAccount("ref 1234")).toBeNull();
  });
});
