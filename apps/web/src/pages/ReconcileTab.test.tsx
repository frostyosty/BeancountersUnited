// @vitest-environment jsdom
import type { AccountReconciliation } from "@acct/types/AccountReconciliation";
import type { YearReconciliation } from "@acct/types/YearReconciliation";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { practice, val, widgets } from "../test/data";
import { renderApp, stubApi } from "../test/render";

const empty: Omit<AccountReconciliation, "bank_account_id" | "code" | "name" | "status"> = {
  kind: "bank",
  account_number: null,
  date: null,
  statement_file: null,
  statement_balance: null,
  ledger_balance: null,
  difference: null,
  unexplained: null,
  lines_without_journal: [],
  journals_without_line: [],
  gap_journals: [],
  gaps: [],
};

/** The synthetic sole trader's three accounts, as the server reconciles them. */
const rec: YearReconciliation = {
  client_year_id: "y1",
  accounts: [
    {
      ...empty,
      bank_account_id: "a1",
      code: "600.01",
      name: "Harbourlight cheque",
      status: "agrees",
      date: "2025-09-30",
      statement_file: "harbourlight-cheque-2025-08-28_09-30.qif",
      statement_balance: 224712,
      ledger_balance: 224712,
      difference: 0,
      unexplained: 0,
    },
    {
      ...empty,
      bank_account_id: "a2",
      code: "600.02",
      name: "Kowhai business",
      status: "explained",
      date: "2025-09-30",
      statement_balance: 283073,
      ledger_balance: 284073,
      difference: 1000,
      unexplained: 0,
      journals_without_line: [{ journal_id: "j9", date: "2025-09-15", narration: "Cash banked by hand", amount: 1000 }],
      gap_journals: [{ journal_id: "jg", start: "2025-09-01", end: "2025-09-09", amount: 38000 }],
      gaps: [{ start: "2025-09-01", end: "2025-09-09", change: 38000 }],
    },
    {
      ...empty,
      bank_account_id: "a3",
      code: "600.03",
      name: "Rimu savings",
      status: "no_balance",
      date: "2025-09-30",
      ledger_balance: 115376,
      lines_without_journal: [
        {
          bank_line_id: "l7",
          date: "2025-09-30",
          description: "INTEREST",
          amount: 192,
          reason: "duplicate",
        },
      ],
      gaps: [{ start: "2025-08-01", end: "2025-08-28", change: null }],
    },
  ],
};

function routes(body: () => unknown) {
  return {
    "GET /api/me": () => val,
    "GET /api/years/y1": () => widgets.years[0],
    "GET /api/clients/c1": () => widgets,
    "GET /api/clients/c1/chart": () => practice.master_charts[0]!.accounts,
    "GET /api/years/y1/reconciliation": body,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("reconcile", () => {
  it("shows each account's balances, status and unmatched items", async () => {
    stubApi(routes(() => rec));
    renderApp(<App />, "/years/y1/reconcile");

    const cheque = await screen.findByRole("region", { name: "600.01 Harbourlight cheque" });
    expect(within(cheque).getByRole("status").textContent).toContain("Agrees with the statement");
    const balances = within(cheque).getByRole("table", { name: /Balances/ });
    expect(within(balances).getAllByRole("row").map((r) => r.textContent)).toEqual([
      "Statement at 30 Sep 2025 (harbourlight-cheque-2025-08-28_09-30.qif)2,247.12",
      "Ledger at 30 Sep 20252,247.12",
      "Difference (ledger less statement)0.00",
    ]);

    const kowhai = screen.getByRole("region", { name: "600.02 Kowhai business" });
    expect(within(kowhai).getByRole("status").textContent).toContain("the items below explain it");
    const stray = within(kowhai).getByRole("table", { name: "Journals without a statement line" });
    expect(within(stray).getByRole("row").textContent).toBe("15 Sep 2025Cash banked by hand10.00");
    const gaps = within(kowhai).getByRole("table", { name: /Gap journals/ });
    expect(within(gaps).getByRole("row").textContent).toBe("9 Sep 20251 Sep 2025 to 9 Sep 2025380.00");

    const rimu = screen.getByRole("region", { name: "600.03 Rimu savings" });
    expect(within(rimu).getByRole("status").textContent).toContain("the statement gives no balance");
    expect(within(rimu).getByText("not given")).toBeTruthy();
    expect(within(rimu).getByText(/Marked as a duplicate/)).toBeTruthy();
    expect(within(rimu).getByText(/No statement covers 1 Aug 2025 to 28 Aug 2025/)).toBeTruthy();
  });

  it("flags a difference nothing explains", async () => {
    const differs: YearReconciliation = {
      client_year_id: "y1",
      accounts: [{ ...rec.accounts[0]!, status: "differs", ledger_balance: 224812, difference: 100, unexplained: 100 }],
    };
    stubApi(routes(() => differs));
    renderApp(<App />, "/years/y1/reconcile");
    const cheque = await screen.findByRole("region", { name: "600.01 Harbourlight cheque" });
    expect(within(cheque).getByRole("status").textContent).toContain("Doesn't agree");
    expect(within(cheque).getByText("Not explained by the items below").closest("tr")!.textContent).toContain("1.00");
  });

  it("says when there's nothing to reconcile", async () => {
    stubApi(routes(() => ({ client_year_id: "y1", accounts: [] })));
    renderApp(<App />, "/years/y1/reconcile");
    expect(await screen.findByText(/No bank accounts or cards/)).toBeTruthy();
  });
});
