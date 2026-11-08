// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import type { Me } from "@acct/types/Me";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../lib/queryClient";
import { stubApi } from "../test/render";
import { HomePage } from "./HomePage";

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const business = (id: string, example: number | null) =>
  ({
    client_id: id,
    name: "Your business",
    start_date: "2025-04-01",
    gst_registered_from: null,
    gst_frequency: null,
    gst_source: "none",
    gst_evidence: null,
    example,
    bank_accounts: [],
    transfers: [],
    ird_payments: [],
    possible_duplicates: [],
  }) as unknown as BusinessView;

/** A guest with their own file (b1) or just Example 1 (x1). */
const ownTrial: Me = {
  id: "g1",
  username: "",
  display_name: "You",
  role: "business_owner",
  guest: { expires_at: "2026-11-13T00:00:00Z", business_id: "b1", example: null },
};
const exampleTrial: Me = {
  ...ownTrial,
  guest: { expires_at: "2026-11-10T00:00:00Z", business_id: null, example: { business_id: "x1", number: 1, expires_at: "2026-11-10T00:00:00Z" } },
};

function server(me: Me | null) {
  return stubApi({
    "GET /api/me": () => me,
    "GET /api/examples": () => [],
    // Starting Example 1 makes a guest whose business is x1.
    "POST /api/guest": () => ({ me: exampleTrial, business_id: "x1", accepted: { seq: 1, entity_id: "x1" } }),
    "GET /api/businesses/b1": () => business("b1", null),
    "GET /api/businesses/b1/tax": () => ({ total: 900_000, gst: [], income: [], notices: [] }),
    "GET /api/businesses/b1/save-tax": () => ({ total: 900_000, conservative_total: 900_000, saved_so_far: 0, cards: [] }),
    "GET /api/businesses/x1": () => business("x1", 1),
    "GET /api/businesses/x1/tax": () => ({ total: 911_151, gst: [], income: [], notices: [] }),
    "GET /api/businesses/x1/save-tax": () => ({ total: 911_151, conservative_total: 911_151, saved_so_far: 0, cards: [] }),
  });
}

function Opened() {
  const { id, view } = useParams();
  return <p>opened {view} of {id}</p>;
}

function renderHome(me: Me | null) {
  const client = makeQueryClient();
  if (me) client.setQueryData(["me"], me);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/businesses/:id/books/:view" element={<Opened />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const TILES = [
  { name: /Real double-entry books/, view: "journals" },
  { name: /Statements that foot/, view: "statements" },
  { name: /Who changed what/, view: "changes" },
] as const;

describe("the accountant tiles on the home page", () => {
  it("are real buttons, reachable by keyboard and touch", () => {
    server(null);
    renderHome(null);
    for (const { name } of TILES) {
      const tile = screen.getByRole("button", { name });
      expect(tile.tagName).toBe("BUTTON");
      expect(tile.getAttribute("type")).toBe("button");
    }
  });

  it.each(TILES)("with no trial, $view loads Example 1 and opens once it's ready", async ({ name, view }) => {
    const calls = server(null);
    renderHome(null);
    const tile = screen.getByRole("button", { name });
    expect(tile.textContent).toContain("See it on an example");
    await userEvent.setup().click(tile);
    expect(tile.textContent).toContain("Opening…");

    // The page's own loader runs its two seconds first; nothing opens before the example is ready.
    expect(screen.queryByText(/^opened /)).toBeNull();
    expect(await screen.findByText(`opened ${view} of x1`, {}, { timeout: 5_000 })).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/guest")!.body).toMatchObject({ source: { example: 1 } });
  });

  it.each(TILES)("with their own trial, $view opens it at once and loads nothing", async ({ name, view }) => {
    const calls = server(ownTrial);
    renderHome(ownTrial);
    const tile = await screen.findByRole("button", { name });
    await waitFor(() => expect(tile.textContent).toContain("Open it"));
    await userEvent.setup().click(tile);
    expect(await screen.findByText(`opened ${view} of b1`)).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/guest")).toBe(false);
  });

  it("open by keyboard", async () => {
    server(ownTrial);
    renderHome(ownTrial);
    const tile = await screen.findByRole("button", { name: /Statements that foot/ });
    await waitFor(() => expect(tile.textContent).toContain("Open it"));
    tile.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(await screen.findByText("opened statements of b1")).toBeTruthy();
  });

  it("an example guest's tile opens the example they're trying", async () => {
    const calls = server(exampleTrial);
    renderHome(exampleTrial);
    const tile = await screen.findByRole("button", { name: /Real double-entry books/ });
    await waitFor(() => expect(tile.textContent).toContain("Open it"));
    await userEvent.setup().click(tile);
    expect(await screen.findByText("opened journals of x1")).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/guest")).toBe(false);
  });

  it("a failed load opens nothing, and shows its error", async () => {
    stubApi({
      "GET /api/me": () => null,
      "GET /api/examples": () => [],
      "POST /api/guest": () => new Response(JSON.stringify({ code: "guest_limit", message: "Too many trials from your network.", details: null }), { status: 429 }),
    });
    renderHome(null);
    await userEvent.setup().click(screen.getByRole("button", { name: /Statements that foot/ }));
    expect(await screen.findByText(/Too many trials from your network/)).toBeTruthy();
    expect(screen.queryByText(/^opened /)).toBeNull();
    expect(screen.getByRole("button", { name: /Statements that foot/ }).textContent).toContain("See it on an example");
  });
});
