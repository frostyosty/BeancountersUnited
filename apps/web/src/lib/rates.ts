/**
 * Depreciation rates in the UI are integer basis points (12.5% = 1250), like the server's
 * `rate_bp` (CLAUDE.md hard rule 4). Parsing and formatting work on digit strings, never floats.
 */

/** The highest rate: 100%. */
export const MAX_RATE_BP = 10_000;

/**
 * Parses a percentage such as `12.5`, `12.5%` or `33.33` into basis points, or `null` if it isn't
 * a rate between 0.01% and 100% with at most two decimal places.
 */
export function parseRate(text: string): number | null {
  const s = text.trim().replace(/%$/, "").trim();
  const m = /^(\d{1,3})?(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === undefined && (m[2] === undefined || m[2] === ""))) {
    return null;
  }
  const bp = Number((m[1] ?? "0") + (m[2] ?? "").padEnd(2, "0"));
  return bp >= 1 && bp <= MAX_RATE_BP ? bp : null;
}

/** Formats basis points as a percentage without trailing zeros: 1250 → `12.5%`, 1500 → `15%`. */
export function formatRate(bp: number): string {
  if (!Number.isSafeInteger(bp) || bp < 0) {
    throw new Error(`not a rate in basis points: ${bp}`);
  }
  const digits = String(bp).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const frac = digits.slice(-2).replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}%`;
}
