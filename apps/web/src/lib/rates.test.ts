import { describe, expect, it } from "vitest";
import { formatRate, parseRate } from "./rates";

describe("rates", () => {
  it("parses percentages into basis points without floats", () => {
    expect(parseRate("12.5")).toBe(1250);
    expect(parseRate("12.5%")).toBe(1250);
    expect(parseRate(" 33.33 ")).toBe(3333);
    expect(parseRate("0.07")).toBe(7);
    expect(parseRate("100")).toBe(10_000);
    expect(parseRate(".5")).toBe(50);
  });

  it("rejects what isn't a rate from 0.01% to 100%", () => {
    for (const bad of ["", "0", "0.00", "100.01", "12.345", "abc", "-5", "1,000"]) {
      expect(parseRate(bad)).toBeNull();
    }
  });

  it("formats without trailing zeros", () => {
    expect(formatRate(1250)).toBe("12.5%");
    expect(formatRate(1500)).toBe("15%");
    expect(formatRate(3333)).toBe("33.33%");
    expect(formatRate(7)).toBe("0.07%");
    expect(() => formatRate(1.5)).toThrow();
  });
});
