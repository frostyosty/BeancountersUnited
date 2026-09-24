import { describe, expect, it } from "vitest";
import { formatDollars, formatMoney, MAX_CENTS, parseMoney, sumCents } from "./money";

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
