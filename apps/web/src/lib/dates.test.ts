import { describe, expect, it } from "vitest";
import { addDays, formatDate, isFullYear, nextYear, periodEndedLabel, previousYear } from "./dates";

describe("dates", () => {
  it("adds days across months and leap years", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-03-31", 1)).toBe("2025-04-01");
    expect(addDays("2025-01-01", -1)).toBe("2024-12-31");
  });

  it("finds the next and previous standard years", () => {
    expect(nextYear("2025-03-31")).toEqual({ start: "2025-04-01", end: "2026-03-31" });
    expect(nextYear("2023-02-28")).toEqual({ start: "2023-03-01", end: "2024-02-29" });
    expect(previousYear("2025-04-01")).toEqual({ start: "2024-04-01", end: "2025-03-31" });
  });

  it("formats for display", () => {
    expect(formatDate("2026-03-31")).toBe("31 Mar 2026");
    expect(formatDate("2026-09-01")).toBe("1 Sep 2026");
  });
});

describe("period labels", () => {
  it("says year for 12 months and period for anything else", () => {
    expect(isFullYear("2025-04-01", "2026-03-31")).toBe(true);
    expect(isFullYear("2023-03-01", "2024-02-29")).toBe(true);
    expect(isFullYear("2025-08-01", "2026-03-31")).toBe(false);
    expect(isFullYear("2025-04-01", "2026-06-30")).toBe(false);
    expect(periodEndedLabel("2025-04-01", "2026-03-31")).toBe("Year ended 31 Mar 2026");
    expect(periodEndedLabel("2025-08-01", "2026-03-31")).toBe("Period ended 31 Mar 2026");
  });
});
