// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import type { Me } from "@acct/types/Me";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../lib/queryClient";
import { stubApi } from "../test/render";
import { FeaturesPage } from "./FeaturesPage";

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
    "POST /api/guest": () => ({ me: exampleTrial, business_id: "x1", accepted: { seq: 1, entity_id: "x1" } }),
    "GET /api/businesses/b1": () => business("b1", null),
    "GET /api/businesses/b1/tax": () => ({ total: 900_000, gst: [], income: [], notices: [] }),
    "GET /api/businesses/b1/save-tax": () => ({ total: 900_000, conservative_total: 900_000, saved_so_far: 0, cards: [] }),
    "GET /api/businesses/x1": () => business("x1", 1),
    "GET /api/businesses/x1/tax": () => ({ total: 911_151, gst: [], income: [], notices: [] }),
    "GET /api/businesses/x1/save-tax": () => ({ total: 911_151, conservative_total: 911_151, saved_so_far: 0, cards: [] }),
  });
}

function Where() {
  const { pathname, hash } = useLocation();
  return <p>at {pathname + hash}</p>;
}

function renderPage(me: Me | null) {
  const client = makeQueryClient();
  if (me) client.setQueryData(["me"], me);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/features"]}>
        <Routes>
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const steps = () => within(screen.getAllByRole("list")[0]!);
const group = (name: string) => within(screen.getByRole("region", { name }));

describe("the features page", () => {
  it("shows the four steps, as on the home page", () => {
    server(null);
    renderPage(null);
    for (const title of ["Upload bank statements", "See your tax, any day", "Save tax", "File tax"]) {
      expect(steps().getByRole("heading", { name: title })).toBeTruthy();
    }
  });

  it("sends Upload to the home page's drop", async () => {
    server(null);
    renderPage(null);
    await userEvent.setup().click(steps().getByRole("link", { name: /Try it on the home page/ }));
    expect(await screen.findByText("at /#features")).toBeTruthy();
  });

  it("with no trial, a step loads Example 1 and opens that screen", async () => {
    const calls = server(null);
    renderPage(null);
    const save = steps().getAllByRole("button")[1]!;
    expect(save.textContent).toContain("See it on an example");
    await userEvent.setup().click(save);
    expect(await screen.findByText("at /businesses/x1/save-tax")).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/guest")!.body).toMatchObject({ source: { example: 1 } });
  });

  it("with their own trial, a feature opens it at once and loads nothing", async () => {
    const calls = server(ownTrial);
    renderPage(ownTrial);
    const go = group("Proper books underneath").getAllByRole("button")[2]!;
    expect(go.textContent).toContain("Try it now");
    await userEvent.setup().click(go);
    expect(await screen.findByText("at /businesses/b1/books/changes")).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/guest")).toBe(false);
  });

  it("an example guest opens the example they're trying", async () => {
    server(exampleTrial);
    renderPage(exampleTrial);
    const go = group("Saving tax").getAllByRole("button")[0]!;
    expect(go.textContent).toContain("Try it now");
    await userEvent.setup().click(go);
    expect(await screen.findByText("at /businesses/x1/save-tax")).toBeTruthy();
  });

  it("says which features need a free account and which are coming", () => {
    server(null);
    renderPage(null);
    const filing = group("Filing");
    expect(filing.getByText(/Needs a free account/)).toBeTruthy();
    expect(filing.getByText(/Coming soon/)).toBeTruthy();
    expect(group("Saving tax").getByText(/Needs a free account/)).toBeTruthy();
    expect(group("Knowing your tax").getAllByText(/Try it now/)).toHaveLength(2);
    // Nothing on the page says "Needs an account" without "free".
    expect(screen.queryByText(/Needs an account/)).toBeNull();
  });

  it("a failed load opens nothing, and says why", async () => {
    stubApi({
      "GET /api/me": () => null,
      "GET /api/examples": () => [],
      "POST /api/guest": () =>
        new Response(JSON.stringify({ code: "guest_limit", message: "Too many trials from your network.", details: null }), { status: 429 }),
    });
    renderPage(null);
    const go = steps().getAllByRole("button")[0]!;
    await userEvent.setup().click(go);
    expect((await screen.findByRole("alert")).textContent).toContain("Too many trials from your network.");
    expect(go.textContent).toContain("See it on an example");
    expect(screen.queryByText(/^at /)).toBeNull();
  });
});
