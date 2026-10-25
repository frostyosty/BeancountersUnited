// @vitest-environment jsdom
import type { ClientDetail } from "@acct/types/ClientDetail";
import type { LibraryParagraph } from "@acct/types/LibraryParagraph";
import type { ReportDoc } from "@acct/types/ReportDoc";
import type { YearNoteView } from "@acct/types/YearNoteView";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import fy2026 from "../../../../crates/core/tests/snapshots/fixture__fy2026_reportdoc.snap?raw";
import { App } from "../App";
import { practice, sam } from "../test/data";
import { jsonResponse, renderApp, stubApi } from "../test/render";

const client: ClientDetail = {
  id: "c2",
  name: "Tui Street Joinery",
  entity_type: "sole_trader",
  retained_earnings: "970",
  rounding_priority: [],
  years: [{ id: "y2", client_id: "c2", start: "2025-04-01", end: "2026-03-31", status: "open", books_source: null }],
};

const basis = { key: "basis_of_preparation", placement: "policy" as const, title: "Basis of preparation", body: "For {business_name}." };
const going = { key: "going_concern", placement: "policy" as const, title: "Going concern", body: "Going." };
const tax = { key: "income_tax", placement: "note" as const, title: "Income tax", body: "The owner's tax." };

const library: LibraryParagraph[] = [
  { id: "p1", entity_type: "sole_trader", version: 2, paragraph: basis },
  { id: "p2", entity_type: "sole_trader", version: 1, paragraph: going },
  { id: "p3", entity_type: "sole_trader", version: 1, paragraph: tax },
];

const notes: YearNoteView[] = [
  { paragraph_id: "p1", from_version: 1, latest_version: 2, edited: false, removed: false, paragraph: basis },
  { paragraph_id: "p2", from_version: 1, latest_version: 1, edited: true, removed: false, paragraph: going },
  { paragraph_id: "p9", from_version: 1, latest_version: 1, edited: false, removed: true, paragraph: { ...tax, key: "old", title: "Old note" } },
];

function routes(year = client.years[0]!) {
  return {
    "GET /api/me": () => sam,
    "GET /api/years/y2": () => year,
    "GET /api/clients/c2": () => ({ ...client, years: [year] }),
    "GET /api/clients/c2/chart": () => practice.master_charts[0]!.accounts,
    "GET /api/years/y2/notes": () => notes,
    "GET /api/paragraph-library/sole_trader": () => library,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("notes", () => {
  it("lists the year's copies with where each stands against the library", async () => {
    stubApi(routes());
    renderApp(<App />, "/years/y2/notes");
    const first = await screen.findByRole("region", { name: "Basis of preparation" });
    expect(first.textContent).toContain("Policy, in note 1");
    expect(first.textContent).toContain("the library now has version 2");
    // The wording as written, fields and all.
    expect(first.textContent).toContain("For {business_name}.");
    expect(screen.getByRole("region", { name: "Going concern" }).textContent).toContain("edited for this client");
    expect(screen.getByRole("region", { name: "Old note" }).textContent).toContain("removed from the library");
    // Only what isn't picked is offered.
    const offered = within(screen.getByRole("list", { name: "Library paragraphs" })).getAllByRole("listitem");
    expect(offered.map((li) => li.textContent)).toEqual(["➕ Add Income tax (note of its own)"]);
  });

  it("adds, reorders and drops through pick_notes", async () => {
    const calls = stubApi({ ...routes(), "POST /api/commands": () => ({ seq: 1, entity_id: null }) });
    renderApp(<App />, "/years/y2/notes");
    await userEvent.click(await screen.findByRole("button", { name: "Add Income tax" }));
    await userEvent.click(screen.getByRole("button", { name: "Move Going concern up" }));
    await userEvent.click(screen.getByRole("button", { name: "Drop Old note" }));
    const picks = calls.filter((c) => c.method === "POST").map((c) => (c.body as { payload: unknown }).payload);
    expect(picks).toEqual([
      { client_year_id: "y2", paragraph_ids: ["p1", "p2", "p9", "p3"] },
      { client_year_id: "y2", paragraph_ids: ["p2", "p1", "p9"] },
      { client_year_id: "y2", paragraph_ids: ["p1", "p2"] },
    ]);
    expect(screen.getByRole("button", { name: "Move Basis of preparation up" })).toHaveProperty("disabled", true);
  });

  it("edits the year's copy and shows the server's reasons when it's refused", async () => {
    const calls = stubApi({
      ...routes(),
      "POST /api/commands": () =>
        jsonResponse(422, {
          code: "invalid_paragraph",
          message: "The paragraph has problems.",
          details: [{ code: "unknown_field", paragraph: "basis_of_preparation", field: "owner_name" }],
        }),
    });
    renderApp(<App />, "/years/y2/notes");
    const card = await screen.findByRole("region", { name: "Basis of preparation" });
    await userEvent.click(within(card).getByRole("button", { name: /Edit/ }));
    const wording = within(card).getByRole("textbox", { name: "Wording" });
    await userEvent.clear(wording);
    await userEvent.type(wording, "For {{owner_name}.");
    await userEvent.click(within(card).getByRole("button", { name: "Save this year's copy" }));
    expect(calls.at(-1)!.body).toMatchObject({
      kind: "edit_note",
      payload: { client_year_id: "y2", paragraph_id: "p1", title: "Basis of preparation", body: "For {owner_name}." },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("isn't a field we can fill in");
  });

  it("is read-only in a finalised year", async () => {
    stubApi(routes({ ...client.years[0]!, status: "finalised" }));
    renderApp(<App />, "/years/y2/notes");
    expect((await screen.findByRole("status")).textContent).toContain("finalised");
    await screen.findByRole("region", { name: "Basis of preparation" });
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "Library paragraphs" })).toBeNull();
  });

  it("shows the filled-in notes after the statements", async () => {
    const doc = JSON.parse(fy2026.split("\n---\n")[1]!) as ReportDoc;
    doc.notes = [
      {
        number: 1,
        key: "accounting_policies",
        title: "Statement of accounting policies",
        sections: [{ key: "depreciation", title: "Depreciation", text: ["Rates:", "Tools: 25% diminishing value\nVehicles: 30% diminishing value"] }],
      },
      { number: 2, key: "income_tax", title: "Income tax", sections: [{ key: "income_tax", title: null, text: ["The owner's tax."] }] },
    ];
    stubApi({ ...routes(), "GET /api/years/y2/report": () => doc });
    renderApp(<App />, "/years/y2/statements");
    const notesSection = await screen.findByRole("region", { name: "Notes to the financial statements" });
    const headings = within(notesSection).getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["Notes to the financial statements", "1. Statement of accounting policies", "Depreciation", "2. Income tax"]);
    expect(within(notesSection).getByText(/Vehicles: 30%/).textContent).toBe("Tools: 25% diminishing value\nVehicles: 30% diminishing value");
  });
});
