import type { DepreciationSettings } from "@acct/types/DepreciationSettings";
import { describe, expect, it } from "vitest";
import { DEFAULT_DRAFT, describeConventions, describeMethod, toDraft, toSettings } from "./depreciation";

const dv15: DepreciationSettings = {
  method: { kind: "dv", rate_bp: 1500 },
  part_year: { kind: "months_held", count_acquisition_month: true },
  disposal_year: "to_disposal_date",
};

describe("depreciation settings drafts", () => {
  it("round-trips settings", () => {
    const life: DepreciationSettings = {
      method: { kind: "sl", basis: { kind: "life", months: 36 } },
      part_year: { kind: "daily" },
      disposal_year: "none",
    };
    for (const s of [dv15, life]) {
      expect(toSettings(toDraft(s))).toEqual(s);
    }
  });

  it("defaults new classes to DV and explains bad input", () => {
    expect(DEFAULT_DRAFT.method).toBe("dv");
    expect(toSettings({ ...DEFAULT_DRAFT, rate: "" })).toMatch(/rate/);
    expect(toSettings({ ...DEFAULT_DRAFT, method: "sl", slBasis: "life", lifeMonths: "0" })).toMatch(/life/);
    expect(toSettings({ ...DEFAULT_DRAFT, method: "sl", rate: "33.33" })).toEqual({
      ...dv15,
      method: { kind: "sl", basis: { kind: "rate", rate_bp: 3333 } },
    });
  });

  it("describes settings in words", () => {
    expect(describeMethod(dv15)).toBe("DV 15%");
    expect(describeConventions(dv15)).toBe("months held, counting the month of acquisition; to the disposal date");
  });
});
