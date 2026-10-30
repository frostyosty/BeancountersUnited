import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  clampDate,
  defaultFirstYear,
  formatDate,
  formatLongDate,
  isFullYear,
  monthGrid,
  nextYear,
  parseDateInput,
  periodEndedLabel,
  previousYear,
  withYear,
} from "./dates";

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

describe("defaultFirstYear", () => {
  it("is 1 April two years back to 31 March last year", () => {
    expect(defaultFirstYear(new Date("2026-10-28T00:00:00Z"))).toEqual({ start: "2024-04-01", end: "2025-03-31" });
  });
});

describe("date picker helpers", () => {
  it("reads dates the way NZ people type them, day first", () => {
    expect(parseDateInput("31/3/2026")).toBe("2026-03-31");
    expect(parseDateInput("31-03-26")).toBe("2026-03-31");
    expect(parseDateInput("1.4.2025")).toBe("2025-04-01");
    expect(parseDateInput(" 31 Mar 2026 ")).toBe("2026-03-31");
    expect(parseDateInput("1st april 25")).toBe("2025-04-01");
    expect(parseDateInput("31032026")).toBe("2026-03-31");
    expect(parseDateInput("2026-03-31")).toBe("2026-03-31");
  });

  it("rejects dates that are partial or don't exist", () => {
    expect(parseDateInput("")).toBeNull();
    expect(parseDateInput("31/3")).toBeNull();
    expect(parseDateInput("2024-10-0")).toBeNull();
    expect(parseDateInput("31/4/2026")).toBeNull();
    expect(parseDateInput("29/2/2025")).toBeNull();
    expect(parseDateInput("29/2/2024")).toBe("2024-02-29");
    expect(parseDateInput("3 smarch 2026")).toBeNull();
  });

  it("moves by months and years, keeping the day where it fits", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonths("2025-12-15", 1)).toBe("2026-01-15");
    expect(withYear("2024-02-29", 2025)).toBe("2025-02-28");
    expect(clampDate("2026-05-01", "2025-04-01", "2026-03-31")).toBe("2026-03-31");
  });

  it("lays a month out as six Monday-first weeks", () => {
    const grid = monthGrid(2026, 3); // 1 Mar 2026 is a Sunday
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe("2026-02-23");
    expect(grid[6]).toBe("2026-03-01");
    expect(formatLongDate("2026-03-31")).toBe("Tuesday 31 March 2026");
  });
});
