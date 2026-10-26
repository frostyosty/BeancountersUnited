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

const on: AiSuggestionsView = {
  available: true,
  provider: "Anthropic",
  model: "claude-haiku-5-5",
  enabled: true,
  activity: null,
  private_names: [],
  suggestions: [],
  daily_limit: 1,
  remaining_today: 1,
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

describe("AI suggestions (ADR 009, ADR 011)", () => {
  it("shows nothing when the server has no AI service", async () => {
    routes(() => ({ ...on, available: false, provider: null, model: null }));
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/Tax to pay if submitted now/)).toBeTruthy();
    expect(screen.queryByText(/Ask the experts/)).toBeNull();
  });

  it("is on by default with no consent screen, asks for suggestions, and can be turned off", async () => {
    const calls = routes(() => on);
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    expect(await screen.findByText(/1 question left today/)).toBeTruthy();
    expect(screen.queryByText(/agrees/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Ask the experts/ }));
    expect(await screen.findByText(/The experts looked at 12 transactions and have 0 suggestions/)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/businesses/b1/ai-suggestions")).toBe(true);

    await user.click(screen.getByText(/About the experts/));
    await user.click(screen.getByRole("button", { name: /Turn the experts off/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "set_ai_suggestions", payload: { client_id: "b1", enabled: false } });
  });

  it("saves names to keep private and the business's activity", async () => {
    const calls = routes(() => on);
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    await user.click(await screen.findByText(/Keep more names private/));
    await user.type(screen.getByLabelText(/Other names to strip/), "Q Marsh, J Doe");
    await user.type(screen.getByLabelText(/What the business does/), "candle maker");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      kind: "set_ai_suggestions",
      payload: { client_id: "b1", enabled: true, activity: "candle maker", private_names: ["Q Marsh", "J Doe"] },
    });
  });

  it("can be turned back on once off", async () => {
    const calls = routes(() => ({ ...on, enabled: false }));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    expect(await screen.findByText(/The experts are turned off for this business/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Turn the experts on/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "set_ai_suggestions", payload: { client_id: "b1", enabled: true } });
  });

  it("isn't shown to viewers", async () => {
    routes(() => on, val);
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/viewers can't answer questions/)).toBeTruthy();
    expect(screen.queryByText(/Ask the experts/)).toBeNull();
  });

  it("stops asking once today's questions are used", async () => {
    routes(() => ({ ...on, remaining_today: 0 }));
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/Back tomorrow/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Ask the experts/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
