// @vitest-environment jsdom
import type { TbImportPreview } from "@acct/types/TbImportPreview";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { practice, sam, widgets } from "../test/data";
import { renderApp, stubApi } from "../test/render";

const accounts = practice.master_charts[0]!.accounts;
const year = { ...widgets.years[0]!, books_source: null };

const clean: TbImportPreview = {
  rows: [
    { row: 2, code: "810", name: "Retained earnings", balance: 5000 },
    { row: 3, code: "100", name: "Sales", balance: -5000 },
  ],
  file_errors: [],
  problems: [],
  lines: [
    { account: "100", amount: -5000 },
    { account: "810", amount: 5000 },
  ],
  replaces_journal_id: null,
  unchanged: false,
  retained_earnings_gap: null,
};

function routes(preview: TbImportPreview, extra: Record<string, () => unknown> = {}) {
  return {
    "GET /api/me": () => sam,
    "GET /api/years/y1": () => year,
    "GET /api/clients/c1": () => widgets,
    "GET /api/clients/c1/chart": () => accounts,
    "POST /api/years/y1/tb-import/preview": () => preview,
    ...extra,
  };
}

async function upload(csv: string) {
  const user = userEvent.setup();
  const input = await screen.findByLabelText("CSV file");
  await user.upload(input, new File([csv], "tb.csv", { type: "text/csv" }));
  return user;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TB import", () => {
  it("previews the file, then imports the rows it showed", async () => {
    const calls = stubApi(
      routes(clean, {
        "POST /api/commands": () => ({ seq: 3, entity_id: "j9" }),
        "GET /api/years/y1/tb": () => ({ opening: [], closing: [] }),
      }),
    );
    renderApp(<App />, "/years/y1/import");
    const csv = "code,name,amount\n810,Retained earnings,50\n100,Sales,-50\n";
    const user = await upload(csv);

    expect(await screen.findByText("The journal this posts (2 lines)")).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith("/preview"))!.body).toBe(csv);
    await user.click(screen.getByRole("button", { name: "Import" }));
    await vi.waitFor(() => expect(calls.some((c) => c.path === "/api/commands")).toBe(true));
    expect(calls.find((c) => c.path === "/api/commands")!.body).toMatchObject({
      kind: "import_tb",
      payload: {
        client_year_id: "y1",
        rows: [
          { account: "810", balance: 5000 },
          { account: "100", balance: -5000 },
        ],
      },
    });
    // Then it shows the trial balance.
    expect(await screen.findByText("Nothing posted yet.")).toBeTruthy();
  });

  it("shows file errors against the file's own rows", async () => {
    stubApi(
      routes({
        ...clean,
        rows: [],
        file_errors: [{ code: "bad_amount", row: 3, column: "amount", value: "12x", message: "not a number" }],
      }),
    );
    renderApp(<App />, "/years/y1/import");
    await upload("code,name,amount\n810,RE,50\n100,Sales,12x\n");
    const row = (await screen.findByText('"12x" in amount isn\'t an amount: not a number')).closest("tr")!;
    expect(row.textContent).toContain("100,Sales,12x");
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
  });

  it("puts account problems on their row and blocks the import", async () => {
    stubApi(
      routes({
        ...clean,
        rows: [...clean.rows, { row: 4, code: "999", name: "Mystery", balance: 0 }],
        problems: [{ code: "unknown_account", account: "999" }],
      }),
    );
    renderApp(<App />, "/years/y1/import");
    await upload("x");
    const row = (await screen.findByText(/999 isn't in the client's chart/)).closest("tr")!;
    expect(row.textContent).toContain("Mystery");
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns about a retained earnings gap but still allows the import", async () => {
    stubApi(
      routes({
        ...clean,
        retained_earnings_gap: { account: "810", imported: 5000, rolled_forward: 4000, difference: 1000 },
      }),
    );
    renderApp(<App />, "/years/y1/import");
    await upload("x");
    expect((await screen.findByRole("status")).textContent).toContain("a difference of 10.00");
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when importing would change nothing", async () => {
    stubApi(routes({ ...clean, unchanged: true, replaces_journal_id: "j1" }));
    renderApp(<App />, "/years/y1/import");
    await upload("x");
    expect(await screen.findByText(/importing it would change nothing/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
