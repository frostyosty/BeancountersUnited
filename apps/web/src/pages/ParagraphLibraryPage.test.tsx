// @vitest-environment jsdom
import type { LibraryParagraph } from "@acct/types/LibraryParagraph";
import type { PracticeView } from "@acct/types/PracticeView";
import type { PushChange } from "@acct/types/PushChange";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { boss, practice, sam } from "../test/data";
import { renderApp, stubApi } from "../test/render";

const withSoleTrader: PracticeView = {
  ...practice,
  master_charts: [...practice.master_charts, { id: "mc2", entity_type: "sole_trader", name: "Sole trader", accounts: [] }],
};

const basis = { key: "basis_of_preparation", placement: "policy" as const, title: "Basis of preparation", body: "For {business_name}." };
const library: LibraryParagraph[] = [{ id: "p1", entity_type: "sole_trader", version: 3, paragraph: basis }];

const preview: PushChange[] = [
  {
    client_id: "c2",
    client_name: "Tui Street Joinery",
    client_year_id: "y2",
    year_end: "2026-03-31",
    from_version: 2,
    to_version: 3,
    action: "update",
    from: basis,
    to: basis,
  },
  {
    client_id: "c3",
    client_name: "Rata Hill Orchard",
    client_year_id: "y3",
    year_end: "2026-03-31",
    from_version: 1,
    to_version: 3,
    action: "keep_edited",
    from: basis,
    to: basis,
  },
];

function routes() {
  return {
    "GET /api/me": () => boss,
    "GET /api/practice": () => withSoleTrader,
    "GET /api/paragraph-library/sole_trader": () => library,
    "GET /api/paragraph-library/company": () => [],
    "GET /api/paragraphs/p1/push-preview": () => preview,
    "POST /api/commands": () => ({ seq: 1, entity_id: "p2" }),
  };
}

const payloads = (calls: ReturnType<typeof stubApi>) =>
  calls.filter((c) => c.method === "POST").map((c) => c.body as { kind: string; payload: unknown });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("paragraph library", () => {
  it("is for practice admins only", async () => {
    stubApi({ "GET /api/me": () => sam });
    renderApp(<App />, "/settings/paragraphs");
    expect(await screen.findByText(/Only practice admins/)).toBeTruthy();
  });

  it("previews a push, then pushes only the copies it would update", async () => {
    const calls = stubApi(routes());
    renderApp(<App />, "/settings/paragraphs");
    const card = await screen.findByRole("region", { name: "Basis of preparation" });
    expect(card.textContent).toContain("version 3");
    await userEvent.click(within(card).getByRole("button", { name: /Push to open years/ }));
    const table = await within(card).findByRole("table", { name: "Push Basis of preparation" });
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual([
      "Tui Street Joinery31 Mar 2026version 2 to 3update it to the latest wording",
      "Rata Hill Orchard31 Mar 2026version 1 to 3keep it: edited for this client",
    ]);
    await userEvent.click(within(card).getByRole("button", { name: "Push to 1 open year" }));
    expect(payloads(calls)).toEqual([{ id: expect.any(String), kind: "push_paragraph", payload: { paragraph_id: "p1" } }]);
  });

  it("revises, removes after confirming, and adds", async () => {
    const calls = stubApi(routes());
    renderApp(<App />, "/settings/paragraphs");
    const card = await screen.findByRole("region", { name: "Basis of preparation" });

    await userEvent.click(within(card).getByRole("button", { name: /Revise/ }));
    const title = within(card).getByRole("textbox", { name: "Title" });
    await userEvent.clear(title);
    await userEvent.type(title, "Basis of accounting");
    await userEvent.click(within(card).getByRole("button", { name: "Save as a new version" }));

    await userEvent.click(await within(card).findByRole("button", { name: /Remove/ }));
    expect(within(card).getByRole("alertdialog").textContent).toContain("keep their copies");
    await userEvent.click(within(card).getByRole("button", { name: "Remove it" }));

    const add = screen.getByRole("region", { name: "Add a paragraph" });
    await userEvent.type(within(add).getByRole("textbox", { name: /Key/ }), "related_parties");
    await userEvent.type(within(add).getByRole("textbox", { name: "Title" }), "Related parties");
    await userEvent.type(within(add).getByRole("textbox", { name: "Wording" }), "None.");
    await userEvent.click(within(add).getByRole("button", { name: "Add to the library" }));

    expect(payloads(calls).map((c) => [c.kind, c.payload])).toEqual([
      ["revise_paragraph", { paragraph_id: "p1", placement: "policy", title: "Basis of accounting", body: "For {business_name}." }],
      ["remove_paragraph", { paragraph_id: "p1" }],
      [
        "add_paragraph",
        {
          entity_type: "sole_trader",
          paragraph: { key: "related_parties", placement: "note", title: "Related parties", body: "None." },
        },
      ],
    ]);
  });
});
