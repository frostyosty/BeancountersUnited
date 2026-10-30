/** ISO dates (`YYYY-MM-DD`) as the server sends them. Calendar arithmetic only, in UTC. */

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function format(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}

/** The usual next year after one ending `end`: the next day, through the same day a year later. */
export function nextYear(end: string): { start: string; end: string } {
  const start = addDays(end, 1);
  const d = parse(start);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return { start, end: addDays(format(d), -1) };
}

/** The year before one starting `start`. */
export function previousYear(start: string): { start: string; end: string } {
  const end = addDays(start, -1);
  const d = parse(start);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return { start: format(d), end };
}

/**
 * The period offered for a client's first year: 1 April two years back to 31 March last year, the
 * usual NZ year just gone. `now` is passed in so callers (and tests) control the clock.
 */
export function defaultFirstYear(now: Date): { start: string; end: string } {
  const y = now.getUTCFullYear();
  return { start: `${y - 2}-04-01`, end: `${y - 1}-03-31` };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `31 Mar 2026`, for display. A fixed table, not the locale, so every machine shows the same. */
export function formatDate(iso: string): string {
  const d = parse(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Whether `start` to `end` is exactly 12 months, such as 1 Apr 2025 to 31 Mar 2026. */
export function isFullYear(start: string, end: string): boolean {
  return nextYear(addDays(start, -1)).end === end;
}

/**
 * "Year ended 31 Mar 2026", or "Period ended 31 Mar 2026" when the period isn't exactly 12 months,
 * such as a business's first year (`docs/domain.md`, "Part years").
 */
export function periodEndedLabel(start: string, end: string): string {
  return `${isFullYear(start, end) ? "Year" : "Period"} ended ${formatDate(end)}`;
}

// ---- The date picker (ui/DateField) ----

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Monday first, as NZ calendars are. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function isoOf(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Year, month (1–12) and day of an ISO date. */
export function partsOf(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Moves by whole months, keeping the day where it fits (31 Jan + 1 month = 28 or 29 Feb). */
export function addMonths(iso: string, months: number): string {
  const { year, month, day } = partsOf(iso);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return isoOf(y, m, Math.min(day, daysInMonth(y, m)));
}

/** The same day and month in another year (29 Feb becomes 28 Feb when it must). */
export function withYear(iso: string, year: number): string {
  const { month, day } = partsOf(iso);
  return isoOf(year, month, Math.min(day, daysInMonth(year, month)));
}

/** Today in the browser's own time zone (where the person is), as an ISO date. */
export function todayIso(now: Date): string {
  return isoOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Keeps `iso` inside `min`…`max` (either may be missing). ISO dates compare as strings. */
export function clampDate(iso: string, min?: string, max?: string): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

/** Monday of the week holding `iso`. */
export function startOfWeek(iso: string): string {
  const weekday = parse(iso).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((weekday + 6) % 7));
}

/** The six weeks shown for a month: 42 ISO dates from the Monday on or before the 1st. */
export function monthGrid(year: number, month: number): string[] {
  const first = startOfWeek(isoOf(year, month, 1));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/** `Tuesday 31 March 2026`, for the picker's heading. */
export function formatLongDate(iso: string): string {
  const d = parse(iso);
  return `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function valid(year: number, month: number, day: number): string | null {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  return day <= daysInMonth(year, month) ? isoOf(year, month, day) : null;
}

function fullYear(text: string): number {
  return text.length === 2 ? 2000 + Number(text) : Number(text);
}

/**
 * A date as someone types it, day first as NZ writes dates: `31/3/2026`, `31-03-26`, `31.3.2026`,
 * `31 Mar 2026`, `31 march 26`, `31032026`, or ISO `2026-03-31`. Null when it isn't a whole, real date.
 */
export function parseDateInput(text: string): string | null {
  const t = text.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\s*[/.\- ]\s*(\d{1,2})\s*[/.\- ]\s*(\d{2}|\d{4})$/.exec(t);
  if (m) return valid(fullYear(m[3]!), Number(m[2]), Number(m[1]));
  m = /^(\d{2})(\d{2})(\d{4})$/.exec(t);
  if (m) return valid(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*([a-z]{3,})\.?,?[\s\-/.]*(\d{2}|\d{4})$/.exec(t);
  if (m) {
    const name = m[2]!;
    const month = MONTH_NAMES.findIndex((full) => full.toLowerCase().startsWith(name)) + 1;
    return month > 0 ? valid(fullYear(m[3]!), month, Number(m[1])) : null;
  }
  return null;
}
