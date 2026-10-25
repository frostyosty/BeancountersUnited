// @vitest-environment jsdom
import type { GlListing } from "@acct/types/GlListing";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { practice, sam, widgets } from "../test/data";
import { renderApp, stubApi } from "../test/render";

const accounts = practice.master_charts[0]!.accounts;
const year = widgets.years[0]!;

const entry = (journal_id: string, date: string, narration: string, amount: number, balance: number, matched_reversal = false) => ({
  journal_id,
  kind: "manual" as const,
  date,
  narration,
  amount,
  balance,
  matched_reversal,
});

const listing: GlListing = {
  accounts: [
    {
      code: "800",
      name: "Bank",
      opening: 100_00,
      closing: 95_00,
      entries: [
        entry("j1", "2024-06-30", "Wrong sale", 200_00, 300_00, true),
        entry("j2", "2024-07-01", "Bank fees", -5_00, 295_00),
        entry("j3", "2024-07-31", "Reversal of: Wrong sale", -200_00, 95_00, true),
      ],
    },
    {
      code: "100",
      name: "Sales",
      opening: 0,
      closing: 0,
      entries: [
        entry("j1", "2024-06-30", "Wrong sale", -200_00, -200_00, true),
        entry("j3", "2024-07-31", "Reversal of: Wrong sale", 200_00, 0, true),
      ],
    },
  ],
};

function routes(body: GlListing) {
  return {
    "GET /api/me": () => sam,
    "GET /api/years/y1": () => year,
    "GET /api/clients/c1": () => widgets,
    "GET /api/clients/c1/chart": () => accounts,
    "GET /api/years/y1/gl": () => body,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("general ledger", () => {
  it("hides matched reversals until asked, with the same balances either way", async () => {
    stubApi(routes(listing));
    renderApp(<App />, "/years/y1/gl");
    const user = userEvent.setup();

    const bank = await screen.findByRole("region", { name: "800 Bank" });
    expect(within(bank).queryByText("Wrong sale")).toBeNull();
    expect(within(bank).getByText("Bank fees").closest("tr")!.textContent).toContain("295.00 Dr");
    expect(within(bank).getByText("Opening balance").closest("tr")!.textContent).toContain("100.00 Dr");
    expect(within(bank).getByText("Closing balance").closest("tr")!.textContent).toContain("95.00 Dr");
    expect(screen.getByText("4 lines from matched reversals hidden")).toBeTruthy();

    await user.click(screen.getByLabelText("Show matched reversals"));
    const shown = within(bank).getAllByRole("row").map((r) => r.textContent);
    expect(shown.some((t) => t?.includes("Wrong sale") && t.includes("300.00 Dr"))).toBe(true);
    expect(within(bank).getByText("Bank fees").closest("tr")!.textContent).toContain("295.00 Dr");
    expect(within(bank).getByText("Closing balance").closest("tr")!.textContent).toContain("95.00 Dr");

    // One account at a time.
    await user.selectOptions(screen.getByLabelText("Account"), "100");
    expect(screen.queryByRole("region", { name: "800 Bank" })).toBeNull();
    expect(screen.getByRole("region", { name: "100 Sales" })).toBeTruthy();
  });

  it("shows accounts by name alone when the server leaves the codes out", async () => {
    const owners: GlListing = {
      accounts: listing.accounts.map((a) => ({ ...a, code: null })),
    };
    stubApi(routes(owners));
    renderApp(<App />, "/years/y1/gl");
    expect(await screen.findByRole("region", { name: "Bank" })).toBeTruthy();
    expect(screen.queryByText(/800/)).toBeNull();
  });

  it("says so when nothing is posted", async () => {
    stubApi(routes({ accounts: [] }));
    renderApp(<App />, "/years/y1/gl");
    expect(await screen.findByText(/Nothing posted yet/)).toBeTruthy();
  });
});
