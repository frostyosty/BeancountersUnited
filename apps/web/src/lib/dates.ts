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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `31 Mar 2026`, for display. A fixed table, not the locale, so every machine shows the same. */
export function formatDate(iso: string): string {
  const d = parse(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
