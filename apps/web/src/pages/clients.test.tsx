// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { practice, sam, val, widgets } from "../test/data";
import { jsonResponse, renderApp, stubApi } from "../test/render";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("clients", () => {
  it("creates a client with an active equity account as retained earnings, then opens it", async () => {
    const calls = stubApi({
      "GET /api/me": () => sam,
      "GET /api/practice": () => practice,
      "GET /api/clients": () => [],
      "POST /api/commands": () => ({ seq: 9, entity_id: "c1" }),
      "GET /api/clients/c1": () => ({ ...widgets, years: [] }),
    });
    renderApp(<App />);
    const user = userEvent.setup();

    expect(await screen.findByText("No clients yet.")).toBeTruthy();
    const re = await screen.findByLabelText("Retained earnings account");
    // Only active equity accounts are offered.
    expect(within(re).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "800 Share capital",
      "810 Retained earnings",
    ]);
    await user.selectOptions(re, "810");
    await user.type(screen.getByLabelText("Name"), "  Example Widgets Ltd ");
    await user.click(screen.getByRole("button", { name: "Create client" }));

    expect(await screen.findByRole("heading", { name: "Example Widgets Ltd" })).toBeTruthy();
    const command = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(command.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(command.kind).toBe("create_client");
    expect(command.payload).toEqual({
      name: "Example Widgets Ltd",
      entity_type: "company",
      retained_earnings: "810",
      rounding_priority: [],
    });
  });

  it("shows the server's rejection", async () => {
    stubApi({
      "GET /api/me": () => sam,
      "GET /api/practice": () => practice,
      "GET /api/clients": () => [],
      "POST /api/commands": () =>
        jsonResponse(422, { code: "invalid_name", message: "A name can't be blank.", details: null }),
    });
    renderApp(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "x");
    await user.click(screen.getByRole("button", { name: "Create client" }));
    expect(await screen.findByText("A name can't be blank.")).toBeTruthy();
  });

  it("hides the create form from viewers", async () => {
    stubApi({
      "GET /api/me": () => val,
      "GET /api/clients": () => [{ id: "c1", name: "Example Widgets Ltd", entity_type: "company" }],
    });
    renderApp(<App />);
    expect(await screen.findByRole("link", { name: "Example Widgets Ltd" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create client" })).toBeNull();
  });
});

describe("client years", () => {
  it("adds the next year by default, without choosing a mapping", async () => {
    const calls = stubApi({
      "GET /api/me": () => sam,
      "GET /api/practice": () => practice,
      "GET /api/clients/c1": () => widgets,
      "POST /api/commands": () => ({ seq: 10, entity_id: "y2" }),
    });
    renderApp(<App />, "/clients/c1");
    const user = userEvent.setup();
    const which = await screen.findByLabelText("Which year");
    expect((which as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("Next: 1 Apr 2025 to 31 Mar 2026");
    expect(screen.queryByLabelText("Mapping")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add year" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      kind: "create_client_year",
      payload: { client_id: "c1", start: "2025-04-01", end: "2026-03-31" },
    });
  });

  it("asks for dates and a mapping for a first year", async () => {
    const calls = stubApi({
      "GET /api/me": () => sam,
      "GET /api/practice": () => practice,
      "GET /api/clients/c1": () => ({ ...widgets, years: [] }),
      "POST /api/commands": () => ({ seq: 10, entity_id: "y1" }),
    });
    renderApp(<App />, "/clients/c1");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Start"), "2024-04-01");
    await user.type(screen.getByLabelText("End"), "2025-03-31");
    await user.selectOptions(await screen.findByLabelText("Mapping"), "m2");
    await user.click(screen.getByRole("button", { name: "Add year" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      payload: { client_id: "c1", start: "2024-04-01", end: "2025-03-31", mapping_id: "m2" },
    });
  });
});
