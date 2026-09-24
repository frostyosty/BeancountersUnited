/**
 * Money in the UI is integer cents (CLAUDE.md hard rule 4). Every parse and format goes through
 * here, and none of it touches floating point: amounts are handled as digit strings.
 */

/** The largest amount we accept, in cents: comfortably inside `Number.MAX_SAFE_INTEGER`. */
export const MAX_CENTS = 999_999_999_999_99;

/**
 * Parses what a person typed into cents, or returns `null` if it isn't an amount.
 *
 * Accepts an optional sign or surrounding brackets for a negative, an optional `$`, thousands
 * commas, and up to two decimal places: `1,234.5`, `-12`, `(40.00)`, `$7.05`. An empty string is
 * `null`; callers decide whether blank means zero.
 */
export function parseMoney(text: string): number | null {
  let s = text.trim().replace(/\s+/g, "");
  if (s === "") {
    return null;
  }
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    if (negative) {
      return null;
    }
    negative = true;
    s = s.slice(1);
  }
  if (s.startsWith("$")) {
    s = s.slice(1);
  }
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === undefined && (m[2] === undefined || m[2] === ""))) {
    return null;
  }
  const dollars = (m[1] ?? "0").replace(/,/g, "");
  const cents = (m[2] ?? "").padEnd(2, "0");
  const digits = (dollars + cents).replace(/^0+(?=\d)/, "");
  if (digits.length > String(MAX_CENTS).length) {
    return null;
  }
  const value = Number(digits);
  if (value > MAX_CENTS) {
    return null;
  }
  return negative && value !== 0 ? -value : value;
}

/**
 * Formats cents as `1,234.56`, with a leading `-` for negatives. Throws on anything that isn't a
 * safe integer, because that means a bug upstream.
 */
export function formatMoney(cents: number): string {
  assertCents(cents);
  const negative = cents < 0;
  const digits = String(Math.abs(cents)).padStart(3, "0");
  const whole = groupThousands(digits.slice(0, -2));
  return `${negative ? "-" : ""}${whole}.${digits.slice(-2)}`;
}

/** Formats a whole-dollar amount as `1,234`, with a leading `-` for negatives. */
export function formatDollars(dollars: number): string {
  assertCents(dollars);
  const negative = dollars < 0;
  return `${negative ? "-" : ""}${groupThousands(String(Math.abs(dollars)))}`;
}

/** Sums cents exactly. */
export function sumCents(amounts: Iterable<number>): number {
  let total = 0;
  for (const a of amounts) {
    assertCents(a);
    total += a;
  }
  assertCents(total);
  return total;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function assertCents(n: number): void {
  if (!Number.isSafeInteger(n)) {
    throw new Error(`not an integer amount: ${n}`);
  }
}
