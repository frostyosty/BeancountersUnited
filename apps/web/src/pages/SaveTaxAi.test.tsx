// @vitest-environment jsdom
import type { AiSuggestionsView } from "@acct/types/AiSuggestionsView";
import type { BusinessView } from "@acct/types/BusinessView";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { sam, val } from "../test/data";
import { renderApp, stubApi } from "../test/render";

const business: BusinessView = {
  client_id: "b1",
  name: "Marsh Hollow Candles",
  start_date: "2025-08-01",
  gst_registered_from: "2025-08-01",
  gst_frequency: "two_monthly_odd",
  bank_accounts: [],
  transfers: [],
  ird_payments: [],
  possible_duplicates: [],
};

const off: AiSuggestionsView = {
  available: true,
  provider: "Anthropic",
  model: "claude-haiku-5-5",
  consent_version: "2026-10-24:Anthropic",
  enabled: false,
  needs_consent: false,
  activity: null,
  private_names: [],
  suggestions: [],
};

function routes(view: () => AiSuggestionsView, me = sam) {
  return stubApi({
    "GET /api/me": () => me,
    "GET /api/businesses/b1": () => business,
    "GET /api/businesses/b1/save-tax": () => ({ total: 1000, conservative_total: 1000, saved_so_far: 0, cards: [] }),
    "GET /api/businesses/b1/ai-suggestions": view,
    "POST /api/businesses/b1/ai-suggestions": () => ({ asked: 12, suggestions: [], dropped: 0, failed_batches: 0 }),
    "GET /api/clients/b1/chart": () => [],
    "POST /api/commands": () => ({ seq: 20, entity_id: null }),
  });
}

const posts = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST" && c.path === "/api/commands").map((c) => c.body);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AI suggestions consent (ADR 009)", () => {
  it("shows nothing when the server has no AI service", async () => {
    routes(() => ({ ...off, available: false, provider: null, model: null, consent_version: null }));
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/Tax to pay if submitted now/)).toBeTruthy();
    expect(screen.queryByText("Suggest categories for me")).toBeNull();
  });

  it("turns them on only once the owner agrees, with the consent version", async () => {
    const calls = routes(() => off);
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    expect(await screen.findByText("Suggest categories for me")).toBeTruthy();
    expect(screen.getByText(/It never sees your name, your business's name, your bank account numbers or your IRD/)).toBeTruthy();
    expect(screen.getByText(/We can ask an AI service \(Anthropic\)/)).toBeTruthy();
    const turnOn = screen.getByRole("button", { name: /Turn on suggestions/ });
    expect((turnOn as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByText(/Keep more names private/));
    await user.type(screen.getByLabelText(/Other names to strip/), "Q Marsh, J Doe");
    await user.type(screen.getByLabelText(/What the business does/), "candle maker");
    await user.click(screen.getByLabelText(/The owner has read this and agrees/));
    await user.click(turnOn);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      kind: "set_ai_suggestions",
      payload: {
        client_id: "b1",
        enabled: true,
        consent_version: "2026-10-24:Anthropic",
        activity: "candle maker",
        private_names: ["Q Marsh", "J Doe"],
      },
    });
  });

  it("asks again when the wording or provider changed", async () => {
    routes(() => ({ ...off, enabled: true, needs_consent: true }));
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/needs to agree again/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Turn on suggestions/ })).toBeTruthy();
  });

  it("once on, asks for suggestions and can be turned off", async () => {
    const calls = routes(() => ({ ...off, enabled: true }));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    expect(await screen.findByText(/AI suggestions are on, from Anthropic/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Suggest categories now/ }));
    expect(await screen.findByText(/Asked about 12 transactions, and got 0 suggestions/)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/businesses/b1/ai-suggestions")).toBe(true);

    await user.click(screen.getByRole("button", { name: /Turn suggestions off/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "set_ai_suggestions", payload: { client_id: "b1", enabled: false } });
  });

  it("isn't shown to viewers", async () => {
    routes(() => off, val);
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/viewers can't answer questions/)).toBeTruthy();
    expect(screen.queryByText("Suggest categories for me")).toBeNull();
  });
});
