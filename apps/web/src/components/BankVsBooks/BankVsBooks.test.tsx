// @vitest-environment jsdom
import type { AccountProof } from "@acct/types/AccountProof";
import type { Me } from "@acct/types/Me";
import type { StatementExcerpt } from "@acct/types/StatementExcerpt";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentUser } from "../../auth";
import { renderApp, stubApi } from "../../test/render";
import { BankVsBooks, BankVsBooksForAccount } from "./BankVsBooks";
import { balanceWords, verdictWords } from "./wording";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ana: Me = { id: "u1", username: "ana", display_name: "Ana Owner", role: "business_owner" };

function proof(over: { ledger: number; stated: number; kind?: AccountProof["kind"]; at?: "exact" | "nearest" }): AccountProof {
  const difference = over.ledger - over.stated;
  return {
    business_name: "Ferncliff Joinery",
    bank_account_id: "a1",
    code: "600.01",
    name: "Kowhai cheque",
    kind: over.kind ?? "bank",
    account_number: "99-5501-0000612-00",
    statement_file: "kowhai-cheque-2026-03.csv",
    proof: {
      date: "2026-03-31",
      bank: {
        checkpoint: {
          date: over.at === "nearest" ? "2026-03-28" : "2026-03-31",
          stated: over.stated,
          source: { statement_id: "s1", balance: { kind: "closing" }, span: { line: 15, start: 16, end: 23 } },
        },
        compared: { ledger: over.ledger, difference, step: difference },
      },
      at: over.at ?? "exact",
      books_date: over.at === "nearest" ? "2026-03-28" : "2026-03-31",
      ledger: over.ledger,
      recent: [
        { journal_id: "j1", date: "2026-03-27", narration: "FARO INSURANCE, PREMIUM", amount: -7850 },
        { journal_id: "j2", date: "2026-03-28", narration: "DRAWINGS TO OWN ACCOUNT", amount: -60000 },
      ],
      window: { shape: difference === 0 ? "constant" : "jump", difference, last_agrees: null, first_differs: null },
    },
  };
}

const kept: StatementExcerpt = {
  statement_id: "s1",
  file_name: "kowhai-cheque-2026-03.csv",
  kept: true,
  sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
  media_type: "text/csv",
  stated: 845230,
  date: "2026-03-31",
  lines: [
    { number: 14, text: "28/03/2026,DRAWINGS TO OWN ACCOUNT,600.00,,8452.30" },
    { number: 15, text: "Closing balance,8452.30" },
    { number: 16, text: "End of statement" },
  ],
  highlight: { line: 15, start: 16, end: 23 },
};

function show(p: AccountProof, excerpt: StatementExcerpt = kept) {
  const calls = stubApi({ "GET /api/statements/s1/excerpt": () => excerpt });
  renderApp(
    <CurrentUser.Provider value={ana}>
      <BankVsBooks open onClose={() => {}} proofs={[p]} />
    </CurrentUser.Provider>,
  );
  return calls;
}

describe("Bank vs books", () => {
  it("shows the bank's own words beside the books, and that they agree", async () => {
    const calls = show(proof({ ledger: 845230, stated: 845230 }));
    const bank = screen.getByRole("region", { name: /Your bank's file says/ });
    const mark = await within(bank).findByText("8452.30", { selector: "mark" });
    expect(mark.closest("pre")!.textContent).toContain("Closing balance,8452.30");
    expect(within(bank).getByText("$8,452.30")).toBeTruthy();
    expect(within(bank).getByText(/SHA-256 a1b2c3d4e5f6$/)).toBeTruthy();
    expect(within(bank).getByText(/kowhai-cheque-2026-03\.csv/)).toBeTruthy();
    const books = screen.getByRole("region", { name: /Your books say/ });
    expect(within(books).getByText("$8,452.30")).toBeTruthy();
    expect(within(books).getByText("DRAWINGS TO OWN ACCOUNT")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Agrees");
    expect(screen.queryByRole("button", { name: /See what might explain it/ })).toBeNull();
    expect(calls[0].path).toBe("/api/statements/s1/excerpt");
  });

  it("says how far out it is, with a findings link that waits for the findings", async () => {
    show(proof({ ledger: 845230 + 41250, stated: 845230 }));
    expect(screen.getByRole("status").textContent).toContain("Out by $412.50");
    const link = screen.getByRole("button", { name: /See what might explain it/ }) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    await screen.findByText("8452.30", { selector: "mark" });
  });

  it("puts a card in its own words on both sides", async () => {
    show(proof({ ledger: -108755, stated: -108755, kind: "credit_card" }));
    expect(within(screen.getByRole("region", { name: /Your bank's file says/ })).getByText("you owe $1,087.55")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: /Your books say/ })).getByText("you owe $1,087.55")).toBeTruthy();
    await screen.findByText("8452.30", { selector: "mark" });
  });

  it("says when the original file wasn't kept, and shows the stored figure", async () => {
    show(proof({ ledger: 845230, stated: 845230 }), { ...kept, kept: false, sha256: null, media_type: null, lines: [], highlight: null });
    const bank = screen.getByRole("region", { name: /Your bank's file says/ });
    expect(await within(bank).findByText(/Original file not kept/)).toBeTruthy();
    expect(within(bank).getByText("$8,452.30")).toBeTruthy();
    expect(within(bank).queryByText(/SHA-256/)).toBeNull();
  });

  it("labels the nearest balance when the bank gave none for the day", async () => {
    show(proof({ ledger: 845230, stated: 845230, at: "nearest" }));
    expect(screen.getByText(/Nearest balance your bank gave: 28 Mar 2026/)).toBeTruthy();
    await screen.findByText("8452.30", { selector: "mark" });
  });

  it("has a print header with the business, account, date, and who printed it when", async () => {
    show(proof({ ledger: 845230, stated: 845230 }));
    const printed = screen.getByText(/^Printed .* at \d\d:\d\d by Ana Owner$/);
    const head = printed.closest("header")!;
    expect(head.textContent).toContain("Ferncliff Joinery");
    expect(head.textContent).toContain("600.01 Kowhai cheque");
    expect(head.textContent).toContain("Bank vs books at the end of 31 Mar 2026");
    const print = vi.fn();
    vi.stubGlobal("print", print);
    await userEvent.setup().click(screen.getByRole("button", { name: /Print/ }));
    await vi.waitFor(() => expect(print).toHaveBeenCalled());
  });

  it("loads an account's proof when opened from a bank account", async () => {
    const p = proof({ ledger: 845230, stated: 845230 });
    const calls = stubApi({
      "GET /api/bank-accounts/a1/proof": () => p,
      "GET /api/statements/s1/excerpt": () => kept,
    });
    renderApp(<BankVsBooksForAccount open onClose={() => {}} bankAccountId="a1" date="2026-03-31" />);
    expect(await screen.findByText("8452.30", { selector: "mark" })).toBeTruthy();
    expect(calls.map((c) => c.path)).toContain("/api/bank-accounts/a1/proof");
  });
});

describe("wording", () => {
  it("says balances the way the account would", () => {
    expect(balanceWords(-108755, "credit_card")).toBe("you owe $1,087.55");
    expect(balanceWords(2500, "credit_card")).toBe("in credit $25.00");
    expect(balanceWords(0, "credit_card")).toBe("nothing owed");
    expect(balanceWords(845230, "bank")).toBe("$8,452.30");
    expect(balanceWords(-1000, "bank")).toBe("overdrawn $10.00");
    expect(verdictWords(0)).toBe("Agrees");
    expect(verdictWords(-41250)).toBe("Out by $412.50");
  });
});
