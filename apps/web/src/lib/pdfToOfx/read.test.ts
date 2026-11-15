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

describe("readStatement: printouts read with text recognition", () => {
  // Internet banking printouts, newest first, with money out marked with a minus: April's
  // printout, then March's, in one file. All made up.
  const HEAD: TestCell[] = [
    [40, "Date"],
    [110, "Description"],
    [450, "Amount", "right"],
    [530, "Balance", "right"],
  ];
  const printout = (n: number, opening: string, closing: string, rows: TestCell[][]) =>
    page(n, [
      [[40, "Example Bank Everyday 12-3456-0123456-00"]],
      [
        [40, "Opening balance"],
        [530, opening, "right"],
      ],
      [
        [40, "Closing balance"],
        [530, closing, "right"],
      ],
      HEAD,
      ...rows,
    ]);
  const line = (date: string, what: string, amount: string, balance: string): TestCell[] => [
    [40, date],
    [110, what],
    [450, amount, "right"],
    [530, balance, "right"],
  ];
  const file = (o: { coffee?: string; afterCoffee?: string; power?: string; wagesDate?: string; afterMarchWages?: string } = {}) => [
    ...printout(1, "-100.00", "-40.00", [
      line("15 Apr 2026", "POWER CO", o.power ?? "-35.00", "-40.00"),
      line(o.wagesDate ?? "9 Apr 2026", "WAGES", "100.00", "-5.00"),
      line("2 Apr 2026", "COFFEE", o.coffee ?? "-5.00", o.afterCoffee ?? "-105.00"),
    ]),
    ...printout(2, "-200.00", "-100.00", [
      line("10 Mar 2026", "WAGES", "150.00", o.afterMarchWages ?? "-100.00"),
      line("3 Mar 2026", "RENT", "-50.00", "-250.00"),
    ]),
  ];
  const recognised = { ...options, recognised: true };
  const rows = (s: ReturnType<typeof readStatement>) => s.lines.map((l) => [l.date, l.description, l.amount, l.balance]);
  const RIGHT = [
    ["2026-03-03", "RENT", -5000, -25000],
    ["2026-03-10", "WAGES", 15000, -10000],
    ["2026-04-02", "COFFEE", -500, -10500],
    ["2026-04-09", "WAGES", 10000, -500],
    ["2026-04-15", "POWER CO", -3500, -4000],
  ];

  it("takes the earliest printout's opening balance and the latest's closing", () => {
    const s = readStatement(file(), recognised);
    expect(rows(s)).toEqual(RIGHT);
    expect(s.opening).toEqual({ amount: -20000, printed: true });
    expect(s.closing).toEqual({ amount: -4000, printed: true });
    expect(s.notes).toEqual([]);
  });

  it("puts back minus signs it lost, where the running balances prove it", () => {
    const s = readStatement(file({ coffee: "5.00", afterCoffee: "105.00", power: "35.00" }), recognised);
    expect(rows(s)).toEqual(RIGHT);
    expect(s.lines.every((l) => l.balanceOff === undefined)).toBe(true);
    expect(s.notes.map((n) => n.text)).toEqual([
      "3 minus signs were read the wrong way round. The running balances show where, so they've been put right.",
    ]);
  });

  it("puts right a balance misread on its own, but only when it was read from a picture", () => {
    const misread = file({ afterMarchWages: "-700.00" });
    const s = readStatement(misread, recognised);
    expect(rows(s)).toEqual(RIGHT);
    expect(s.notes.map((n) => n.text)).toEqual([
      "One running balance was misread. The balances either side of it show what it should be, so it's been put right.",
    ]);
    // A PDF's own text is what was printed, so there it's only marked.
    expect(readStatement(misread, options).lines.map((l) => l.balanceOff)).toEqual([undefined, -60000, 60000, undefined, undefined]);
  });

  it("keeps a line whose date it can't make out, with the date above it, and marks it", () => {
    const s = readStatement(file({ wagesDate: "9 Aqr 2026" }), recognised);
    expect(s.lines.map((l) => [l.date, l.description, l.amount, l.dateUnread])).toEqual([
      ["2026-03-03", "RENT", -5000, undefined],
      ["2026-03-10", "WAGES", 15000, undefined],
      ["2026-04-02", "COFFEE", -500, undefined],
      ["2026-04-15", "WAGES", 10000, true],
      ["2026-04-15", "POWER CO", -3500, undefined],
    ]);
    expect(s.notes.map((n) => n.text)).toEqual([
      "One line's date couldn't be made out, so it has the date of the line above it. It's marked: check it.",
    ]);
  });
});

describe("readStatement: pages of two printouts, scanned", () => {
  // A scan of internet banking printouts, newest first, money out with a minus, and no headings
  // over the table: the newer printout's last page (its empty table's headings drawn at the foot),
  // then the older printout's first page, whose summary gives balances for its own pages only.
  // The misreads are text recognition's: `ot` for 01, a tilde for a minus, a colon for a point,
  // and a table rule read as letters and dashes. All made up.
  const line = (date: string, what: string, amount: string, balance: string): TestCell[] => [
    [40, date],
    [110, what],
    [450, amount, "right"],
    [530, balance, "right"],
  ];
  const file = [
    ...page(1, [
      [[40, "6/15/26, 1:05 PM"]],
      line("21 Aug 2025", "PARK 9", "120.00", "1,340:00"),
      line("18 Aug 2025", "SHED", "180.00", "1,220.00"),
      [],
      [
        [200, "Last 30 days: In 300.00"],
        [330, "Out 0.00 Net +300.00"],
      ],
      [
        [40, "Date"],
        [450, "Amount", "right"],
        [530, "Balance", "right"],
      ],
    ]),
    ...page(2, [
      [[40, "Yard Rental 12-3456-0123456-00"]],
      [
        [300, "Opening balance 24/11/2024*"],
        [530, "1,000.00", "right"],
      ],
      [
        [300, "Closing balance 12/08/2025*"],
        [530, "1,040.00", "right"],
      ],
      [],
      line("12 Aug 2025", "YARD 6", "120.00", "1,040.00"),
      line("07 Aug 2025", "SIGNS", "~230.00", "920.00"),
      [[200, "PUS——"]],
      line("ot Aug 2025", "PARK 2", "150.00", "1,150.00"),
    ]),
  ];

  it("reads every line, and a closing balance dated before the last line gives way to the running balance", () => {
    // A streak across the page stretched one balance's box far past its column.
    const streaked = file.map((r) => (r.text === "1,220.00" ? { ...r, width: r.width + 40 } : r));
    const s = readStatement(streaked, { ...options, recognised: true });
    expect(s.lines.map((l) => [l.date, l.description, l.amount, l.balance, l.balanceOff])).toEqual([
      ["2025-08-01", "PARK 2", 15000, 115000, undefined],
      ["2025-08-07", "SIGNS", -23000, 92000, undefined],
      ["2025-08-12", "YARD 6", 12000, 104000, undefined],
      ["2025-08-18", "SHED", 18000, 122000, undefined],
      ["2025-08-21", "PARK 9", 12000, 134000, undefined],
    ]);
    expect(s.opening).toEqual({ amount: 100000, printed: true });
    expect(s.closing).toEqual({ amount: 134000, printed: false });
    expect(s.notes.map((n) => n.text)).toEqual([
      "The closing balance printed for 12 Aug 2025 is for part of this file only, as its lines run past that date, so it's worked out from the running balances instead.",
    ]);
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
