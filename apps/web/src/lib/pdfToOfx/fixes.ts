/**
 * What a person puts right in a statement after it's read: a line's date, words or money changed, a
 * line taken out or one the reader missed put in, or the opening or closing balance set. The read
 * statement itself never changes; the fixes are laid over it, so each can be undone, and the running
 * balances are checked again over the result.
 *
 * Amounts here are signed as the reader signs them (positive is money in), before any "Swap money in
 * and out": that's only how they're shown.
 */
import { sumCents } from "../money";
import { endBalances, markBalances, type ReadBalance, type ReadLine, type ReadStatement } from "./read";

/** A change to one line as read. Only what's changed is set. */
export interface LineEdit {
  date?: string;
  description?: string;
  amount?: number;
  balance?: number | null;
  /** The person says the date is right, so it's no longer marked as unclear. */
  dateChecked?: true;
  removed?: true;
}

/** A line the statement has but the reader missed. */
export interface AddedLine {
  /** Tells added lines apart; the newest has the highest. */
  key: number;
  /** It goes just before the read line with this index (the count of read lines puts it at the end). */
  before: number;
  date: string;
  description: string;
  amount: number;
  balance: number | null;
}

export interface Fixes {
  /** By the index of the read line. */
  edits: Readonly<Record<number, LineEdit>>;
  added: readonly AddedLine[];
  /** The balance before the first line, as the person sets it. */
  opening?: number;
  /** The balance after the last line, as the person sets it. */
  closing?: number;
}

export const NO_FIXES: Fixes = { edits: {}, added: [] };

/** Which line: a read one by its index, or an added one by its key. */
export type LineRef = { read: number } | { added: number };

export interface FixedLine extends ReadLine {
  ref: LineRef;
  /** The person changed it, or added it. */
  changed: boolean;
  added: boolean;
  /** Taken out: shown so it can be put back, but not in the file. */
  removed: boolean;
}

export interface Fixed {
  /** Every line in statement order, those taken out too. */
  all: FixedLine[];
  /** The lines that go in the file. */
  lines: FixedLine[];
  opening: ReadBalance | null;
  closing: ReadBalance | null;
  /** How many fixes there are. */
  changes: number;
  /** How many lines are still marked: a balance that doesn't follow, or an unclear date. */
  issues: number;
}

export function refKey(ref: LineRef): string {
  return "read" in ref ? `r${ref.read}` : `a${ref.added}`;
}

const hasIssue = (l: ReadLine) => l.balanceOff !== undefined || l.dateUnread === true;

/** The statement with the fixes laid over it, and its running balances checked again. */
export function applyFixes(read: ReadStatement, fixes: Fixes): Fixed {
  const all: FixedLine[] = [];
  const addedBefore = (before: number) => {
    const page = read.lines[Math.min(before, read.lines.length - 1)]?.page ?? 1;
    for (const a of fixes.added.filter((x) => x.before === before).sort((x, y) => x.key - y.key)) {
      all.push({
        page,
        date: a.date,
        description: a.description,
        amount: a.amount,
        balance: a.balance,
        ref: { added: a.key },
        changed: true,
        added: true,
        removed: false,
      });
    }
  };
  read.lines.forEach((l, i) => {
    addedBefore(i);
    const line: FixedLine = { ...l, ref: { read: i }, changed: false, added: false, removed: false };
    const e = fixes.edits[i];
    if (e) {
      if (e.date !== undefined) {
        line.date = e.date;
        delete line.dateUnread;
      }
      if (e.dateChecked) delete line.dateUnread;
      if (e.description !== undefined) line.description = e.description;
      if (e.amount !== undefined) line.amount = e.amount;
      if (e.balance !== undefined) line.balance = e.balance;
      line.removed = e.removed === true;
      line.changed = [e.date, e.description, e.amount, e.balance, e.dateChecked].some((v) => v !== undefined);
    }
    all.push(line);
  });
  addedBefore(read.lines.length);

  const lines = all.filter((l) => !l.removed);
  for (const l of all) if (l.removed) delete l.balanceOff;
  const opening = fixes.opening ?? (read.opening?.printed ? read.opening.amount : null);
  const closing = fixes.closing ?? (read.closing?.printed ? read.closing.amount : null);
  markBalances(lines, opening);
  const ends = endBalances(lines, opening, closing);
  const changes =
    Object.values(fixes.edits).filter((e) => Object.keys(e).length > 0).length +
    fixes.added.length +
    (fixes.opening === undefined ? 0 : 1) +
    (fixes.closing === undefined ? 0 : 1);
  return { all, lines, ...ends, changes, issues: lines.filter(hasIssue).length };
}

/** The fixes with a line changed: a read line's edit merged in, or an added line's fields replaced. */
export function editLine(fixes: Fixes, ref: LineRef, edit: LineEdit): Fixes {
  if ("read" in ref) {
    return { ...fixes, edits: { ...fixes.edits, [ref.read]: { ...fixes.edits[ref.read], ...edit } } };
  }
  if (edit.removed) return { ...fixes, added: fixes.added.filter((a) => a.key !== ref.added) };
  return {
    ...fixes,
    added: fixes.added.map((a) =>
      a.key === ref.added
        ? {
            ...a,
            date: edit.date ?? a.date,
            description: edit.description ?? a.description,
            amount: edit.amount ?? a.amount,
            balance: edit.balance === undefined ? a.balance : edit.balance,
          }
        : a,
    ),
  };
}

/** The fixes with a read line's changes replaced outright (an empty edit undoes them all). */
export function replaceEdit(fixes: Fixes, index: number, edit: LineEdit): Fixes {
  const edits = { ...fixes.edits };
  if (Object.keys(edit).length === 0) delete edits[index];
  else edits[index] = edit;
  return { ...fixes, edits };
}

/** The fixes without any change to this line: a read line as it was read, an added line gone. */
export function undoLine(fixes: Fixes, ref: LineRef): Fixes {
  if ("read" in ref) return replaceEdit(fixes, ref.read, {});
  return { ...fixes, added: fixes.added.filter((a) => a.key !== ref.added) };
}

/** The fixes with a new line put in just after `after`. Returns the new line's key too. */
export function addLineAfter(
  fixes: Fixes,
  after: LineRef,
  line: Omit<AddedLine, "key" | "before">,
): { fixes: Fixes; key: number } {
  const before = "read" in after ? after.read + 1 : (fixes.added.find((a) => a.key === after.added)?.before ?? 0);
  return addLine(fixes, before, line);
}

function addLine(fixes: Fixes, before: number, line: Omit<AddedLine, "key" | "before">): { fixes: Fixes; key: number } {
  const key = Math.max(0, ...fixes.added.map((a) => a.key)) + 1;
  return { fixes: { ...fixes, added: [...fixes.added, { ...line, key, before }] }, key };
}

// ---- Ways to put a marked line right ----

export type SuggestionKind =
  /** The amount was misread: this is what makes the balance follow. */
  | "amount"
  /** The balance was misread. */
  | "balance"
  /** A line the reader missed, of the difference, just before this one. */
  | "missing"
  /** The opening balance is for earlier lines than the file holds (a page missing, say). */
  | "opening"
  /** It isn't a transaction: take it out. */
  | "remove"
  /** The date it has is right. */
  | "dateRight"
  /** It has a neighbour's date. */
  | "date";

export interface Suggestion {
  kind: SuggestionKind;
  /** Cents for the money kinds, an ISO date for the date kinds, null for removing. */
  value: number | string | null;
  fixes: Fixes;
  /** Of the ways offered, the one that leaves the fewest lines marked, when there is one. */
  best: boolean;
}

const balanceIssues = (f: Fixed) => f.lines.filter((l) => l.balanceOff !== undefined).length;

/**
 * Ways to make a line's running balance follow, each tried over the whole statement: only those
 * that leave fewer balances marked are offered, the best first.
 */
export function balanceSuggestions(read: ReadStatement, fixes: Fixes, fixed: Fixed, line: FixedLine): Suggestion[] {
  const off = line.balanceOff;
  if (off === undefined || line.balance === null) return [];
  const at = fixed.lines.indexOf(line);
  const tries: { kind: SuggestionKind; value: number | null; fixes: Fixes }[] = [];
  if (line.amount + off !== 0) {
    tries.push({ kind: "amount", value: line.amount + off, fixes: editLine(fixes, line.ref, { amount: line.amount + off }) });
  }
  tries.push({ kind: "balance", value: line.balance - off, fixes: editLine(fixes, line.ref, { balance: line.balance - off }) });
  if ("read" in line.ref) {
    tries.push({
      kind: "missing",
      value: off,
      fixes: addLine(fixes, line.ref.read, { date: line.date, description: "", amount: off, balance: null }).fixes,
    });
  }
  const balancedBefore = fixed.lines.slice(0, at).some((l) => l.balance !== null);
  if (!balancedBefore && fixed.opening?.printed) {
    const opening = line.balance - sumCents(fixed.lines.slice(0, at + 1).map((l) => l.amount));
    tries.push({ kind: "opening", value: opening, fixes: { ...fixes, opening } });
  }
  // Only when the balance didn't move for it at all, as when a line is printed (or read) twice.
  // Taking out any other marked line would also take its mark away, without putting anything right.
  if (line.amount !== 0 && line.amount === -off) {
    tries.push({ kind: "remove", value: null, fixes: editLine(fixes, line.ref, { removed: true }) });
  }

  const now = balanceIssues(fixed);
  const scored = tries
    .map((t) => ({ ...t, left: balanceIssues(applyFixes(read, t.fixes)) }))
    .filter((t) => t.left < now)
    .sort((a, b) => a.left - b.left);
  const unique = scored.length === 1 || (scored.length > 1 && scored[0]!.left < scored[1]!.left);
  return scored.map(({ kind, value, fixes: f }, i) => ({ kind, value, fixes: f, best: unique && i === 0 && scored.length > 1 }));
}

/** Dates for a line whose date couldn't be read: the one it has, or a neighbour's. */
export function dateSuggestions(fixes: Fixes, fixed: Fixed, line: FixedLine): Suggestion[] {
  if (!line.dateUnread) return [];
  const at = fixed.lines.indexOf(line);
  const out: Suggestion[] = [
    { kind: "dateRight", value: line.date, fixes: editLine(fixes, line.ref, { dateChecked: true }), best: false },
  ];
  const seen = new Set([line.date]);
  for (const near of [fixed.lines[at - 1], fixed.lines[at + 1]]) {
    if (!near || seen.has(near.date)) continue;
    seen.add(near.date);
    out.push({ kind: "date", value: near.date, fixes: editLine(fixes, line.ref, { date: near.date }), best: false });
  }
  return out;
}
