// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import type { Me } from "@acct/types/Me";
import type { TaxPosition } from "@acct/types/TaxPosition";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { renderApp, stubApi } from "../test/render";

/** Olive the overseer, viewing as Ana the business owner (ADR 013): the server answers as Ana. */
const viewingAsAna: Me = {
  id: "u9",
  username: "ana",
  display_name: "Ana",
  role: "business_owner",
  acting_as: {
    user_id: "u9",
    name: "Ana",
    role: "business_owner",
    since: "2026-11-04T00:00:00Z",
    expires_at: "2999-01-01T00:30:00Z",
    allow_changes: false,
  },
  real: { user_id: "u1", name: "Olive", role: "overseer" },
};

const business: BusinessView = {
  client_id: "b1",
  name: "Ana's Gardens",
  start_date: "2025-04-01",
  gst_registered_from: null,
  gst_frequency: null,
  gst_source: "owner",
  gst_evidence: null,
  gst_contradicted_by: null,
  example: null,
  bank_accounts: [],
  transfers: [],
  ird_payments: [],
  possible_duplicates: [],
};

const tax: TaxPosition = { total: 0, gst: [], income: [], notices: [] };

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("OverviewPage", () => {
  it("an owner view skips clients that aren't businesses", async () => {
    stubApi({
      "GET /api/me": () => viewingAsAna,
      "GET /api/clients": () => [
        { id: "c1", name: "Example Widgets Ltd", entity_type: "company", is_business: false },
        { id: "b1", name: "Ana's Gardens", entity_type: "sole_trader", is_business: true },
      ],
      "GET /api/businesses/b1": () => business,
      "GET /api/businesses/b1/tax": () => tax,
    });
    renderApp(<App />, "/");
    expect(await screen.findByRole("heading", { name: "Ana's Gardens" })).toBeTruthy();
  });

  it("offers to set up a business when there's none", async () => {
    stubApi({
      "GET /api/me": () => viewingAsAna,
      "GET /api/clients": () => [{ id: "c1", name: "Example Widgets Ltd", entity_type: "company", is_business: false }],
    });
    renderApp(<App />, "/");
    expect(await screen.findByText("No business yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Set up a business/ }).getAttribute("href")).toBe("/businesses/new");
  });
});
