import { describe, expect, it } from "vitest";
import { asciiText, buildOfx, fitIds, ofxFileName, splitName } from "./ofx";

const lines = [
  { date: "2026-03-03", description: "POS W/D COFFEE CART WELLINGTON", amount: -450 },
  { date: "2026-03-05", description: "SALARY ACME LTD & SONS <MARCH>", amount: 200000 },
];

describe("buildOfx", () => {
  it("writes a bank statement as OFX 1.02", () => {
    const ofx = buildOfx({
      accountType: "cheque",
      account: "12-3456-0123456-00",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      closing: 299550,
      lines,
    });
    const [header, body] = ofx.split("\r\n\r\n");
    expect(header!.split("\r\n")).toEqual([
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "VERSION:102",
      "SECURITY:NONE",
      "ENCODING:USASCII",
      "CHARSET:1252",
      "COMPRESSION:NONE",
      "OLDFILEUID:NONE",
      "NEWFILEUID:NONE",
    ]);
    const tags = body!.trim().split("\r\n");
    expect(tags.slice(0, 4)).toEqual(["<OFX>", "<SIGNONMSGSRSV1>", "<SONRS>", "<STATUS>"]);
    expect(tags).toContain("<DTSERVER>20260331</DTSERVER>");
    expect(body).toContain(
      "<BANKACCTFROM>\r\n<BANKID>12</BANKID>\r\n<BRANCHID>3456</BRANCHID>\r\n<ACCTID>12-3456-0123456-00</ACCTID>\r\n<ACCTTYPE>CHECKING</ACCTTYPE>\r\n</BANKACCTFROM>",
    );
    expect(body).toContain("<DTSTART>20260301</DTSTART>\r\n<DTEND>20260331</DTEND>");
    const first = body!.slice(body!.indexOf("<STMTTRN>"), body!.indexOf("</STMTTRN>") + 10).split("\r\n");
    expect(first).toEqual([
      "<STMTTRN>",
      "<TRNTYPE>DEBIT</TRNTYPE>",
      "<DTPOSTED>20260303</DTPOSTED>",
      "<TRNAMT>-4.50</TRNAMT>",
      `<FITID>${fitIds("12-3456-0123456-00", lines)[0]}</FITID>`,
      "<NAME>POS W/D COFFEE CART WELLINGTON</NAME>",
      "</STMTTRN>",
    ]);
    expect(body).toContain("<TRNAMT>2000.00</TRNAMT>");
    expect(body).toContain("<NAME>SALARY ACME LTD &amp; SONS &lt;MARCH&gt;</NAME>");
    expect(body).toContain("<LEDGERBAL>\r\n<BALAMT>2995.50</BALAMT>\r\n<DTASOF>20260331</DTASOF>\r\n</LEDGERBAL>");
    expect(tags.at(-1)).toBe("</OFX>");
  });

  it("writes a card statement, a savings account, and leaves out a balance it doesn't have", () => {
    const card = buildOfx({
      accountType: "card",
      account: "XXXX-XXXX-XXXX-4417",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      closing: null,
      lines: [{ date: "2026-03-03", madeOn: "2026-03-02", description: "COUNTDOWN", amount: -8520 }],
    });
    expect(card).toContain("<CREDITCARDMSGSRSV1>\r\n<CCSTMTTRNRS>");
    expect(card).toContain("<CCACCTFROM>\r\n<ACCTID>XXXX-XXXX-XXXX-4417</ACCTID>\r\n</CCACCTFROM>");
    expect(card).toContain("<DTUSER>20260302</DTUSER>");
    expect(card).not.toContain("LEDGERBAL");
    expect(card).not.toContain("BANKACCTFROM");

    const savings = buildOfx({
      accountType: "savings",
      account: "Online Saver 1234",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      closing: 0,
      lines,
    });
    expect(savings).toContain(
      "<BANKID>000000</BANKID>\r\n<ACCTID>Online Saver 1234</ACCTID>\r\n<ACCTTYPE>SAVINGS</ACCTTYPE>",
    );
    expect(savings).toContain("<BALAMT>0.00</BALAMT>");
  });

  it("is the same every time, and refuses a missing account", () => {
    const s = {
      accountType: "cheque" as const,
      account: "12-3456-0123456-00",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      closing: null,
      lines,
    };
    expect(buildOfx(s)).toBe(buildOfx({ ...s, lines: lines.map((l) => ({ ...l })) }));
    expect(() => buildOfx({ ...s, account: "  " })).toThrow(/account number/);
  });
});

describe("fitIds", () => {
  it("tells identical lines apart, and depends on the account", () => {
    const twice = [lines[0]!, lines[0]!, lines[1]!];
    const ids = fitIds("A", twice);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toMatch(/^20260303[0-9a-f]{8}$/);
    expect(ids[1]).toMatch(/^20260303[0-9a-f]{8}-1$/);
    expect(fitIds("B", twice)[0]).not.toBe(ids[0]);
    expect(fitIds("A", twice)).toEqual(ids);
  });
});

describe("splitName", () => {
  it("keeps NAME to 32 characters, breaking at a word, with the rest in MEMO", () => {
    expect(splitName("SHORT ONE")).toEqual({ name: "SHORT ONE", memo: "" });
    expect(splitName("AUTOMATIC PAYMENT TO LANDLORD PROPERTY MANAGEMENT LTD")).toEqual({
      name: "AUTOMATIC PAYMENT TO LANDLORD",
      memo: "PROPERTY MANAGEMENT LTD",
    });
    expect(splitName("A".repeat(40))).toEqual({ name: "A".repeat(32), memo: "A".repeat(8) });
    expect(splitName("   ")).toEqual({ name: "Transaction", memo: "" });
  });
});

describe("asciiText and ofxFileName", () => {
  it("folds accents and macrons to plain letters", () => {
    expect(asciiText("Café Māori “Kai” – Ōtaki  ")).toBe('Cafe Maori "Kai" - Otaki');
  });

  it("names the file after the account and the end of the period", () => {
    expect(ofxFileName("12-3456-0123456-00", "2026-03-31")).toBe("statement-12-3456-0123456-00-2026-03-31.ofx");
    expect(ofxFileName("Online Saver #1", "2026-03-31")).toBe("statement-Online-Saver-1-2026-03-31.ofx");
    expect(ofxFileName("", "2026-03-31")).toBe("statement-2026-03-31.ofx");
  });
});
