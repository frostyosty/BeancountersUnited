import type { AccountFindings } from "@acct/types/AccountFindings";
import type { Command } from "@acct/types/Command";
import type { EvidenceJournal } from "@acct/types/EvidenceJournal";
import type { EvidenceLine } from "@acct/types/EvidenceLine";
import type { EvidenceStatement } from "@acct/types/EvidenceStatement";
import type { Finding } from "@acct/types/Finding";
import type { FindingKind } from "@acct/types/FindingKind";
import type { Me } from "@acct/types/Me";
import type { SuggestedFix } from "@acct/types/SuggestedFix";
import { can, isOwner } from "../../auth";
import { formatDate } from "../../lib/dates";
import { lineDescription } from "../../lib/lines";
import { formatMoney } from "../../lib/money";

/** `$45.20`, or `−$45.20` for money out. */
export function signedDollars(cents: number): string {
  return `${cents < 0 ? "−" : ""}$${formatMoney(Math.abs(cents))}`;
}

/** A line as the owner would know it: `3 Mar 2026 COUNTDOWN AUCKLAND −$45.20`. */
export function lineWords(l: EvidenceLine): string {
  return `${formatDate(l.date)} ${lineDescription(l.description)} ${signedDollars(l.amount)}`;
}

function journalWords(j: EvidenceJournal): string {
  return `“${j.narration}” on ${formatDate(j.date)} (${signedDollars(j.amount)})`;
}

/** What a finding points at, in its own order, as far as the server sent them. */
export function linesOf(f: Finding, x: AccountFindings): EvidenceLine[] {
  return f.evidence.flatMap((e) => (e.kind === "bank_line" ? x.lines.filter((l) => l.bank_line_id === e.bank_line_id) : []));
}

function journalsOf(f: Finding, x: AccountFindings): EvidenceJournal[] {
  return f.evidence.flatMap((e) => (e.kind === "journal" ? x.journals.filter((j) => j.journal_id === e.journal_id) : []));
}

function statementOf(f: Finding, x: AccountFindings): EvidenceStatement | undefined {
  for (const e of f.evidence) {
    if (e.kind === "statement") {
      return x.statements.find((s) => s.statement_id === e.statement_id);
    }
  }
  return undefined;
}

function gapOf(f: Finding): { start: string; end: string } | undefined {
  for (const e of f.evidence) {
    if (e.kind === "gap") {
      return { start: e.start, end: e.end };
    }
  }
  return undefined;
}

const lines = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));

/** One finding in plain English: what we think happened, then what to do about it. */
export interface FindingText {
  headline: string;
  detail: string;
}

/** The words for a finding, one template per kind. */
export function findingText(f: Finding, x: AccountFindings): FindingText {
  const ls = linesOf(f, x);
  const first = ls[0];
  const firstLine = first ? lineWords(first) : "A line";
  const statement = statementOf(f, x);
  const file = statement?.file_name ?? "A statement";
  const opening = x.opening === null ? "none" : signedDollars(x.opening);
  switch (f.kind) {
    case "duplicate": {
      if (f.fix?.kind === "remove_statement") {
        const n = ls.length;
        return {
          headline: `${lines(n, "This line looks", "These # lines look")} like ${n === 1 ? "it was" : "they were"} uploaded twice: everything in ${file} is already in your books.`,
          detail: `Removing ${file} takes ${n === 1 ? "it" : "them"} out again.`,
        };
      }
      return {
        headline: "This line looks like it was uploaded twice.",
        detail:
          f.fix?.kind === "mark_duplicate"
            ? "It's in two of your files. Marking the second one as a duplicate takes it out of your books once."
            : "It's in two of your files, but it wasn't flagged when it was uploaded, so there's no button for it. Your accountant can take it out with a journal, or you can remove the file it came in and upload a fresh download.",
      };
    }
    case "missing_lines": {
      const gap = gapOf(f);
      if (gap && f.explains === 0) {
        const filled = journalsOf(f, x)[0];
        return {
          headline: `No statement for ${formatDate(gap.start)} to ${formatDate(gap.end)}.`,
          detail: `We put the change${filled ? `, ${signedDollars(filled.amount)},` : ""} in as one entry. Upload that statement and its own lines go in instead.`,
        };
      }
      if (gap) {
        return {
          headline: `No statement covers ${formatDate(gap.start)} to ${formatDate(gap.end)}.`,
          detail: "Your books are missing what happened on those days. Upload the statement for them.",
        };
      }
      return {
        headline: `${file} looks cut short.`,
        detail: "Its own balances don't follow from its lines, so some may not have downloaded. Download it from your bank again and upload it.",
      };
    }
    case "wrong_opening_balance": {
      const meant = f.fix?.kind === "set_opening_balance" ? signedDollars(f.fix.amount) : null;
      return {
        headline: "The opening balance looks wrong.",
        detail: meant
          ? `You entered ${opening}, but your bank's statements start from ${meant}. Changing it starts your books where your bank does.`
          : "Your books are out by the same amount from the very first balance your bank gives.",
      };
    }
    case "sign_reversed":
      if (statement && f.fix?.kind === "remove_statement") {
        return {
          headline: `${file} looks like it was read the wrong way round: money in as money out, and the other way.`,
          detail: `Remove it, then upload it again.`,
        };
      }
      return {
        headline: `${firstLine} looks like it was read the wrong way round.`,
        detail: "Money in was read as money out, or the other way. There's no button for one line: your accountant can correct it with a journal.",
      };
    case "marked_duplicate_but_isnt":
      return {
        headline: `You marked ${firstLine} as a duplicate, but it doesn't look like one.`,
        detail: "There's nothing else like it nearby, so your bank has it only once. Saying it isn't a duplicate puts it back in your books.",
      };
    case "entry_by_hand": {
      const j = journalsOf(f, x)[0];
      return {
        headline: `${j ? journalWords(j) : "A journal"} was entered by hand, and your bank's statements don't show it.`,
        detail: "Reversing it takes it out of your books.",
      };
    }
    case "date_cut_off":
      return {
        headline: `${lines(ls.length, "This line falls", "These # lines fall")} on the other side of a balance date from where your bank put ${ls.length === 1 ? "it" : "them"}.`,
        detail:
          "Nothing's missing: your bank counted it on a different day from your books. It's a timing difference. Your accountant can post a journal, or accept it as a timing difference.",
      };
    case "wrong_account":
      if (statement) {
        return {
          headline: `${file} looks like it belongs to another account.`,
          detail: "Remove it here, then upload it to the right account.",
        };
      }
      return {
        headline: "A statement uploaded to another of your accounts may belong here.",
        detail: "Remove it there, then upload it to this account.",
      };
    case "amount_read_wrong":
      return {
        headline: `${firstLine} looks like its amount was read wrong.`,
        detail:
          "Either your bank's file or our reading of it is wrong. We've noted which row it was so we can check our side (nothing from the file itself). Your accountant can correct it with a journal.",
      };
    case "transposed_digits": {
      if (f.fix?.kind === "set_opening_balance") {
        return {
          headline: "The opening balance looks like it was typed with two digits swapped.",
          detail: `You entered ${opening}, but your bank says ${signedDollars(f.fix.amount)}. Changing it starts your books where your bank does.`,
        };
      }
      const j = journalsOf(f, x)[0];
      return {
        headline: `${j ? journalWords(j) : "A journal"} looks like it was typed with two digits swapped.`,
        detail: "Your accountant can reverse it and post it again with the right amount.",
      };
    }
  }
}

const KIND_WORDS: Record<FindingKind, string> = {
  duplicate: "lines uploaded twice",
  missing_lines: "a missing statement",
  wrong_opening_balance: "the opening balance",
  sign_reversed: "a file read the wrong way round",
  marked_duplicate_but_isnt: "a line marked as a duplicate that isn't one",
  entry_by_hand: "an entry made by hand",
  date_cut_off: "a timing difference",
  wrong_account: "a file on the wrong account",
  amount_read_wrong: "an amount read wrong",
  transposed_digits: "two digits swapped",
};

/** A finding's kind as a short phrase: "lines uploaded twice". */
export function findingKindWords(kind: FindingKind): string {
  return KIND_WORDS[kind];
}

/** The command a fix sends, or `null` when it's something to do outside the app (upload a file). */
export function fixCommand(fix: SuggestedFix): Command | null {
  switch (fix.kind) {
    case "mark_duplicate":
      return { kind: "resolve_duplicate", payload: { bank_line_id: fix.bank_line_id, is_duplicate: true } };
    case "unmark_duplicate":
      return { kind: "resolve_duplicate", payload: { bank_line_id: fix.bank_line_id, is_duplicate: false } };
    case "set_opening_balance":
      return { kind: "set_opening_balance", payload: { bank_account_id: fix.bank_account_id, balance: fix.amount } };
    case "remove_statement":
      return { kind: "remove_statement", payload: { statement_id: fix.statement_id } };
    case "reverse_journal":
      return { kind: "reverse_journal", payload: { journal_id: fix.journal_id } };
    case "upload_missing":
      return null;
  }
}

/**
 * Whether `me` may send `fix`. Reversing a journal is an accountant's work; the rest is the owner's
 * (and staff's). The server checks again.
 */
export function maySend(fix: SuggestedFix, me: Me | null): boolean {
  if (!me || !can(me, "staff")) {
    return false;
  }
  return fix.kind === "reverse_journal" ? !isOwner(me) : true;
}

/** What to do once a fix has gone through, when there's more than the books agreeing. */
export function afterFix(f: Finding, x: AccountFindings): string | null {
  const file = statementOf(f, x)?.file_name ?? "the file";
  if (f.fix?.kind !== "remove_statement") {
    return null;
  }
  switch (f.kind) {
    case "sign_reversed":
      return `Removed ${file}. Now upload it again. If it's read the wrong way round again, tell us: that's our reading of your bank's file.`;
    case "wrong_account":
      return `Removed ${file}. Now upload it to the account it belongs to.`;
    default:
      return `Removed ${file}.`;
  }
}
