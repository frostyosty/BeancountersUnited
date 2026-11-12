/**
 * Reads the transactions off a bank or credit card statement, from the text a PDF draws and where
 * it draws it. No AI: every step is a rule, so the same PDF always reads the same way.
 *
 * 1. The text becomes lines of words (`layout.ts`).
 * 2. Each line is split into a leading date (or two: made on, processed on), amounts (`1,234.56`,
 *    `12.00 CR`, `(5.00)`) and the words left over, which describe it.
 * 3. The amounts on dated lines fall into columns by their right edges, since statements
 *    right-align money. The column headings (`Withdrawals`, `Deposits`, `Balance`…) say which is
 *    which; without headings, the running balance does: the rightmost column is the balance when
 *    its changes match the other amounts.
 * 4. Lines are walked top to bottom. A dated line with money is a transaction; the lines just under
 *    it with only words carry on its description; a line with money but no date takes the date
 *    above it, as statements that print each date once do. Opening and closing balances are kept as
 *    balances, and totals are skipped.
 * 5. Signs come from the columns (money out, money in), the marks on the amounts (`-`, `CR`, `DR`)
 *    or, failing those, the running balance. The running balance is then checked line by line.
 */
import { parseStatementAmount, type StatementAmount, sumCents } from "../money";
import { type DateOrder, type DateWords, dateOrder, readDateAt, resolveDate, yearBefore } from "./dates";
import { buildLines, type Line, lineText, type TextRun, type Word } from "./layout";

export type StatementKind = "bank" | "card";

/** One transaction read off the statement. */
export interface ReadLine {
  /** The page it's on, 1-based. */
  page: number;
  /** The date the bank processed it, as an ISO date. */
  date: string;
  /** The date it was made, when the statement prints that as well (cards often do). */
  madeOn?: string;
  description: string;
  /** Signed cents: positive is money in. On a card, a purchase is negative and a payment positive. */
  amount: number;
  /** The running balance printed beside it, signed the same way (an amount owed on a card is negative). */
  balance: number | null;
  /** How far the printed balance is from the balance before it plus this line, when they disagree. */
  balanceOff?: number;
}

export interface ReadBalance {
  /** Signed cents, as `ReadLine.balance`. */
  amount: number;
  /** Printed as an opening or closing balance, or worked out from the running balances. */
  printed: boolean;
}

export interface ReadNote {
  tone: "info" | "warn";
  text: string;
}

export interface ReadStatement {
  /** False for a scan or a photo: there's no text to read, only a picture of it. */
  hasText: boolean;
  kind: StatementKind;
  /** A NZ account number as `BB-bbbb-AAAAAAA-SS`, a card as `XXXX-XXXX-XXXX-1234`, or what the statement calls the account. */
  account: string | null;
  savings: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  opening: ReadBalance | null;
  closing: ReadBalance | null;
  /** Oldest first. */
  lines: ReadLine[];
  /** The year used for dates printed without one, when the statement never says. */
  assumedYear: number | null;
  notes: ReadNote[];
}

export interface ReadOptions {
  /** For dates printed without a year on a statement that never gives one: usually this year. */
  fallbackYear: number;
}

type MoneyRole = "debit" | "credit" | "amount" | "balance";
type Sign = 1 | -1;

// ---- Words on a line ----

interface Amount extends StatementAmount {
  x0: number;
  x1: number;
  /** The word indexes it covers, inclusive. */
  from: number;
  to: number;
}

interface Parsed {
  line: Line;
  dates: DateWords[];
  /** Words taken by the dates, from the start of the line. */
  dateWords: number;
  amounts: Amount[];
}

const CURRENCY =
  /^(USD|US\$|AUD|AU\$|A\$|GBP|EUR|CAD|JPY|SGD|HKD|CHF|CNY|RMB|FJD|THB|INR|IDR|MYR|PHP|KRW|TWD|VND|ZAR|SEK|NOK|DKK|AED|WST|TOP|XPF)$/i;
const SIGN_WORD = /^(CR|DR|OD|[-+])\.?$/i;
const LEAD_WORD = /^([-+]|\$|-\$|NZ\$|NZD)$/;

function readAmounts(words: readonly Word[], from: number): Amount[] {
  const out: Amount[] = [];
  for (let i = from; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    let to = i;
    let parsed: StatementAmount | null = null;
    if (next && (SIGN_WORD.test(next.text) || LEAD_WORD.test(w.text))) {
      parsed = parseStatementAmount(`${w.text} ${next.text}`);
      if (parsed) to = i + 1;
    }
    parsed ??= parseStatementAmount(w.text);
    if (!parsed) continue;
    const before = words[i - 1]?.text ?? "";
    const after = words[to + 1]?.text ?? "";
    // A foreign currency amount or a rate belongs to the description, not a column of money.
    if (!CURRENCY.test(before) && !/^(%|p\.?a\.?)/i.test(after)) {
      out.push({ ...parsed, x0: w.x0, x1: words[to]!.x1, from: i, to });
    }
    i = to;
  }
  return out;
}

function parseLine(line: Line, keepShortYears: boolean): Parsed {
  const texts = line.words.map((w) => w.text);
  const dates: DateWords[] = [];
  let at = 0;
  while (dates.length < 2) {
    let d = readDateAt(texts, at);
    if (!d) break;
    if (d.shortYear && !keepShortYears) d = { ...d, words: d.words - 1, year: null, shortYear: false };
    dates.push(d);
    at += d.words;
  }
  return { line, dates, dateWords: at, amounts: readAmounts(line.words, at) };
}

/** The words that aren't the leading date or an amount. */
function labelWords(p: Parsed): string[] {
  return p.line.words.filter((_, w) => w >= p.dateWords && !p.amounts.some((a) => a.from <= w && w <= a.to)).map((w) => w.text);
}

// ---- Column headings ----

type Role = "date" | "description" | MoneyRole;

function roleOf(cell: string): Role | null {
  const t = cell
    .toLowerCase()
    .replace(/[^a-z/ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 32) return null;
  if (/\bbalance\b/.test(t)) return "balance";
  if (/\bdate\b|^(posted|processed|value|effective|when)$/.test(t)) return "date";
  if (/\b(debits?|withdrawals?|withdrawn|paid out|money out|spent|charges?)\b|^(out|dr|payments?)$/.test(t)) return "debit";
  if (/\b(credits?|deposits?|receipts?|paid in|money in|lodgements?)\b|^(in|cr)$/.test(t)) return "credit";
  if (/\b(amount|nzd)\b/.test(t)) return "amount";
  if (/\b(description|details|particulars|transactions?|narrative|payee|reference|memo|code|type|other party|merchant)\b/.test(t)) {
    return "description";
  }
  return null;
}

interface Heading {
  role: MoneyRole;
  x0: number;
  x1: number;
}

/** The money columns a heading line names, or null when the line isn't a table's headings. */
function headingsOf(p: Parsed): Heading[] | null {
  const cells = p.line.cells;
  if (p.dates.length > 0 || p.amounts.length > 0 || cells.length < 2 || cells.length > 12) return null;
  const roles = cells.map((c) => roleOf(c.text));
  const named = roles.filter((r) => r !== null);
  const money: Heading[] = [];
  cells.forEach((c, i) => {
    const role = roles[i];
    if (role === "debit" || role === "credit" || role === "amount" || role === "balance") money.push({ role, x0: c.x0, x1: c.x1 });
  });
  const enough = named.includes("date") ? named.length >= 2 : named.length >= 3 && money.length >= 2;
  return enough && money.length > 0 && named.length >= 0.6 * roles.length ? money : null;
}

// ---- Balance and summary lines ----

const BALANCE_WORDS =
  /^(opening|closing|balance|bal|brought|carried|forward|fwd|b\/f|c\/f|b\/fwd|c\/fwd|new|previous|last|start|starting|end|ending|at|as|of|on|statement|period|this|the|owing|owed|total|account|nzd|-|–|:)$/i;

type BalanceLabel = "opening" | "closing" | "balance";

/** Whether the words are a balance's label, such as `Opening balance` or `Balance brought forward`, and which. */
function balanceLabel(words: readonly string[]): BalanceLabel | null {
  // Dates in the label ("Closing balance at 31 March 2026") don't change what it is.
  const label = words.filter((w) => !/^[\d$(]|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?$/i.test(w));
  if (label.length === 0 || !label.every((w) => BALANCE_WORDS.test(w.replace(/[.,:]$/, "")))) return null;
  const text = label.join(" ").toLowerCase();
  if (!/balance|\bbal\b|forward|fwd|b\/f|c\/f/.test(text)) return null;
  if (/opening|brought|b\/f|previous|last|start/.test(text)) return "opening";
  if (/closing|carried|c\/f|new|end|owing|owed/.test(text)) return "closing";
  return "balance";
}

/** The balances a line states: each amount whose words before it are a balance's label. */
function balancesOn(p: Parsed): { label: BalanceLabel; amount: Amount }[] {
  const out: { label: BalanceLabel; amount: Amount }[] = [];
  let start = p.dateWords;
  for (const a of p.amounts) {
    const label = balanceLabel(p.line.words.slice(start, a.from).map((w) => w.text));
    if (label) out.push({ label, amount: a });
    start = a.to + 1;
  }
  return out;
}

const TOTAL =
  /^(sub[- ]?)?totals?\b(\s+(of|for|this|the|statement|period|page|debits?|credits?|withdrawals?|deposits?|payments?|purchases?|fees?|charges?|interest|transactions?|amounts?|money|in|out|:))*\s*:?$/i;
const SUMMARY =
  /\bpage \d+( of \d+)?\b|\bcontinued\b|minimum (payment|amount)|payment due|due date|credit limit|available (credit|balance|funds)|interest rate/i;

// ---- Columns of money ----

interface Column {
  /** The right edge its amounts line up on. */
  x1: number;
  /** The leftmost any amount in it reaches. */
  x0: number;
  role: MoneyRole | null;
}

/** Groups amounts into columns by their right edges. A "column" with too few amounts is stray numbers. */
function columnsOf(amounts: readonly Amount[], size: number, rows: number): Column[] {
  const sorted = [...amounts].sort((a, b) => a.x1 - b.x1);
  const groups: Amount[][] = [];
  for (const a of sorted) {
    const g = groups.at(-1);
    if (g && a.x1 - g.at(-1)!.x1 <= size) g.push(a);
    else groups.push([a]);
  }
  const least = rows >= 6 ? Math.max(2, Math.ceil(rows * 0.05)) : 1;
  return groups
    .filter((g) => g.length >= least)
    .map((g) => ({ x1: g.reduce((s, a) => s + a.x1, 0) / g.length, x0: Math.min(...g.map((a) => a.x0)), role: null }));
}

function nearestColumn(columns: readonly Column[], a: Amount, size: number): Column | null {
  let best: Column | null = null;
  let distance = Infinity;
  for (const c of columns) {
    const d = Math.abs(c.x1 - a.x1);
    if (d < distance) {
      best = c;
      distance = d;
    }
  }
  return distance <= 2 * size ? best : null;
}

/** Names each column after the heading over it. */
function nameFromHeadings(columns: readonly Column[], headings: readonly Heading[]): void {
  for (const c of columns) {
    let best: Heading | null = null;
    let score = -Infinity;
    for (const h of headings) {
      const overlap = Math.min(c.x1, h.x1) - Math.max(c.x0, h.x0);
      if (overlap > score) {
        best = h;
        score = overlap;
      }
    }
    // A heading more than a column's width away isn't over this column.
    if (best && score > -(c.x1 - c.x0)) c.role = best.role;
  }
}

/** The ways to sign `sizes` (each + or −) so they add up to `target`, stopping at two. Too many to try gives none. */
function signings(sizes: readonly number[], target: number): Sign[][] {
  if (sizes.length > 16) return [];
  const found: Sign[][] = [];
  const total = 1 << sizes.length;
  for (let mask = 0; mask < total && found.length < 2; mask++) {
    let sum = 0;
    for (let i = 0; i < sizes.length; i++) sum += mask & (1 << i) ? sizes[i]! : -sizes[i]!;
    if (sum === target) found.push(sizes.map((_, i) => (mask & (1 << i) ? 1 : -1)));
  }
  return found;
}

function signedBalance(a: StatementAmount): number {
  return a.sign === "minus" || a.sign === "dr" ? -a.cents : a.cents;
}

/** How many of the balance column's changes the other amounts explain, rows taken in the order given. */
function balanceFits(rows: readonly Map<Column, Amount>[], balance: Column): { tested: number; fits: number } {
  let tested = 0;
  let fits = 0;
  let previous: number | null = null;
  let sizes: number[] = [];
  for (const row of rows) {
    for (const [c, a] of row) if (c !== balance) sizes.push(a.cents);
    const b = row.get(balance);
    if (!b) continue;
    if (previous !== null && sizes.length > 0) {
      tested++;
      if (signings(sizes, signedBalance(b) - previous).length > 0) fits++;
    }
    previous = signedBalance(b);
    sizes = [];
  }
  return { tested, fits };
}

/**
 * With no headings: which column is the running balance, and which hold money out and money in.
 * The rightmost column is the balance when the other amounts explain its changes.
 */
function nameFromBalances(columns: readonly Column[], rows: readonly Map<Column, Amount>[]): void {
  const sorted = [...columns].sort((a, b) => a.x1 - b.x1);
  const last = sorted.at(-1);
  if (!last) return;
  if (sorted.length === 1) {
    last.role = "amount";
    return;
  }
  // Either way round, as a statement may list the newest first.
  const down = balanceFits(rows, last);
  const up = balanceFits([...rows].reverse(), last);
  const best = up.fits > down.fits ? up : down;
  const others = best.tested >= 2 && best.fits >= 0.6 * best.tested ? sorted.slice(0, -1) : sorted;
  if (others.length < sorted.length) last.role = "balance";
  if (others.length === 1) {
    others[0]!.role = "amount";
  } else {
    // Money out is printed before money in.
    const [out, into] = others.slice(-2);
    out!.role = "debit";
    into!.role = "credit";
  }
}

// ---- What the statement says about itself ----

/** A card statement says at least two of these; a bank statement rarely says any. */
const CARD_SIGNS = [
  /credit card/i,
  /minimum (payment|amount|repayment)/i,
  /credit limit/i,
  /available credit/i,
  /(payment|amount) due|due date/i,
  /purchases/i,
];

function cardMask(text: string): string | null {
  const m =
    /(?<!\d)(?:\d{4}|[X*•x]{4})[ -]?(?:\d{4}|[X*•x]{4})[ -]?(?:\d{4}|[X*•x]{2,6})[ -]?(\d{4})(?!\d)/.exec(text) ??
    /\bending(?: in)?:? (\d{4})\b/i.exec(text);
  return m ? `XXXX-XXXX-XXXX-${m[1]}` : null;
}

/** A NZ bank account number in `BB-bbbb-AAAAAAA-SS` form, as the rest of the app keeps them. */
export function nzAccount(text: string): string | null {
  const m = /(?<!\d)(\d{2})[- ](\d{4})[- ](\d{7,8})[- ](\d{2,3})(?!\d)/.exec(text);
  if (!m) return null;
  const shorten = (s: string, width: number) => (s.length === width + 1 && s.startsWith("0") ? s.slice(1) : s);
  const base = shorten(m[3]!, 7);
  const suffix = shorten(m[4]!, 2);
  return base.length === 7 && suffix.length === 2 ? `${m[1]}-${m[2]}-${base}-${suffix}` : null;
}

function accountOf(text: string, kind: StatementKind): string | null {
  if (kind === "card") return cardMask(text) ?? nzAccount(text);
  const named = /\b(?:account|acct|a\/c)\s*(?:number|no\.?|#)?\s*:?\s*(\d[\d -]{4,24}\d)(?!\d)/i.exec(text);
  return nzAccount(text) ?? named?.[1]?.replace(/\s+/g, " ") ?? null;
}

/** The period a statement says it covers: two full dates with `to`, a dash or `until` between them. */
function periodOf(lines: readonly Line[], order: DateOrder): { start: string; end: string } | null {
  for (const line of lines) {
    const texts = line.words.map((w) => w.text);
    for (let i = 0; i < texts.length; i++) {
      const a = readDateAt(texts, i);
      if (!a?.year || a.shortYear) continue;
      const joiner = texts[i + a.words]?.toLowerCase();
      if (!joiner || !/^(to|-|–|—|until|through|thru)$/.test(joiner)) continue;
      const b = readDateAt(texts, i + a.words + 1);
      if (!b?.year || b.shortYear) continue;
      const start = resolveDate(a, order, () => a.year!);
      const end = resolveDate(b, order, () => b.year!);
      if (start && end && start <= end) return { start, end };
    }
  }
  return null;
}

/** The latest date with a year printed anywhere on the statement, ignoring any after `notAfterYear`. */
function latestDate(lines: readonly Line[], order: DateOrder, notAfterYear: number): string | null {
  let latest: string | null = null;
  for (const line of lines) {
    const texts = line.words.map((w) => w.text);
    for (let i = 0; i < texts.length; i++) {
      const d = readDateAt(texts, i);
      if (!d?.year || d.shortYear || d.year > notAfterYear) continue;
      const iso = resolveDate(d, order, () => d.year!);
      if (iso && (latest === null || iso > latest)) latest = iso;
    }
  }
  return latest;
}

function mode(values: readonly number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  for (const [v, n] of counts) if (best === null || n > counts.get(best)!) best = v;
  return best;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Whether a short two-digit word after a date (`12 Mar 26`) is its year across this statement. */
function shortYearsAreYears(dates: readonly DateWords[]): boolean {
  const long = dates.filter((d) => d.year !== null && !d.shortYear).map((d) => d.year!);
  const short = dates.filter((d) => d.shortYear).map((d) => d.year!);
  const none = dates.filter((d) => d.year === null).length;
  const usual = mode(long.length > 0 ? long : short);
  return (
    short.length > 0 && none < short.length && usual !== null && short.filter((y) => Math.abs(y - usual) <= 1).length >= 0.8 * short.length
  );
}

// ---- Putting it together ----

interface Draft {
  page: number;
  /** Its own dates, or the ones carried down from the line above when it's printed without one. */
  dates: DateWords[];
  words: string[];
  money: Partial<Record<MoneyRole, Amount>>;
}

function nothing(hasText: boolean, note: ReadNote, rest: Partial<ReadStatement> = {}): ReadStatement {
  return {
    hasText,
    kind: "bank",
    account: null,
    savings: false,
    periodStart: null,
    periodEnd: null,
    opening: null,
    closing: null,
    lines: [],
    assumedYear: null,
    notes: [note],
    ...rest,
  };
}

export function readStatement(runs: readonly TextRun[], options: ReadOptions): ReadStatement {
  const letters = runs.reduce((n, r) => n + (r.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
  if (letters < 20) {
    return nothing(false, {
      tone: "warn",
      text: "This PDF has no text in it, only a picture of the page: it's probably a scan or a photo. Download the statement from your internet banking instead.",
    });
  }
  const lines = buildLines(runs);
  const allText = lines.map(lineText).join("\n");
  const firstPages = lines
    .filter((l) => l.page <= 2)
    .map(lineText)
    .join("\n");
  const kind: StatementKind = CARD_SIGNS.filter((r) => r.test(allText)).length >= 2 ? "card" : "bank";
  const account = accountOf(firstPages, kind) ?? accountOf(allText, kind);
  const notes: ReadNote[] = [];

  // Dates first: which way round they go, and whether a two-digit word after a date is its year.
  const firstPass = lines.map((l) => parseLine(l, true));
  const leading = firstPass.flatMap((p) => p.dates);
  const order = dateOrder(leading);
  const parsed = shortYearsAreYears(leading) ? firstPass : lines.map((l) => parseLine(l, false));

  // Table headings, and which lines sit under them. On a page with headings, what's above them
  // (addresses, summaries) isn't the table.
  const headings = parsed.map(headingsOf);
  const pagesWithHeadings = new Set(parsed.filter((_, i) => headings[i]).map((p) => p.line.page));
  const underHeading: boolean[] = [];
  let page = 0;
  let seen = false;
  parsed.forEach((p, i) => {
    if (p.line.page !== page) {
      page = p.line.page;
      seen = !pagesWithHeadings.has(page);
    }
    if (headings[i]) seen = true;
    underHeading.push(seen && !headings[i]);
  });

  // Columns of money, from the lines that look like transactions.
  const rows = parsed.filter((p, i) => {
    if (!underHeading[i] || p.dates.length === 0 || p.amounts.length === 0 || balancesOn(p).length > 0) return false;
    return !TOTAL.test(labelWords(p).join(" ")) && !SUMMARY.test(lineText(p.line));
  });
  const size = median(rows.map((p) => p.line.size)) || median(lines.map((l) => l.size)) || 10;
  const columns = columnsOf(
    rows.flatMap((p) => p.amounts),
    size,
    rows.length,
  );
  const lastHeadings = headings.filter((h) => h !== null).at(-1);
  if (lastHeadings) nameFromHeadings(columns, lastHeadings);
  if (columns.every((c) => c.role === null)) {
    nameFromBalances(
      columns,
      rows.map((p) => {
        const row = new Map<Column, Amount>();
        for (const a of p.amounts) {
          const c = nearestColumn(columns, a, size);
          if (c) row.set(c, a);
        }
        return row;
      }),
    );
  }

  // Where dates end and money starts, for telling a table's lines from the rest of the page.
  const dateRight = median(rows.map((p) => p.line.words[p.dateWords - 1]!.x1));
  const moneyLeft = Math.min(Infinity, ...columns.filter((c) => c.role).map((c) => c.x0));

  // Walk the lines.
  const drafts: Draft[] = [];
  let open: Draft | null = null; // the transaction the next lines may carry on
  let pending: Draft | null = null; // a dated line whose money may be on the line below
  let lastDates: DateWords[] | null = null;
  let opening: StatementAmount | null = null;
  let closing: StatementAmount | null = null;
  let last = { page: 0, y: 0 }; // the last line that was part of the table

  parsed.forEach((p, i) => {
    const line = p.line;
    const near = (limit: number) => last.page === line.page && line.y - last.y <= limit * line.size;
    const money: Partial<Record<MoneyRole, Amount>> = {};
    const used = new Set<number>();
    for (const a of p.amounts) {
      const role = nearestColumn(columns, a, size)?.role;
      if (!role) continue;
      money[role] = a;
      for (let w = a.from; w <= a.to; w++) used.add(w);
    }

    // Balances count wherever they're printed, even in a summary above the table.
    const stated = balancesOn(p);
    if (stated.length > 0) {
      for (const { label, amount } of stated) {
        const value = stated.length === 1 ? (money.balance ?? amount) : amount;
        const isOpening = label === "opening" || (label === "balance" && underHeading[i] && drafts.length === 0 && !pending);
        if (isOpening) {
          if (drafts.length === 0) opening ??= value;
        } else if (label === "closing" || underHeading[i]) {
          closing = value;
        }
      }
      open = pending = null;
      if (underHeading[i]) last = { page: line.page, y: line.y };
      return;
    }
    if (headings[i]) {
      open = pending = null;
      last = { page: line.page, y: line.y };
      return;
    }
    if (!underHeading[i]) return;

    const words = line.words.filter((_, w) => w >= p.dateWords && !used.has(w)).map((w) => w.text);
    if (TOTAL.test(words.join(" ")) || SUMMARY.test(lineText(line))) {
      open = pending = null;
      return;
    }
    const hasMoney = Object.keys(money).length > 0;

    if (p.dates.length > 0) {
      lastDates = p.dates;
      const draft: Draft = { page: line.page, dates: p.dates, words, money };
      if (hasMoney) {
        drafts.push(draft);
        open = draft;
        pending = null;
      } else {
        pending = draft;
        open = null;
      }
      last = { page: line.page, y: line.y };
      return;
    }

    const startsAfterDates = (line.words[0]?.x0 ?? 0) >= dateRight - 0.2 * size;
    if (hasMoney) {
      if (pending && near(3)) {
        // The date and description on one line, the money on the next.
        pending.words.push(...words);
        pending.money = money;
        drafts.push(pending);
        open = pending;
        pending = null;
      } else if (lastDates && startsAfterDates && words.length > 0 && near(4)) {
        // Printed without a date: the date above it carries down.
        const draft: Draft = { page: line.page, dates: lastDates, words, money };
        drafts.push(draft);
        open = draft;
      } else {
        open = null;
        return;
      }
      last = { page: line.page, y: line.y };
      return;
    }

    // Words only: more of the description above, when it's just under it and in the description column.
    const target = open ?? pending;
    if (target && words.length > 0 && startsAfterDates && (line.words[0]?.x0 ?? 0) < moneyLeft && near(2.2)) {
      target.words.push(...words);
      last = { page: line.page, y: line.y };
    } else {
      open = null;
      if (!near(2.2)) pending = null;
    }
  });

  if (drafts.length === 0) {
    return nothing(
      true,
      {
        tone: "warn",
        text: "We couldn't find any transactions in this PDF. It needs a table of dated lines with amounts, as statements from internet banking have.",
      },
      { kind, account },
    );
  }

  // Years: from the period the statement states, or the latest full date on it.
  const period = periodOf(lines, order);
  const latest = period?.end ?? latestDate(lines, order, options.fallbackYear + 1);
  const needsYear = drafts.some((d) => d.dates.some((x) => x.year === null));
  const assumedYear = needsYear && !latest ? options.fallbackYear : null;
  const yearFor = yearBefore(latest ?? `${options.fallbackYear}-12-31`);
  if (assumedYear !== null) {
    notes.push({
      tone: "warn",
      text: `The statement doesn't say which year its dates are in, so we've used ${assumedYear}. Change it if that's wrong.`,
    });
  }

  const dated: { draft: Draft; date: string; madeOn?: string }[] = [];
  let unreadable = 0;
  for (const draft of drafts) {
    const isos = draft.dates
      .map((d) => resolveDate(d, order, yearFor))
      .filter((d) => d !== null)
      .sort();
    const date = isos.at(-1);
    if (!date) {
      unreadable++;
    } else {
      dated.push(isos.length > 1 && isos[0] !== date ? { draft, date, madeOn: isos[0]! } : { draft, date });
    }
  }
  if (unreadable > 0) {
    notes.push({
      tone: "warn",
      text:
        unreadable === 1
          ? "One line has a date we couldn't read, so it's left out."
          : `${unreadable} lines have dates we couldn't read, so they're left out.`,
    });
  }
  // A statement that lists the newest first is turned round.
  if (dated.length > 1 && dated[0]!.date > dated.at(-1)!.date) dated.reverse();

  // Signs. Money-out and money-in columns sign themselves, as do amounts marked -, CR or DR. An
  // unmarked amount is the opposite of the marked ones.
  const marks = dated.flatMap(({ draft }) => (draft.money.amount ? [draft.money.amount.sign] : []));
  const minus = marks.filter((s) => s === "minus" || s === "dr").length;
  const plus = marks.filter((s) => s === "plus" || s === "cr").length;
  const plain: Sign | null = minus > 0 ? 1 : plus > 0 ? -1 : null;
  const columnsSign = dated.some(({ draft }) => draft.money.debit || draft.money.credit);
  const unsigned = plain === null && !columnsSign;
  const signOf = (a: Amount): number =>
    a.sign === "minus" || a.sign === "dr" ? -a.cents : a.sign === "plus" || a.sign === "cr" ? a.cents : (plain ?? 1) * a.cents;
  const amounts = dated.map(({ draft: { money } }) =>
    sumCents([money.credit?.cents ?? 0, -(money.debit?.cents ?? 0), money.amount ? signOf(money.amount) : 0]),
  );
  // Most of what happens on a card is spending: a card statement that prints purchases as plain
  // amounts and payments with a minus is turned round, so purchases are money out.
  if (kind === "card" && !unsigned && amounts.filter((a) => a > 0).length > amounts.filter((a) => a < 0).length) {
    amounts.forEach((a, i) => (amounts[i] = -a));
  }
  const balances = dated.map(({ draft }) => (draft.money.balance ? signedBalance(draft.money.balance) : null));
  const openingRaw = opening ? signedBalance(opening) : null;
  const closingRaw = closing ? signedBalance(closing) : null;

  // Which way the balances run. A card's balance is usually what's owed, so it climbs with
  // spending: that's money out of the holder's pocket, and its balance is negative to them.
  let flip: Sign = kind === "card" ? -1 : 1;
  let guessed = false;
  if (unsigned) {
    // Plain amounts in one column: the balances say which way each went.
    let previous = openingRaw === null ? null : flip * openingRaw;
    let group: number[] = [];
    const settle = (target: number | null) => {
      const found = previous !== null && target !== null ? signings(group.map((i) => amounts[i]!), target - previous) : [];
      if (found.length === 1) group.forEach((idx, k) => (amounts[idx] = found[0]![k]! * amounts[idx]!));
      else if (group.length > 0) {
        guessed = true;
        if (kind === "card") group.forEach((idx) => (amounts[idx] = -amounts[idx]!));
      }
      group = [];
    };
    amounts.forEach((_, i) => {
      group.push(i);
      const b = balances[i];
      if (b === null || b === undefined) return;
      settle(flip * b);
      previous = flip * b;
    });
    if (group.length > 0) settle(closingRaw === null ? null : flip * closingRaw);
  } else {
    const fit = (f: Sign) => {
      let score = 0;
      let previous = openingRaw === null ? null : f * openingRaw;
      let run = 0;
      amounts.forEach((a, i) => {
        run += a;
        const b = balances[i];
        if (b === null || b === undefined) return;
        if (previous !== null) score += previous + run === f * b ? 1 : -1;
        previous = f * b;
        run = 0;
      });
      if (closingRaw !== null && previous !== null) score += previous + run === f * closingRaw ? 1 : -1;
      return score;
    };
    const other: Sign = flip === 1 ? -1 : 1;
    if (fit(other) > fit(flip)) flip = other;
  }
  if (guessed) {
    notes.push({
      tone: "warn",
      text: "The statement doesn't show which amounts are money in and which are money out, so some are guesses. Check them, and use Swap money in and out if they're the wrong way round.",
    });
  }

  // The lines, and the running balance checked line by line.
  const out: ReadLine[] = dated.map(({ draft, date, madeOn }, i) => {
    const b = balances[i];
    const line: ReadLine = {
      page: draft.page,
      date,
      description: draft.words.join(" ").replace(/\s+/g, " ").trim(),
      amount: amounts[i]!,
      balance: b === null || b === undefined ? null : flip * b,
    };
    if (madeOn) line.madeOn = madeOn;
    return line;
  });
  let previous: number | null = openingRaw === null ? null : flip * openingRaw;
  let run = 0;
  for (const line of out) {
    run += line.amount;
    if (line.balance === null) continue;
    if (previous !== null && previous + run !== line.balance) line.balanceOff = line.balance - (previous + run);
    previous = line.balance;
    run = 0;
  }
  const off = out.filter((l) => l.balanceOff !== undefined).length;
  if (off > 0) {
    notes.push({
      tone: "warn",
      text:
        off === 1
          ? "One running balance doesn't follow from the line before. That line is marked: check it against the PDF."
          : `${off} running balances don't follow from the line before. Those lines are marked: check them against the PDF.`,
    });
  }

  // Opening and closing balances: as printed, or worked out from the running balance.
  let openingBalance: ReadBalance | null = openingRaw === null ? null : { amount: flip * openingRaw, printed: true };
  const firstWithBalance = out.findIndex((l) => l.balance !== null);
  if (!openingBalance && firstWithBalance >= 0) {
    openingBalance = {
      amount: out[firstWithBalance]!.balance! - sumCents(out.slice(0, firstWithBalance + 1).map((l) => l.amount)),
      printed: false,
    };
  }
  const lastLine = out.at(-1)!;
  const closingBalance: ReadBalance | null =
    closingRaw !== null
      ? { amount: flip * closingRaw, printed: true }
      : lastLine.balance !== null
        ? { amount: lastLine.balance, printed: false }
        : null;

  const dates = out.map((l) => l.date).sort();
  return {
    hasText: true,
    kind,
    account,
    savings: /\b(savings?|saver|on call|term deposit)\b/i.test(firstPages),
    periodStart: period?.start ?? dates[0]!,
    periodEnd: period?.end ?? dates.at(-1)!,
    opening: openingBalance,
    closing: closingBalance,
    lines: out,
    assumedYear,
    notes,
  };
}
