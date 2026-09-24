// @vitest-environment jsdom
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { sam } from "../test/data";
import { renderApp, stubApi } from "../test/render";
import { SYNC_INTERVAL_MS } from "./sync";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("live refresh", () => {
  it("refetches the open page when someone else changes something", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let clients = [{ id: "c1", name: "First Ltd", entity_type: "company" }];
    let head = 10;
    stubApi({
      "GET /api/me": () => sam,
      "GET /api/practice": () => ({ name: "P", master_charts: [], templates: [], mappings: [] }),
      "GET /api/clients": () => clients,
      "GET /api/sync": (_, url) => {
        const after = Number(url.searchParams.get("after"));
        const changes =
          head > after && !url.searchParams.has("limit")
            ? [{ seq: head, kind: "create_client", client_id: "c2", client_year_id: null, at: "" }]
            : [];
        return { changes, last_seq: changes.length ? head : after, head_seq: head };
      },
    });
    renderApp(<App />);
    expect(await screen.findByRole("link", { name: "First Ltd" })).toBeTruthy();

    // Someone else adds a client.
    clients = [...clients, { id: "c2", name: "Second Ltd", entity_type: "company" }];
    head = 11;
    await act(() => vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS + 10));
    expect(await screen.findByRole("link", { name: "Second Ltd" })).toBeTruthy();
  });
});
