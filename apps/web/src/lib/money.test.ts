import { describe, expect, it } from "vitest";
import {
  formatDollars,
  formatPlainMoney,
  formatMoney,
  formatStatementCents,
  formatStatementDollars,
  MAX_CENTS,
  parseMoney,
  parseStatementAmount,
  sumCents,
} from "./money";

describe("parseMoney", () => {
  it.each([
    ["0", 0],
    ["12", 1200],
    ["12.3", 1230],
    ["12.34", 1234],
    [".5", 50],
    ["5.", 500],
    ["1,234.56", 123456],
    ["1234567.89", 123456789],
    ["$7.05", 705],
    ["-12.34", -1234],
    ["(40.00)", -4000],
    ["-$3", -300],
    ["  1 234.50 ", 123450],
    ["-0", 0],
    ["0.10", 10],
    ["007.01", 701],
  ])("%j is %d cents", (text, cents) => {
    expect(parseMoney(text)).toBe(cents);
  });

  it.each(["", " ", "abc", "1.234", "1,23", "12,34.00", "--1", "(-1)", "1e3", ".", "$", "0x10", "1.2.3"])(
    "%j is not an amount",
    (text) => {
      expect(parseMoney(text)).toBeNull();
    },
  );

  it("accepts the largest amount and rejects anything bigger", () => {
    expect(parseMoney("999,999,999,999.99")).toBe(MAX_CENTS);
    expect(parseMoney("1000000000000")).toBeNull();
  });

  it("avoids float rounding", () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004.
    expect(sumCents([parseMoney("0.1")!, parseMoney("0.2")!])).toBe(30);
    expect(parseMoney("1.15")).toBe(115);
    expect(parseMoney("4.35")).toBe(435);
  });
});

describe("formatMoney", () => {
  it.each([
    [0, "0.00"],
    [5, "0.05"],
    [50, "0.50"],
    [123456, "1,234.56"],
    [-1234, "-12.34"],
    [-5, "-0.05"],
    [100000000, "1,000,000.00"],
  ])("%d cents is %j", (cents, text) => {
    expect(formatMoney(cents)).toBe(text);
  });

  it("round-trips through parseMoney", () => {
    for (const cents of [0, 1, -1, 99, 100, 123456789, -987654321, MAX_CENTS]) {
      expect(parseMoney(formatMoney(cents))).toBe(cents);
    }
  });

  it("rejects non-integers", () => {
    expect(() => formatMoney(1.5)).toThrow();
    expect(() => formatMoney(Number.NaN)).toThrow();
  });
});

describe("formatDollars", () => {
  it("groups thousands", () => {
    expect(formatDollars(0)).toBe("0");
    expect(formatDollars(1234567)).toBe("1,234,567");
    expect(formatDollars(-999)).toBe("-999");
  });
});

describe("formatStatementDollars", () => {
  it("brackets negatives, dashes nil and blanks no amount", () => {
    expect(formatStatementDollars(103464)).toBe("103,464");
    expect(formatStatementDollars(-1912)).toBe("(1,912)");
    expect(formatStatementDollars(0)).toBe("–");
    expect(formatStatementDollars(null)).toBe("");
  });
});

describe("formatStatementCents", () => {
  it("brackets negatives and dashes nil", () => {
    expect(formatStatementCents(10341260)).toBe("103,412.60");
    expect(formatStatementCents(-60)).toBe("(0.60)");
    expect(formatStatementCents(0)).toBe("–");
  });
});

describe("parseStatementAmount", () => {
  it("reads the ways statements print money, and how they sign it", () => {
    expect(parseStatementAmount("1,234.56")).toEqual({ cents: 123456, sign: null });
    expect(parseStatementAmount("$12.00")).toEqual({ cents: 1200, sign: null });
    expect(parseStatementAmount("-12.00")).toEqual({ cents: 1200, sign: "minus" });
    expect(parseStatementAmount("-$12.00")).toEqual({ cents: 1200, sign: "minus" });
    expect(parseStatementAmount("(12.00)")).toEqual({ cents: 1200, sign: "minus" });
    expect(parseStatementAmount("12.00-")).toEqual({ cents: 1200, sign: "minus" });
    expect(parseStatementAmount("+12.00")).toEqual({ cents: 1200, sign: "plus" });
    expect(parseStatementAmount("12.00 CR")).toEqual({ cents: 1200, sign: "cr" });
    expect(parseStatementAmount("12.00DR")).toEqual({ cents: 1200, sign: "dr" });
    expect(parseStatementAmount("12.00 od")).toEqual({ cents: 1200, sign: "dr" });
    expect(parseStatementAmount("NZ$ 0.50")).toEqual({ cents: 50, sign: null });
  });

  it("refuses what isn't money: no cents, a rate, a reference, or two signs", () => {
    for (const text of ["12", "12.5", "4.875", "1234-5678", "12/03", "(12.00", "-12.00 CR", "--12.00", "1,23.00", "abc"]) {
      expect(parseStatementAmount(text), text).toBeNull();
    }
  });
});

describe("formatPlainMoney", () => {
  it("writes cents with no separators, as OFX wants them", () => {
    expect(formatPlainMoney(123456789)).toBe("1234567.89");
    expect(formatPlainMoney(-450)).toBe("-4.50");
    expect(formatPlainMoney(5)).toBe("0.05");
    expect(formatPlainMoney(0)).toBe("0.00");
    expect(() => formatPlainMoney(1.5)).toThrow();
  });
});
