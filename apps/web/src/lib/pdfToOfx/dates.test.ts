import { describe, expect, it } from "vitest";
import { dateOrder, monthNumber, readDateAt, resolveDate, yearBefore } from "./dates";

const read = (text: string) => readDateAt(text.split(" "), 0);
const iso = (text: string, order: "dmy" | "mdy" = "dmy") => {
  const d = read(text);
  return d ? resolveDate(d, order, () => 2026) : null;
};

describe("readDateAt", () => {
  it("reads the ways statements print dates", () => {
    expect(iso("2026-03-12")).toBe("2026-03-12");
    expect(iso("12/03/2026")).toBe("2026-03-12");
    expect(iso("12.03.26")).toBe("2026-03-12");
    expect(iso("12-Mar-2026")).toBe("2026-03-12");
    expect(iso("12MAR26")).toBe("2026-03-12");
    expect(iso("12 Mar 2026 COFFEE")).toBe("2026-03-12");
    expect(iso("12th March, 2026")).toBe("2026-03-12");
    expect(iso("Mar 12, 2026")).toBe("2026-03-12");
    expect(iso("12 Mar")).toBe("2026-03-12");
    expect(iso("12/03")).toBe("2026-03-12");
    expect(iso("03/12/2026", "mdy")).toBe("2026-03-12");
  });

  it("counts the words a date takes, longest reading first", () => {
    expect(read("12 Mar 2026 COFFEE")?.words).toBe(3);
    expect(read("12 Mar COFFEE")?.words).toBe(2);
    expect(read("12 Mar 24 HOUR PHARMACY")).toMatchObject({ words: 3, year: 2024, shortYear: true });
  });

  it("isn't fooled by words that aren't dates", () => {
    expect(read("COFFEE 12 Mar")).toBeNull();
    expect(read("1234")).toBeNull();
    expect(read("32/01/2026")).toBeNull();
    expect(iso("31/02/2026")).toBeNull();
    expect(iso("29/02/2025")).toBeNull();
    expect(iso("29/02/2024")).toBe("2024-02-29");
  });
});

describe("monthNumber", () => {
  it("knows short, long and dotted names", () => {
    expect(["Jan", "MARCH", "Sept.", "sep", "dec,", "Foo"].map(monthNumber)).toEqual([1, 3, 9, 9, 12, 0]);
  });
});

describe("dateOrder", () => {
  const dates = (...texts: string[]) => texts.map((t) => read(t)!);

  it("is day-first unless the dates prove otherwise", () => {
    expect(dateOrder(dates("01/02/2026", "03/04/2026"))).toBe("dmy");
    expect(dateOrder(dates("01/02/2026", "13/02/2026"))).toBe("dmy");
    expect(dateOrder(dates("01/02/2026", "02/13/2026"))).toBe("mdy");
    expect(dateOrder(dates("12 Mar"))).toBe("dmy");
  });
});

describe("yearBefore", () => {
  it("puts a December line on a January statement in the year before", () => {
    const yearFor = yearBefore("2026-01-31");
    expect(yearFor(12, 28)).toBe(2025);
    expect(yearFor(1, 15)).toBe(2026);
    // A month's grace: a line just after the statement ends stays in its year.
    expect(yearFor(2, 20)).toBe(2026);
  });
});
