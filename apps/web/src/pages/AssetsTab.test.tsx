// @vitest-environment jsdom
import type { ClientClassView } from "@acct/types/ClientClassView";
import type { DepreciationSettings } from "@acct/types/DepreciationSettings";
import type { YearAssets } from "@acct/types/YearAssets";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { sam, val, widgets } from "../test/data";
import { renderApp, stubApi } from "../test/render";

const dv15: DepreciationSettings = {
  method: { kind: "dv", rate_bp: 1500 },
  part_year: { kind: "months_held", count_acquisition_month: true },
  disposal_year: "to_disposal_date",
};
const accounts = { cost: "700", accumulated: "705", expense: "210", gain_loss: "250" };
const chart = [
  { code: "210", name: "Depreciation", account_type: "expense" as const, active: true },
  { code: "250", name: "Loss (gain) on disposal", account_type: "expense" as const, active: true },
  { code: "600", name: "Bank", account_type: "asset" as const, active: true },
  { code: "700", name: "Plant at cost", account_type: "asset" as const, active: true },
  { code: "705", name: "Plant accumulated depreciation", account_type: "asset" as const, active: true },
];

const classes: ClientClassView[] = [
  {
    class: { id: "k1", entity_type: "company", key: "plant", name: "Plant and equipment", settings: dv15, accounts },
    override_settings: null,
    override_accounts: null,
    resolved: { settings: dv15, source: "practice", accounts },
  },
];

const register: YearAssets = {
  assets: [
    {
      asset: {
        id: "a1",
        class_id: "k1",
        name: "Packing machine",
        cost: 1_849_950,
        residual: 0,
        acquired: "2024-04-05",
        settings: dv15,
        rate_source: "practice",
        accounts,
        opening: null,
        disposal: null,
        fixed: false,
      },
      movements: {
        opening_cost: 0,
        additions: 1_849_950,
        disposals: 0,
        closing_cost: 1_849_950,
        opening_accumulated: 0,
        depreciation: 277_493,
        disposal_accumulated: 0,
        closing_accumulated: 277_493,
        gain: null,
      },
    },
  ],
  status: "stale",
  stale_earlier_years: [],
  journals: [
    {
      date: "2025-03-31",
      narration: "Depreciation for the year",
      lines: [
        { account: "210", amount: 277_493 },
        { account: "705", amount: -277_493 },
      ],
    },
  ],
  reconciliation: [
    { account: "700", register: 1_849_950, ledger: 1_849_950 },
    { account: "705", register: -277_493, ledger: 0 },
  ],
};

function routes(me: unknown) {
  return {
    "GET /api/me": () => me,
    "GET /api/years/y1": () => widgets.years[0],
    "GET /api/clients/c1": () => widgets,
    "GET /api/clients/c1/chart": () => chart,
    "GET /api/years/y1/assets": () => register,
    "GET /api/clients/c1/asset-classes": () => classes,
    "POST /api/commands": () => ({ seq: 1, entity_id: "new" }),
  };
}

function posts(calls: ReturnType<typeof stubApi>) {
  return calls.filter((c) => c.path === "/api/commands").map((c) => c.body);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("assets tab", () => {
  it("shows the register, the journals to post and the reconciliation", async () => {
    stubApi(routes(sam));
    renderApp(<App />, "/years/y1/assets");
    const reg = await screen.findByRole("table", { name: "Register" });
    const row = within(reg).getByText("Packing machine").closest("tr")!;
    expect(row.textContent).toContain("DV 15% (practice)");
    expect(row.textContent).toContain("2,774.93");
    expect(row.textContent).toContain("15,724.57");
    expect(screen.getByRole("status").textContent).toContain("has changed since depreciation was last posted");
    const journal = screen.getByRole("table", { name: "Depreciation for the year" });
    expect(within(journal).getAllByRole("row").map((r) => r.textContent)).toEqual([
      "210Depreciation2,774.93",
      "705Plant accumulated depreciation2,774.93",
    ]);
    const rec = screen.getByRole("table", { name: "Reconciliation" });
    expect(within(rec).getAllByRole("row")[2]!.textContent).toContain("2,774.93");
  });

  it("runs depreciation, adds an asset with custom settings and disposes of one", async () => {
    const calls = stubApi(routes(sam));
    renderApp(<App />, "/years/y1/assets");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Run depreciation" }));

    await user.click(screen.getByRole("button", { name: "Add an asset…" }));
    await user.type(screen.getByLabelText("Asset name"), "Forklift");
    await user.type(screen.getByLabelText("Cost"), "12,000");
    await user.type(screen.getByLabelText("Acquired"), "2024-10-01");
    await user.click(screen.getByLabelText(/Custom settings/));
    await user.selectOptions(screen.getByLabelText("Method"), "sl");
    await user.selectOptions(screen.getByLabelText("Straight line on"), "life");
    await user.type(screen.getByLabelText("Life (months)"), "60");
    await user.click(screen.getByRole("button", { name: "Add asset" }));

    await user.click(screen.getByRole("button", { name: "Dispose…" }));
    await user.type(screen.getByLabelText("Disposal date"), "2025-01-31");
    await user.clear(screen.getByLabelText("Proceeds"));
    await user.type(screen.getByLabelText("Proceeds"), "15,000");
    await user.selectOptions(screen.getByLabelText("Proceeds account"), "600");
    await user.click(screen.getByRole("button", { name: "Dispose" }));

    await vi.waitFor(() => expect(posts(calls)).toHaveLength(3));
    expect(posts(calls)).toMatchObject([
      { kind: "run_depreciation", payload: { client_year_id: "y1" } },
      {
        kind: "create_asset",
        payload: {
          client_id: "c1",
          class_id: "k1",
          name: "Forklift",
          cost: 1_200_000,
          residual: 0,
          acquired: "2024-10-01",
          settings: { method: { kind: "sl", basis: { kind: "life", months: 60 } } },
        },
      },
      {
        kind: "dispose_asset",
        payload: { asset_id: "a1", disposal: { date: "2025-01-31", proceeds: 1_500_000, proceeds_account: "600" } },
      },
    ]);
  });

  it("previews and applies a class's defaults", async () => {
    const calls = stubApi({
      ...routes(sam),
      "GET /api/clients/c1/asset-classes/k1/apply-preview": () => [
        {
          asset_id: "a1",
          name: "Packing machine",
          rate_source: "practice",
          settings_from: dv15,
          settings_to: { ...dv15, method: { kind: "dv", rate_bp: 1800 } },
          accounts_from: accounts,
          accounts_to: accounts,
        },
      ],
    });
    renderApp(<App />, "/years/y1/assets");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Apply to existing assets…" }));
    const changes = await screen.findByRole("table", { name: "Changes" });
    expect(within(changes).getAllByRole("row")[1]!.textContent).toBe("Packing machineDV 15%DV 18%unchanged");
    await user.click(screen.getByRole("button", { name: "Apply to 1 asset" }));
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "apply_asset_class_defaults", payload: { client_id: "c1", class_id: "k1" } });
  });

  it("is read-only for viewers", async () => {
    stubApi(routes(val));
    renderApp(<App />, "/years/y1/assets");
    await screen.findByRole("table", { name: "Register" });
    expect(screen.queryByRole("button", { name: "Run depreciation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add an asset…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
  });
});
