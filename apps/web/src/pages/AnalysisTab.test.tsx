// @vitest-environment jsdom
import type { ExpenseAnalysisView } from "@acct/types/ExpenseAnalysisView";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { practice, sam, widgets } from "../test/data";
import { jsonResponse, renderApp, stubApi } from "../test/render";

const accounts = practice.master_charts[0]!.accounts;
const year = widgets.years[0]!;

const analysis: ExpenseAnalysisView = {
  comparatives: "unfinalised",
  categories: [
    {
      line: "occupancy",
      label: "Occupancy",
      movement: { current: 270_00, prior: 200_00, change: 70_00, change_bp: 3_500 },
      accounts: [
        { code: "610", name: "Rent", movement: { current: 240_00, prior: 200_00, change: 40_00, change_bp: 2_000 } },
        { code: "620", name: "Power", movement: { current: 30_00, prior: 0, change: 30_00, change_bp: null } },
      ],
    },
    {
      line: "admin",
      label: "Administration",
      movement: { current: 10_00, prior: 12_00, change: -2_00, change_bp: -1_667 },
      accounts: [{ code: "630", name: "Phone", movement: { current: 10_00, prior: 12_00, change: -2_00, change_bp: -1_667 } }],
    },
  ],
  total: { current: 280_00, prior: 212_00, change: 68_00, change_bp: 3_208 },
};

function routes(body: unknown) {
  return {
    "GET /api/me": () => sam,
    "GET /api/years/y1": () => year,
    "GET /api/clients/c1": () => widgets,
    "GET /api/clients/c1/chart": () => accounts,
    "GET /api/years/y1/analysis": () => body,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("expense analysis", () => {
  it("shows each category this year against last, in dollars and percent", async () => {
    stubApi(routes(analysis));
    renderApp(<App />, "/years/y1/analysis");
    const user = userEvent.setup();

    const occupancy = await screen.findByRole("button", { name: "Occupancy" });
    const row = occupancy.closest("tr")!.textContent;
    expect(row).toContain("270.00");
    expect(row).toContain("200.00");
    expect(row).toContain("+70.00");
    expect(row).toContain("+35%");
    const admin = screen.getByRole("button", { name: "Administration" }).closest("tr")!.textContent;
    expect(admin).toContain("-2.00");
    expect(admin).toContain("-16.67%");
    expect(screen.getByText("Total expenses").closest("tr")!.textContent).toContain("+32.08%");
    expect(screen.getByText(/isn't finalised yet/)).toBeTruthy();

    // Drill into the accounts behind a category; a nil prior year has no percentage.
    expect(screen.queryByText("610 Rent")).toBeNull();
    await user.click(occupancy);
    expect(occupancy.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("610 Rent").closest("tr")!.textContent).toContain("+20%");
    expect(screen.getByText("620 Power").closest("tr")!.textContent).toMatch(/\+30\.00–$/);
  });

  it("names accounts without codes when the server leaves them out", async () => {
    const owners: ExpenseAnalysisView = {
      ...analysis,
      categories: analysis.categories.map((c) => ({ ...c, accounts: c.accounts.map((a) => ({ ...a, code: null })) })),
    };
    stubApi(routes(owners));
    renderApp(<App />, "/years/y1/analysis");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Occupancy" }));
    expect(screen.getByText("Rent")).toBeTruthy();
    expect(screen.queryByText(/610/)).toBeNull();
  });

  it("lists the mapping problems when an expense account isn't mapped", async () => {
    stubApi({
      ...routes(null),
      "GET /api/years/y1/analysis": () =>
        jsonResponse(422, {
          code: "analysis_failed",
          message: "The analysis can't be built until every expense account is mapped to a report line.",
          details: [{ code: "unmapped", account: "699" }],
        }),
    });
    renderApp(<App />, "/years/y1/analysis");
    expect(await screen.findByText(/Account 699 has a balance/)).toBeTruthy();
  });
});
