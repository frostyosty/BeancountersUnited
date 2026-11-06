import { describe, expect, it } from "vitest";
import { coinCount, shares } from "./flyMoney";

describe("flyMoney helpers", () => {
  it("sends more coins for a bigger saving, within limits", () => {
    expect(coinCount(100)).toBe(3);
    expect(coinCount(50_000)).toBe(10);
    expect(coinCount(100_000_000)).toBe(24);
  });

  it("splits a saving into shares that add back to exactly the total", () => {
    for (const [total, n] of [[12_345, 7], [1, 3], [0, 4], [99_999, 24]]) {
      const parts = shares(total, n);
      expect(parts).toHaveLength(n);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});
