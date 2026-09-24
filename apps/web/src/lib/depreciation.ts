import type { DepreciationSettings } from "@acct/types/DepreciationSettings";
import { formatRate, parseRate } from "./rates";

/**
 * Depreciation settings as a form edits them: every field kept, as typed, so switching method
 * back and forth doesn't lose what was entered. `toSettings` checks and converts.
 */
export type SettingsDraft = {
  method: "dv" | "sl" | "none";
  slBasis: "rate" | "life";
  rate: string;
  lifeMonths: string;
  partYear: "months_held" | "daily" | "full_year";
  countAcquisitionMonth: boolean;
  disposalYear: "none" | "to_disposal_date";
};

/** A new class's starting point: DV (`docs/domain.md`, Depreciation), months held. */
export const DEFAULT_DRAFT: SettingsDraft = {
  method: "dv",
  slBasis: "rate",
  rate: "",
  lifeMonths: "",
  partYear: "months_held",
  countAcquisitionMonth: true,
  disposalYear: "to_disposal_date",
};

export function toDraft(s: DepreciationSettings): SettingsDraft {
  const d: SettingsDraft = { ...DEFAULT_DRAFT, method: s.method.kind, disposalYear: s.disposal_year, partYear: s.part_year.kind };
  if (s.part_year.kind === "months_held") {
    d.countAcquisitionMonth = s.part_year.count_acquisition_month;
  }
  if (s.method.kind === "dv") {
    d.rate = formatRate(s.method.rate_bp).replace(/%$/, "");
  } else if (s.method.kind === "sl") {
    d.slBasis = s.method.basis.kind;
    if (s.method.basis.kind === "rate") {
      d.rate = formatRate(s.method.basis.rate_bp).replace(/%$/, "");
    } else {
      d.lifeMonths = String(s.method.basis.months);
    }
  }
  return d;
}

/** The settings a draft describes, or a message saying what's wrong with it. */
export function toSettings(d: SettingsDraft): DepreciationSettings | string {
  const part_year: DepreciationSettings["part_year"] =
    d.partYear === "months_held" ? { kind: "months_held", count_acquisition_month: d.countAcquisitionMonth } : { kind: d.partYear };
  const rest = { part_year, disposal_year: d.disposalYear };
  if (d.method === "none") {
    return { method: { kind: "none" }, ...rest };
  }
  if (d.method === "sl" && d.slBasis === "life") {
    const months = /^\d{1,4}$/.test(d.lifeMonths.trim()) ? Number(d.lifeMonths.trim()) : 0;
    if (months < 1 || months > 1200) {
      return "Enter a useful life of 1 to 1,200 months.";
    }
    return { method: { kind: "sl", basis: { kind: "life", months } }, ...rest };
  }
  const rate_bp = parseRate(d.rate);
  if (rate_bp === null) {
    return "Enter a rate between 0.01% and 100%, with at most two decimal places.";
  }
  return d.method === "dv"
    ? { method: { kind: "dv", rate_bp }, ...rest }
    : { method: { kind: "sl", basis: { kind: "rate", rate_bp } }, ...rest };
}

/** A short description, such as "DV 15%" or "SL over 36 months". */
export function describeMethod(s: DepreciationSettings): string {
  const m = s.method;
  switch (m.kind) {
    case "none":
      return "Not depreciated";
    case "dv":
      return `DV ${formatRate(m.rate_bp)}`;
    case "sl":
      return m.basis.kind === "rate" ? `SL ${formatRate(m.basis.rate_bp)}` : `SL over ${m.basis.months} months`;
  }
}

/** The conventions in words. */
export function describeConventions(s: DepreciationSettings): string {
  const part =
    s.part_year.kind === "months_held"
      ? s.part_year.count_acquisition_month
        ? "months held, counting the month of acquisition"
        : "months held, from the month after acquisition"
      : s.part_year.kind === "daily"
        ? "days held"
        : "a full year in the year of acquisition";
  const disposal = s.disposal_year === "none" ? "none in the year of disposal" : "to the disposal date";
  return `${part}; ${disposal}`;
}
