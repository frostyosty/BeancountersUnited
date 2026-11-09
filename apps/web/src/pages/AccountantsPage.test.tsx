// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import type { Me } from "@acct/types/Me";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../lib/queryClient";
import { stubApi } from "../test/render";
import { AccountantsPage } from "./AccountantsPage";

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
      <MemoryRouter initialEntries={["/accountants"]}>
        <Routes>
          <Route path="/accountants" element={<AccountantsPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const VIEWS = [
  { name: /Statements that foot/, view: "statements" },
  { name: /Trial balance/, view: "tb" },
  { name: /Journals/, view: "journals" },
  { name: /General ledger/, view: "gl" },
  { name: /Asset register/, view: "assets" },
  { name: /Who changed what/, view: "changes" },
] as const;

describe("the accountants page", () => {
  it.each(VIEWS)("with no trial, $view loads Example 1 and opens it", async ({ name, view }) => {
    const calls = server(null);
    renderPage(null);
    const tile = screen.getByRole("button", { name });
    expect(tile.textContent).toContain("See it on an example");
    await userEvent.setup().click(tile);
    expect(await screen.findByText(`at /businesses/x1/books/${view}`)).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/guest")!.body).toMatchObject({ source: { example: 1 } });
  });

  it("with their own trial, a tile opens it at once and loads nothing", async () => {
    const calls = server(ownTrial);
    renderPage(ownTrial);
    const tile = screen.getByRole("button", { name: /General ledger/ });
    await waitFor(() => expect(tile.textContent).toContain("Open it"));
    await userEvent.setup().click(tile);
    expect(await screen.findByText("at /businesses/b1/books/gl")).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/guest")).toBe(false);
  });

  it("offers the sample PDF to anyone, with no sign-in", () => {
    server(null);
    renderPage(null);
    const link = screen.getByRole("link", { name: /Download the sample PDF/ });
    expect(link.getAttribute("href")).toBe("/samples/sample-statements.pdf");
  });

  it("answers whether clients can mess up the books", () => {
    server(null);
    renderPage(null);
    expect(screen.getByRole("heading", { name: "Will my clients mess up the books?" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Your client/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^You$/ })).toBeTruthy();
  });

  it("says 'firm', never 'practice account', which owners can misread", () => {
    server(null);
    renderPage(null);
    expect(screen.getAllByRole("button", { name: /Sign up your firm/ })).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/practice account/i);
  });
});
