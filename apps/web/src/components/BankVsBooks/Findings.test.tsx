// @vitest-environment jsdom
import type { AccountFindings } from "@acct/types/AccountFindings";
import type { AccountProof } from "@acct/types/AccountProof";
import type { Finding } from "@acct/types/Finding";
import type { FindingKind } from "@acct/types/FindingKind";
import type { Me } from "@acct/types/Me";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentUser } from "../../auth";
import { jsonResponse, renderApp, stubApi } from "../../test/render";
import { BankVsBooks } from "./BankVsBooks";
import { findingText, fixCommand } from "./FindingsText";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ana: Me = { id: "u1", username: "ana", display_name: "Ana Owner", role: "business_owner" };
const sam: Me = { id: "u2", username: "sam", display_name: "Sam Staff", role: "staff" };

const line = (id: string, amount: number, description = "COUNTDOWN AUCKLAND", statement_id = "s2") => ({
  bank_line_id: id,
  statement_id,
  date: "2026-03-03",
  description,
  amount,
});

/** Findings for an account out by `difference`, explained by `explained_by`. */
function findings(over: Partial<AccountFindings["diagnosis"]> & { difference: number }, rest: Partial<AccountFindings> = {}): AccountFindings {
  return {
    client_id: "biz",
    diagnosis: { explained_by: [], remainder: 0, other_findings: [], ...over },
    lines: [line("l1", -4520), line("l2", -4520, "COUNTDOWN AUCKLAND", "s1")],
    journals: [
      { journal_id: "j1", date: "2026-02-10", narration: "Consulting fee", amount: 41250 },
      { journal_id: "jo", date: "2025-04-01", narration: "Opening balance: Kowhai cheque", amount: 300000 },
      { journal_id: "jg", date: "2025-08-31", narration: "No statement from 2025-08-01 to 2025-08-31", amount: 41918 },
    ],
    statements: [
      { statement_id: "s1", file_name: "kowhai-cheque-2026-03.csv", start: "2026-03-01", end: "2026-03-31", net: -4520 },
      { statement_id: "s2", file_name: "kowhai-cheque-2026-03 (1).csv", start: "2026-03-01", end: "2026-03-31", net: -4520 },
    ],
    opening: 300000,
    has_accountant: true,
    ...rest,
  };
}

function proof(ledger: number, stated: number, x: AccountFindings): AccountProof {
  const difference = ledger - stated;
  const at = (date: string, d: number) => ({
    checkpoint: { date, stated, source: { statement_id: "s1", balance: { kind: "closing" as const }, span: null } },
    compared: { ledger: stated + d, difference: d, step: d },
  });
  return {
    business_name: "Ferncliff Joinery",
    bank_account_id: "a1",
    code: "600.01",
    name: "Kowhai cheque",
    kind: "bank",
    account_number: "99-5501-0000612-00",
    statement_file: "kowhai-cheque-2026-03.csv",
    proof: {
      date: "2026-03-31",
      bank: at("2026-03-31", difference),
      at: "exact",
      books_date: "2026-03-31",
      ledger,
      recent: [],
      window: {
        shape: "jump",
        difference,
        last_agrees: difference === 0 ? null : at("2026-02-03", 0),
        first_differs: difference === 0 ? null : at("2026-02-28", difference),
      },
    },
    findings: x,
  };
}

const excerpt = {
  statement_id: "s1",
  file_name: "kowhai-cheque-2026-03.csv",
  kept: false,
  sha256: null,
  media_type: null,
  stated: 0,
  date: "2026-03-31",
  lines: [],
  highlight: null,
};

function show(p: AccountProof, me: Me = ana, routes: Parameters<typeof stubApi>[0] = {}) {
  const calls = stubApi({ "GET /api/statements/s1/excerpt": () => excerpt, ...routes });
  renderApp(
    <CurrentUser.Provider value={me}>
      <BankVsBooks open onClose={() => {}} proofs={[p]} />
    </CurrentUser.Provider>,
  );
  return calls;
}

const duplicate: Finding = {
  kind: "duplicate",
  explains: -4520,
  confidence: "likely",
  evidence: [
    { kind: "bank_line", bank_line_id: "l1" },
    { kind: "bank_line", bank_line_id: "l2" },
  ],
  fix: { kind: "mark_duplicate", bank_line_id: "l1" },
};

const wrongOpening: Finding = {
  kind: "wrong_opening_balance",
  explains: -26485,
  confidence: "likely",
  evidence: [
    { kind: "journal", journal_id: "jo" },
    { kind: "statement", statement_id: "s1" },
  ],
  fix: { kind: "set_opening_balance", bank_account_id: "a1", date: "2025-04-01", amount: 326485 },
};

describe("findings in plain English", () => {
  const x = findings({ difference: 0 });
  const f = (kind: FindingKind, evidence: Finding["evidence"], fix: Finding["fix"] = null, explains = 100): Finding => ({
    kind,
    explains,
    confidence: "likely",
    evidence,
    fix,
  });
  const l1 = [{ kind: "bank_line" as const, bank_line_id: "l1" }];
  const s2 = [{ kind: "statement" as const, statement_id: "s2" }, ...l1];
  const j1 = [{ kind: "journal" as const, journal_id: "j1" }];
  const gap = [
    { kind: "gap" as const, start: "2025-08-01", end: "2025-08-31" },
    { kind: "journal" as const, journal_id: "jg" },
  ];

  it.each<[string, Finding, string, string]>([
    ["a whole file twice", f("duplicate", s2, { kind: "remove_statement", statement_id: "s2" }), "This line looks like it was uploaded twice: everything in kowhai-cheque-2026-03 (1).csv is already in your books.", "Removing kowhai-cheque-2026-03 (1).csv takes it out again."],
    ["one line twice", duplicate, "This line looks like it was uploaded twice.", "Marking the second one as a duplicate"],
    ["one line twice, never flagged", { ...duplicate, fix: null }, "This line looks like it was uploaded twice.", "there's no button for it. Your accountant can take it out with a journal"],
    ["a gap we filled", f("missing_lines", gap, { kind: "upload_missing", bank_account_id: "a1", start: "2025-08-01", end: "2025-08-31" }, 0), "No statement for 1 Aug 2025 to 31 Aug 2025.", "We put the change, $419.18, in as one entry."],
    ["a gap", f("missing_lines", gap.slice(0, 1), { kind: "upload_missing", bank_account_id: "a1", start: "2025-08-01", end: "2025-08-31" }), "No statement covers 1 Aug 2025 to 31 Aug 2025.", "Upload the statement for them."],
    ["a file cut short", f("missing_lines", s2.slice(0, 1)), "kowhai-cheque-2026-03 (1).csv looks cut short.", "Download it from your bank again"],
    ["the opening balance", wrongOpening, "The opening balance looks wrong.", "You entered $3,000.00, but your bank's statements start from $3,264.85."],
    ["a file read backwards", f("sign_reversed", s2.slice(0, 1), { kind: "remove_statement", statement_id: "s2" }), "kowhai-cheque-2026-03 (1).csv looks like it was read the wrong way round: money in as money out, and the other way.", "Remove it, then upload it again."],
    ["one line read backwards", f("sign_reversed", l1), "3 Mar 2026 COUNTDOWN AUCKLAND −$45.20 looks like it was read the wrong way round.", "There's no button for one line"],
    ["marked a duplicate", f("marked_duplicate_but_isnt", l1, { kind: "unmark_duplicate", bank_line_id: "l1" }), "You marked 3 Mar 2026 COUNTDOWN AUCKLAND −$45.20 as a duplicate, but it doesn't look like one.", "puts it back in your books"],
    ["entered by hand", f("entry_by_hand", j1, { kind: "reverse_journal", journal_id: "j1" }), "“Consulting fee” on 10 Feb 2026 ($412.50) was entered by hand, and your bank's statements don't show it.", "Reversing it takes it out of your books."],
    ["a cut-off", f("date_cut_off", l1), "This line falls on the other side of a balance date from where your bank put it.", "It's a timing difference."],
    ["the wrong account", f("wrong_account", s2.slice(0, 1), { kind: "remove_statement", statement_id: "s2" }), "kowhai-cheque-2026-03 (1).csv looks like it belongs to another account.", "upload it to the right account"],
    ["another account's file", f("wrong_account", [{ kind: "statement", statement_id: "elsewhere" }], { kind: "remove_statement", statement_id: "elsewhere" }), "A statement uploaded to another of your accounts may belong here.", "Remove it there"],
    ["an amount read wrong", f("amount_read_wrong", l1), "3 Mar 2026 COUNTDOWN AUCKLAND −$45.20 looks like its amount was read wrong.", "We've noted which row it was"],
    ["digits swapped in the opening", { ...wrongOpening, kind: "transposed_digits" }, "The opening balance looks like it was typed with two digits swapped.", "You entered $3,000.00, but your bank says $3,264.85."],
    ["digits swapped in a journal", f("transposed_digits", j1), "“Consulting fee” on 10 Feb 2026 ($412.50) looks like it was typed with two digits swapped.", "reverse it and post it again"],
  ])("%s", (_, finding, headline, detail) => {
    const t = findingText(finding, x);
    expect(t.headline).toBe(headline);
    expect(t.detail).toContain(detail);
  });

  it("covers every kind", () => {
    const kinds: Record<FindingKind, true> = {
      duplicate: true,
      missing_lines: true,
      wrong_opening_balance: true,
      sign_reversed: true,
      marked_duplicate_but_isnt: true,
      entry_by_hand: true,
      date_cut_off: true,
      wrong_account: true,
      amount_read_wrong: true,
      transposed_digits: true,
    };
    for (const kind of Object.keys(kinds) as FindingKind[]) {
      expect(findingText(f(kind, []), x).headline.length).toBeGreaterThan(10);
    }
  });

  it("sends each fix as the command it names", () => {
    expect(fixCommand({ kind: "mark_duplicate", bank_line_id: "l1" })).toEqual({ kind: "resolve_duplicate", payload: { bank_line_id: "l1", is_duplicate: true } });
    expect(fixCommand({ kind: "unmark_duplicate", bank_line_id: "l1" })).toEqual({ kind: "resolve_duplicate", payload: { bank_line_id: "l1", is_duplicate: false } });
    expect(fixCommand(wrongOpening.fix!)).toEqual({ kind: "set_opening_balance", payload: { bank_account_id: "a1", balance: 326485 } });
    expect(fixCommand({ kind: "remove_statement", statement_id: "s2" })).toEqual({ kind: "remove_statement", payload: { statement_id: "s2" } });
    expect(fixCommand({ kind: "reverse_journal", journal_id: "j1" })).toEqual({ kind: "reverse_journal", payload: { journal_id: "j1" } });
    expect(fixCommand({ kind: "upload_missing", bank_account_id: "a1", start: "2025-08-01", end: "2025-08-31" })).toBeNull();
  });
});

describe("findings on the card", () => {
  it("leads with the explanation and previews the fix before sending it", async () => {
    const p = proof(845230 - 4520, 845230, findings({ difference: -4520, explained_by: [duplicate] }));
    const again = proof(845230, 845230, findings({ difference: 0 }));
    const calls = show(p, ana, {
      "POST /api/commands": () => ({ seq: 9, entity_id: null }),
      "GET /api/bank-accounts/a1/proof": () => again,
    });
    const box = screen.getByRole("region", { name: "What might explain it" });
    expect(within(box).getByText("This line looks like it was uploaded twice.")).toBeTruthy();
    // Both copies, each linking to the file it came in.
    const [later, earlier] = within(box).getAllByRole("link", { name: "3 Mar 2026 COUNTDOWN AUCKLAND −$45.20" });
    expect(later.getAttribute("href")).toBe("/businesses/biz#statement-s2");
    expect(later.parentElement!.textContent).toContain(", in kowhai-cheque-2026-03 (1).csv");
    expect(earlier.getAttribute("href")).toBe("/businesses/biz#statement-s1");

    const user = userEvent.setup();
    await user.click(within(box).getByRole("button", { name: /Fix it/ }));
    // Only the preview: nothing sent yet.
    const preview = within(box).getByRole("group", { name: "Before you fix it" });
    expect(preview.textContent).toContain("Afterwards your books will say $8,452.30 at the end of 31 Mar 2026, the same as your bank");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    await user.click(within(preview).getByRole("button", { name: "Confirm" }));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("Agrees"));
    const sent = calls.filter((c) => c.method === "POST");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({
      kind: "resolve_duplicate",
      payload: { bank_line_id: "l1", is_duplicate: true },
      via: { kind: "finding", finding: "duplicate" },
    });
  });

  it("cancelling the preview sends nothing", async () => {
    const calls = show(proof(1000, 5520, findings({ difference: -4520, explained_by: [duplicate] })));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Fix it/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Before you fix it" })).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("fixes the whole explanation in turn, stopping at the first refusal", async () => {
    const both = findings({ difference: -31005, explained_by: [duplicate, wrongOpening] });
    let n = 0;
    const calls = show(proof(1000, 32005, both), ana, {
      "POST /api/commands": () => (++n === 1 ? jsonResponse(422, { code: "not_a_possible_duplicate", message: "This line wasn't flagged as a possible duplicate." }) : { seq: 9, entity_id: null }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Fix all 2/ }));
    expect(screen.getByRole("group", { name: "Before you fix it" }).textContent).toContain("the same as your bank");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toContain("wasn't flagged");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("gives a finding with no fix no button, and says who can sort it", () => {
    const cutOff: Finding = { kind: "date_cut_off", explains: -4520, confidence: "likely", evidence: [{ kind: "bank_line", bank_line_id: "l1" }], fix: null };
    show(proof(1000, 5520, findings({ difference: -4520, explained_by: [cutOff] })));
    const box = screen.getByRole("region", { name: "What might explain it" });
    expect(within(box).getByText(/It's a timing difference/).textContent).toContain("Your accountant can post a journal");
    expect(within(box).queryByRole("button", { name: /Fix it/ })).toBeNull();
  });

  it("leaves reversing a journal to the accountant", () => {
    const byHand: Finding = { kind: "entry_by_hand", explains: 41250, confidence: "likely", evidence: [{ kind: "journal", journal_id: "j1" }], fix: { kind: "reverse_journal", journal_id: "j1" } };
    const p = proof(41250, 0, findings({ difference: 41250, explained_by: [byHand] }));
    show(p, ana);
    expect(screen.queryByRole("button", { name: /Fix it/ })).toBeNull();
    expect(screen.getByText("Your accountant can make this change.")).toBeTruthy();
    cleanup();
    show(p, sam);
    expect(screen.getByRole("button", { name: /Fix it/ })).toBeTruthy();
  });

  it("says where it parts ways when nothing explains it, and offers to ask the accountant", async () => {
    // user-event stands in for the clipboard.
    const user = userEvent.setup();
    show(proof(41250, 0, findings({ difference: 41250 })));
    expect(screen.getByText("We couldn't work out why. Between 3 Feb 2026 and 28 Feb 2026 your books and your bank go out by $412.50.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Ask your accountant/ }));
    expect(await screen.findByText(/Copied a message for them/)).toBeTruthy();
    expect(await navigator.clipboard.readText()).toContain("my books for Kowhai cheque and my bank go out by $412.50");
  });

  it("shows the other findings in a list, and a gap the server filled as a note even when it agrees", () => {
    const note: Finding = {
      kind: "missing_lines",
      explains: 0,
      confidence: "likely",
      evidence: [
        { kind: "gap", start: "2025-08-01", end: "2025-08-31" },
        { kind: "journal", journal_id: "jg" },
      ],
      fix: { kind: "upload_missing", bank_account_id: "a1", start: "2025-08-01", end: "2025-08-31" },
    };
    show(proof(845230, 845230, findings({ difference: 0, other_findings: [note, { ...duplicate, confidence: "possible" }] })));
    expect(screen.getByRole("note").textContent).toContain("No statement for 1 Aug 2025 to 31 Aug 2025.We put the change, $419.18, in as one entry.");
    expect(screen.getByText(/Other things we noticed \(1\)/)).toBeTruthy();
  });
});
