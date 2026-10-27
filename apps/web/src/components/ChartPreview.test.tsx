import { describe, expect, it } from "vitest";
import { codeGroups } from "./ChartPreview";

const acc = (code: string, account_type: "asset" | "income" | "expense" | "equity" | "liability") => ({
  code,
  name: `Account ${code}`,
  account_type,
  active: true,
});

describe("codeGroups", () => {
  it("collapses runs of the same type into code ranges, in code order", () => {
    const groups = codeGroups([
      acc("210", "income"),
      acc("100", "asset"),
      acc("99", "asset"),
      acc("240", "income"),
      acc("700", "equity"),
    ]);
    expect(groups).toEqual([
      { from: "99", to: "100", type: "asset", count: 2 },
      { from: "210", to: "240", type: "income", count: 2 },
      { from: "700", to: "700", type: "equity", count: 1 },
    ]);
  });
});
