import { describe, expect, it } from "vitest";
import { csvRecords, decodeText, readCsvStatement } from "./csvIn";
import { buildCsv } from "./formats";

const read = (text: string, fallbackYear = 2026) => readCsvStatement(text, { fallbackYear });
const brief = (text: string) => read(text).lines.map((l) => [l.date, l.description, l.amount, l.balance]);

describe("csvRecords", () => {
  it("reads quoted fields, doubled quotes, commas and line breaks inside quotes", () => {
    expect(csvRecords('a,"b, c","say ""hi"""\r\n"two\nlines",x,\r\n\r\n')).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["two\nlines", "x", ""],
    ]);
  });

  it("uses tabs or semicolons when that's what the file is split by", () => {
    expect(csvRecords("Date\tAmount\n1/3/2026\t-4.50\n")).toEqual([
      ["Date", "Amount"],
      ["1/3/2026", "-4.50"],
    ]);
    expect(csvRecords("Date;Amount\n1/3/2026;-4.50\n")[1]).toEqual(["1/3/2026", "-4.50"]);
  });
});

describe("decodeText", () => {
  it("reads UTF-8 without its byte-order mark, and falls back to Windows' encoding", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xc3, 0xa9]))).toBe("Aé");
    expect(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
  });
});

describe("readCsvStatement", () => {
  it("reads back the CSV this tool writes", () => {
    const csv = buildCsv({
      accountType: "cheque",
      account: "12-3456-0123456-00",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      closing: 134550,
      lines: [
        { date: "2026-03-03", description: "COFFEE CART", amount: -450, balance: 99550 },
        { date: "2026-03-05", description: "SALARY, ACME LTD", amount: 35000, balance: 134550 },
      ],
    });
    const s = read(csv);
    expect(s.lines.map((l) => [l.date, l.description, l.amount, l.balance])).toEqual([
      ["2026-03-03", "COFFEE CART", -450, 99550],
      ["2026-03-05", "SALARY, ACME LTD", 35000, 134550],
    ]);
    expect(s.periodStart).toBe("2026-03-03");
    expect(s.periodEnd).toBe("2026-03-05");
    expect(s.opening).toEqual({ amount: 100000, printed: false });
    expect(s.closing).toEqual({ amount: 134550, printed: false });
    expect(s.notes).toEqual([]);
  });

  it("finds the account above the headings, joins description columns, and puts newest-first files in order", () => {
    const csv = [
      "Made-up Bank export",
      "Account,12-3456-0123456-00",
      "",
      "Transaction Date,Payee,Particulars,Reference,Withdrawals,Deposits,Balance",
      "05/03/2026,ACME LTD,SALARY,,,350.00,\"1,345.50\"",
      "03/03/2026,COFFEE CART,,card 1234,4.50,,995.50",
      "01/03/2026,TRANSFER,,,,\"1,000\",1000.00",
    ].join("\n");
    const s = read(csv);
    expect(s.account).toBe("12-3456-0123456-00");
    expect(s.lines.map((l) => [l.date, l.description, l.amount, l.balance])).toEqual([
      ["2026-03-01", "TRANSFER", 100000, 100000],
      ["2026-03-03", "COFFEE CART card 1234", -450, 99550],
      ["2026-03-05", "ACME LTD SALARY", 35000, 134550],
    ]);
    expect(s.lines.some((l) => l.balanceOff !== undefined)).toBe(false);
  });

  it("reads signed amounts in other shapes, and marks a balance that doesn't follow", () => {
    const csv = [
      "Date,Description,Amount,Balance",
      "2026-03-01,A,100,100.00",
      "2026-03-02,B,(4.00),96.00",
      "2026-03-03,C,$12.5,108.50",
      "2026-03-04,D,10.00 DR,90.00 CR",
      "2026-03-05,E,-$5.00,50.00",
    ].join("\n");
    const s = read(csv);
    expect(s.lines.map((l) => l.amount)).toEqual([10000, -400, 1250, -1000, -500]);
    expect(s.lines.map((l) => l.balanceOff)).toEqual([undefined, undefined, undefined, -850, -3500]);
  });

  it("reads month-first dates when the file shows them, and asks for the year when none is given", () => {
    expect(brief("Date,Description,Amount\n03/14/2026,A,1.00\n03/15/2026,B,2.00\n").map((l) => l[0])).toEqual([
      "2026-03-14",
      "2026-03-15",
    ]);
    const yearless = read("Date,Description,Amount\n3 Mar,A,1.00\n");
    expect(yearless.lines[0]!.date).toBe("2026-03-03");
    expect(yearless.assumedYear).toBe(2026);
    expect(read("Date,Description,Amount\n3 Mar,A,1.00\n", 2025).lines[0]!.date).toBe("2025-03-03");
  });

  it("skips totals and blank rows, and says how many lines had no date", () => {
    const s = read("Date,Description,Amount\n01/03/2026,A,1.00\n,,\nTotal,,1.00\n,Pending,2.00\n");
    expect(s.lines).toHaveLength(1);
    expect(s.notes.map((n) => n.text)).toEqual(["2 lines have an amount but no date we could read, so they're left out."]);
  });

  it("says when it can't find the columns", () => {
    expect(read("just,some,words\n1,2,3\n").notes[0]!.text).toMatch(/couldn't find the column headings/);
    expect(read("Date,Amount\n").notes[0]!.text).toMatch(/no lines with a date and an amount/);
  });
});
