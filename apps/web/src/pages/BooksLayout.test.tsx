// @vitest-environment jsdom
import type { Account } from "@acct/types/Account";
import type { BusinessView } from "@acct/types/BusinessView";
import type { ClientClassView } from "@acct/types/ClientClassView";
import type { ClientDetail } from "@acct/types/ClientDetail";
import type { DepreciationSettings } from "@acct/types/DepreciationSettings";
import type { GlListing } from "@acct/types/GlListing";
import type { JournalView } from "@acct/types/JournalView";
import type { Me } from "@acct/types/Me";
import type { ReportDoc } from "@acct/types/ReportDoc";
import type { TaxPosition } from "@acct/types/TaxPosition";
import type { YearAssets } from "@acct/types/YearAssets";
import type { YearTrialBalance } from "@acct/types/YearTrialBalance";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fy2026 from "../../../../crates/core/tests/snapshots/fixture__fy2026_reportdoc.snap?raw";
import { App } from "../App";
import { booksPath, hasOpenedAccountantView } from "../lib/books";
import { jsonResponse, renderApp, stubApi } from "../test/render";

// ---- who is looking ----

const owner: Me = { id: "o1", username: "ana@example.com", display_name: "Ana Ngata", role: "business_owner", guest: null };

const guest: Me = {
  id: "g1",
  username: "",
  display_name: "You",
  role: "business_owner",
  guest: { expires_at: "2026-11-12T03:04:05Z", business_id: "b1", example: null },
};

const exampleGuest: Me = {
  ...guest,
  guest: {
    expires_at: "2026-11-07T03:04:05Z",
    business_id: null,
    example: { business_id: "b1", number: 1, expires_at: "2026-11-07T03:04:05Z" },
  },
};

// ---- the business and its books ----

const year = { id: "y1", client_id: "b1", start: "2025-04-01", end: "2026-03-31", status: "open" as const, books_source: "bank_coding" as const };
const olderYear = { ...year, id: "y0", start: "2024-04-01", end: "2025-03-31" };

const client: ClientDetail = {
  id: "b1",
  name: "Marsh Hollow Candles",
  entity_type: "sole_trader",
  is_business: true,
  retained_earnings: "810",
  rounding_priority: [],
  years: [year],
};

const chart: Account[] = [
  { code: "100", name: "Sales", account_type: "income", active: true },
  { code: "210", name: "Depreciation", account_type: "expense", active: true },
  { code: "250", name: "Loss (gain) on disposal", account_type: "expense", active: true },
  { code: "600", name: "Bank", account_type: "asset", active: true },
  { code: "700", name: "Plant at cost", account_type: "asset", active: true },
  { code: "705", name: "Plant accumulated depreciation", account_type: "asset", active: true },
];

const doc = JSON.parse(fy2026.split("\n---\n")[1]!) as ReportDoc;

const journals: JournalView[] = [
  {
    id: "j1",
    kind: "manual",
    date: "2025-06-30",
    narration: "Sale of candles",
    lines: [
      { account: "600", amount: 10_000 },
      { account: "100", amount: -10_000 },
    ],
    reverses_journal_id: null,
    reversed_by: null,
    posted_seq: 1,
  },
];

const tb: YearTrialBalance = {
  opening: [],
  closing: [
    { account: "600", balance: 10_000 },
    { account: "100", balance: -10_000 },
  ],
};

const gl: GlListing = {
  accounts: [
    {
      code: "100",
      name: "Sales",
      opening: 0,
      closing: -10_000,
      entries: [
        { journal_id: "j1", kind: "manual", date: "2025-06-30", narration: "Sale of candles", amount: -10_000, balance: -10_000, matched_reversal: false },
      ],
    },
  ],
};

const dv15: DepreciationSettings = {
  method: { kind: "dv", rate_bp: 1500 },
  part_year: { kind: "months_held", count_acquisition_month: true },
  disposal_year: "to_disposal_date",
};
const assetAccounts = { cost: "700", accumulated: "705", expense: "210", gain_loss: "250" };

const classes: ClientClassView[] = [
  {
    class: { id: "k1", entity_type: "sole_trader", key: "plant", name: "Plant and equipment", settings: dv15, accounts: assetAccounts },
    override_settings: null,
    override_accounts: null,
    resolved: { settings: dv15, source: "practice", accounts: assetAccounts },
  },
];

const register: YearAssets = {
  assets: [
    {
      asset: {
        id: "a1",
        class_id: "k1",
        name: "Wax melter",
        cost: 184_995,
        residual: 0,
        acquired: "2025-05-05",
        settings: dv15,
        rate_source: "practice",
        accounts: assetAccounts,
        opening: null,
        disposal: null,
        fixed: false,
      },
      movements: {
        opening_cost: 0,
        additions: 184_995,
        disposals: 0,
        closing_cost: 184_995,
        opening_accumulated: 0,
        depreciation: 27_749,
        disposal_accumulated: 0,
        closing_accumulated: 27_749,
        gain: null,
      },
    },
  ],
  status: "stale",
  stale_earlier_years: [],
  journals: [],
  reconciliation: [{ account: "700", register: 184_995, ledger: 184_995 }],
};

const tax: TaxPosition = { total: 123400, gst: [], income: [], notices: [] };

function businessView(): BusinessView {
  return {
    client_id: "b1",
    name: client.name,
    start_date: "2025-04-01",
    gst_registered_from: null,
    gst_frequency: null,
    bank_accounts: [],
    transfers: [],
    ird_payments: [],
    possible_duplicates: [],
  } as unknown as BusinessView;
}

/** Every read the accountant view makes; the layout is here only so a test can see it's never asked. */
function routes(me: Me, extra: Record<string, () => unknown> = {}) {
  return {
    "GET /api/me": () => me,
    "GET /api/clients/b1": () => client,
    "GET /api/clients/b1/chart": () => chart,
    "GET /api/years/y1/report": () => doc,
    "GET /api/years/y1/layout": () => ({}),
    "GET /api/years/y1/tb": () => tb,
    "GET /api/years/y1/journals": () => journals,
    "GET /api/years/y1/gl": () => gl,
    "GET /api/years/y1/assets": () => register,
    "GET /api/clients/b1/asset-classes": () => classes,
    "GET /api/businesses/b1": businessView,
    "GET /api/businesses/b1/tax": () => tax,
    ...extra,
  };
}

const paths = (calls: ReturnType<typeof stubApi>) => calls.map((c) => `${c.method} ${c.path}`);

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the switch on the business screen", () => {
  it("is Your view · Accountant view for a claimed owner, and opens the statements", async () => {
    stubApi(routes(owner));
    renderApp(<App />, "/businesses/b1");
    const nav = await screen.findByRole("navigation", { name: "View" });
    expect(within(nav).getByRole("link", { name: /Your view/ }).getAttribute("aria-current")).toBe("page");
    const link = within(nav).getByRole("link", { name: /Accountant view/ });
    expect(link.getAttribute("href")).toBe("/businesses/b1/books/statements");
    expect(link.getAttribute("aria-current")).toBeNull();
  });

  it("is there for a guest, on their own trial and on an example", async () => {
    stubApi(routes(guest));
    renderApp(<App />, "/businesses/b1");
    const own = await screen.findByRole("navigation", { name: "View" });
    expect(within(own).getByRole("link", { name: /Accountant view/ }).getAttribute("href")).toBe("/businesses/b1/books/statements");
    cleanup();
    stubApi(routes(exampleGuest));
    renderApp(<App />, "/businesses/b1");
    const example = await screen.findByRole("navigation", { name: "View" });
    expect(within(example).getByRole("link", { name: /Accountant view/ })).toBeTruthy();
  });
});

describe("deep links", () => {
  it("builds /businesses/{id}/books/{view}, the statements by default", () => {
    expect(booksPath("b1")).toBe("/businesses/b1/books/statements");
    expect(booksPath("b1", "statements")).toBe("/businesses/b1/books/statements");
    expect(booksPath("b1", "tb")).toBe("/businesses/b1/books/tb");
    expect(booksPath("b1", "journals")).toBe("/businesses/b1/books/journals");
    expect(booksPath("b1", "changes")).toBe("/businesses/b1/books/changes");
  });

  it("opens each view straight from its address", async () => {
    stubApi(routes(guest));
    renderApp(<App />, booksPath("b1", "tb"));
    expect((await screen.findAllByText("Sales")).length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Opening" })).toBeTruthy();
    cleanup();
    stubApi(routes(guest));
    renderApp(<App />, booksPath("b1", "journals"));
    expect(await screen.findByRole("button", { name: "Sale of candles" })).toBeTruthy();
    cleanup();
    stubApi(routes(guest));
    renderApp(<App />, booksPath("b1", "changes"));
    expect(await screen.findByRole("heading", { name: /Changes/ })).toBeTruthy();
  });

  it("sends /books on its own to the statements", async () => {
    stubApi(routes(owner));
    renderApp(<App />, "/businesses/b1/books");
    expect(await screen.findByRole("heading", { name: "Statement of Financial Performance" })).toBeTruthy();
  });
});

describe("the accountant view", () => {
  it("says what it is, goes back to the tax, and has the six tabs", async () => {
    stubApi(routes(owner));
    renderApp(<App />, booksPath("b1"));
    expect(await screen.findByRole("heading", { name: "Marsh Hollow Candles" })).toBeTruthy();
    expect(
      screen.getByText("This is what your accountant sees. They work on these same books, so nothing gets typed in twice."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Back to your tax/ }).getAttribute("href")).toBe("/businesses/b1");
    const tabs = within(screen.getByRole("navigation", { name: "Books" })).getAllByRole("link").map((a) => a.textContent?.trim());
    // The studio may swap an icon for an image, so the label can come with or without a glyph.
    for (const label of ["Statements", "Trial balance", "Journals", "General ledger", "Assets"]) {
      expect(tabs.some((t) => t?.endsWith(label))).toBe(true);
    }
    expect(tabs).toHaveLength(5);
    // The accountant's write-side tabs are not mounted at all.
    for (const name of [/Import TB/, /Notes/, /Reconcile/, /Analysis/, /Finalise/]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    const switcher = screen.getByRole("navigation", { name: "View" });
    expect(within(switcher).getByRole("link", { name: /Accountant view/ }).getAttribute("aria-current")).toBe("page");
  });

  it("has no practice crumbs", async () => {
    stubApi(routes(owner));
    renderApp(<App />, booksPath("b1"));
    await screen.findByRole("heading", { name: "Marsh Hollow Candles" });
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("says there are no books yet when the business has no year", async () => {
    stubApi(routes(owner, { "GET /api/clients/b1": () => ({ ...client, years: [] }) }));
    renderApp(<App />, booksPath("b1"));
    expect(await screen.findByText("No books yet")).toBeTruthy();
    expect(screen.getByText(/Upload a bank statement and they fill in/)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Books" })).toBeNull();
  });

  it("opens the latest year and lets a second year be picked", async () => {
    const reads: string[] = [];
    stubApi(
      routes(owner, {
        "GET /api/clients/b1": () => ({ ...client, years: [olderYear, year] }),
        "GET /api/years/y0/report": () => {
          reads.push("y0");
          return doc;
        },
        "GET /api/years/y1/report": () => {
          reads.push("y1");
          return doc;
        },
      }),
    );
    renderApp(<App />, booksPath("b1"));
    const picker = (await screen.findByRole("combobox", { name: "Year" })) as HTMLSelectElement;
    expect(picker.value).toBe("y1");
    await screen.findByRole("heading", { name: "Statement of Financial Performance" });
    expect(reads).toEqual(["y1"]);
    await userEvent.setup().selectOptions(picker, "y0");
    await waitFor(() => expect(reads).toContain("y0"));
  });

  it("is read-only through one context: no layout move on the statements", async () => {
    const calls = stubApi(routes(owner));
    renderApp(<App />, booksPath("b1"));
    await screen.findByRole("heading", { name: "Statement of Financial Performance" });
    expect(screen.queryByRole("region", { name: "Statement layout" })).toBeNull();
    expect(paths(calls)).not.toContain("GET /api/years/y1/layout");
  });
});

describe("the PDF", () => {
  it("is a download for a claimed owner", async () => {
    stubApi(routes(owner));
    renderApp(<App />, booksPath("b1"));
    const link = await screen.findByRole("link", { name: "Download PDF" });
    expect(link.getAttribute("href")).toBe("/api/years/y1/report.pdf");
    expect(screen.getByText(/A draft until the year is finalised/)).toBeTruthy();
  });

  it("is locked for a guest with the reason and a Save your work button", async () => {
    stubApi(routes(guest));
    renderApp(<App />, booksPath("b1"));
    await screen.findByRole("heading", { name: "Statement of Financial Performance" });
    expect(screen.queryByRole("link", { name: "Download PDF" })).toBeNull();
    const note = screen.getByText("Save your work to download the PDF.").closest("p")!;
    expect(within(note).getByRole("button", { name: /Save your work/ })).toBeTruthy();
  });

  it("says an example has no PDF and points at the visitor's own statement", async () => {
    stubApi(routes(exampleGuest));
    renderApp(<App />, booksPath("b1"));
    await screen.findByRole("heading", { name: "Statement of Financial Performance" });
    expect(screen.queryByRole("link", { name: "Download PDF" })).toBeNull();
    expect(screen.queryByText(/Save your work to download the PDF/)).toBeNull();
    const text = screen.getByText(/This is an example, so there's no PDF/).closest("span")!;
    expect(within(text).getByRole("link", { name: "Try it with your own statement." }).getAttribute("href")).toBe("/");
  });
});

describe("each tab is read-only", () => {
  it("journals: no new-journal form and no reverse button", async () => {
    stubApi(routes(owner));
    renderApp(<App />, booksPath("b1", "journals"));
    await screen.findByRole("button", { name: "Sale of candles" });
    expect(screen.queryByRole("form", { name: "New journal" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Post journal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reverse/ })).toBeNull();
  });

  it("assets: the register, with no add, edit, dispose, delete, depreciation or defaults buttons", async () => {
    stubApi(routes(owner));
    renderApp(<App />, booksPath("b1", "assets"));
    const reg = await screen.findByRole("table", { name: "Register" });
    expect(within(reg).getByText("Wax melter")).toBeTruthy();
    for (const name of [/Add an asset/, /Run depreciation/, /Edit/, /Dispose/, /Delete/, /Reinstate/, /Override/, /Apply to existing/]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    // The class defaults are still there to read.
    expect(screen.getByRole("table", { name: "Class defaults" })).toBeTruthy();
  });

  it("trial balance and general ledger: the books, with account codes", async () => {
    stubApi(routes(guest));
    renderApp(<App />, booksPath("b1", "tb"));
    const row = (await screen.findByText("Bank")).closest("tr")!;
    expect(row.textContent).toContain("600");
    cleanup();
    stubApi(routes(guest));
    renderApp(<App />, booksPath("b1", "gl"));
    expect(await screen.findByRole("heading", { name: "100 Sales" })).toBeTruthy();
  });

  it("changes: the feed, with nothing to change a setting", async () => {
    stubApi(routes(owner));
    renderApp(<App />, booksPath("b1", "changes"));
    expect(await screen.findByText(/No changes yet/)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Let my accountant see/ })).toBeNull();
  });
});

describe("when the statements can't be shown", () => {
  it("says the layout doesn't cover every account, without the mapping's details", async () => {
    stubApi(
      routes(owner, {
        "GET /api/years/y1/report": () =>
          jsonResponse(422, {
            code: "report_failed",
            message: "The statements can't be built",
            details: [{ code: "unmapped", account: "999" }],
          }),
      }),
    );
    renderApp(<App />, booksPath("b1"));
    expect(await screen.findByText(/layout your accountant uses doesn't cover every account/)).toBeTruthy();
    expect(screen.getByText(/The trial balance, journals and ledger are all here/)).toBeTruthy();
    expect(screen.queryByText(/999/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the server's plain message when there is no layout", async () => {
    stubApi(
      routes(guest, {
        "GET /api/years/y1/report": () =>
          jsonResponse(422, { code: "no_layout", message: "There's no statement layout for this business yet.", details: null }),
      }),
    );
    renderApp(<App />, booksPath("b1"));
    expect(await screen.findByText("There's no statement layout for this business yet.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("remembering that a guest looked", () => {
  it("notes it for a guest, keyed by their user id", async () => {
    stubApi(routes(guest));
    expect(hasOpenedAccountantView("g1")).toBe(false);
    renderApp(<App />, booksPath("b1"));
    await screen.findByRole("heading", { name: "Marsh Hollow Candles" });
    expect(hasOpenedAccountantView("g1")).toBe(true);
    expect(hasOpenedAccountantView("g2")).toBe(false);
  });

  it("notes nothing for a claimed owner, and the page works when storage is blocked", async () => {
    stubApi(routes(owner));
    renderApp(<App />, booksPath("b1"));
    await screen.findByRole("heading", { name: "Marsh Hollow Candles" });
    expect(localStorage.length).toBe(0);
    cleanup();

    const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const blockedGet = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    stubApi(routes(guest));
    renderApp(<App />, booksPath("b1"));
    expect(await screen.findByRole("heading", { name: "Marsh Hollow Candles" })).toBeTruthy();
    expect(hasOpenedAccountantView("g1")).toBe(false);
    blocked.mockRestore();
    blockedGet.mockRestore();
  });
});
