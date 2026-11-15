import { describe, expect, it } from "vitest";
import { buildCsv, buildQif, buildStatementFile, buildXeroCsv, statementFileName, type StatementFile } from "./formats";

const statement: StatementFile = {
  accountType: "cheque",
  account: "12-3456-0123456-00",
  periodStart: "2026-03-01",
  periodEnd: "2026-03-31",
  closing: 134550,
  lines: [
    { date: "2026-03-03", description: "POS W/D COFFEE CART, WELLINGTON CENTRAL BRANCH", amount: -450, balance: 99550 },
    { date: "2026-03-05", description: 'SALARY "ACME" LTD', amount: 35000, balance: 134550 },
    { date: "2026-03-06", description: "=SUM(A1)", amount: -100, balance: null },
  ],
};

describe("buildQif", () => {
  it("writes a bank section with day-first dates, splitting long descriptions as OFX does", () => {
    expect(buildQif(statement).split("\r\n")).toEqual([
      "!Account",
      "N12-3456-0123456-00",
      "TBank",
      "^",
      "!Type:Bank",
      "D03/03/2026",
      "T-4.50",
      "PPOS W/D COFFEE CART, WELLINGTON",
      "MCENTRAL BRANCH",
      "^",
      "D05/03/2026",
      "T350.00",
      'PSALARY "ACME" LTD',
      "^",
      "D06/03/2026",
      "T-1.00",
      "P=SUM(A1)",
      "^",
      "",
    ]);
  });

  it("writes a card as a CCard section", () => {
    const qif = buildQif({ ...statement, accountType: "card", account: "XXXX-XXXX-XXXX-1234" });
    expect(qif).toContain("!Type:CCard\r\n");
    expect(qif).toContain("TCCard\r\n");
  });

  it("needs an account number", () => {
    expect(() => buildQif({ ...statement, account: " " })).toThrow(/account number/);
  });
});

describe("buildCsv", () => {
  it("writes one row per line, quoting where it must and never starting a formula", () => {
    expect(buildCsv(statement).split("\r\n")).toEqual([
      "Date,Description,Amount,Balance",
      '03/03/2026,"POS W/D COFFEE CART, WELLINGTON CENTRAL BRANCH",-4.50,995.50',
      '05/03/2026,"SALARY ""ACME"" LTD",350.00,1345.50',
      "06/03/2026,'=SUM(A1),-1.00,",
      "",
    ]);
  });
});

describe("buildXeroCsv", () => {
  it("writes Xero's columns, splitting the description as OFX does", () => {
    expect(buildXeroCsv(statement).split("\r\n")).toEqual([
      "Date,Amount,Payee,Description,Reference,Check Number",
      '03/03/2026,-4.50,"POS W/D COFFEE CART, WELLINGTON",CENTRAL BRANCH,,',
      '05/03/2026,350.00,"SALARY ""ACME"" LTD",,,',
      "06/03/2026,-1.00,'=SUM(A1),,,",
      "",
    ]);
    expect(buildStatementFile("csv", statement, "xero")).toBe(buildXeroCsv(statement));
  });
});

describe("buildStatementFile and statementFileName", () => {
  it("writes the format asked for", () => {
    expect(buildStatementFile("ofx", statement)).toMatch(/^OFXHEADER:100/);
    expect(buildStatementFile("qif", statement)).toMatch(/^!Account/);
    expect(buildStatementFile("csv", statement)).toMatch(/^Date,Description/);
    // The same statement gives the same file every time.
    expect(buildStatementFile("csv", statement)).toBe(buildStatementFile("csv", statement));
  });

  it("names the file after the account, the end of the period and the format", () => {
    expect(statementFileName("12-3456-0123456-00", "2026-03-31", "ofx")).toBe("statement-12-3456-0123456-00-2026-03-31.ofx");
    expect(statementFileName("Online Saver #1", "2026-03-31", "qif")).toBe("statement-Online-Saver-1-2026-03-31.qif");
    expect(statementFileName("", "2026-03-31", "csv")).toBe("statement-2026-03-31.csv");
  });
});
