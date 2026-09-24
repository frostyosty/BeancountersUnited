// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { practice, sam, val, widgets } from "../test/data";
import { jsonResponse, renderApp, stubApi } from "../test/render";

const accounts = practice.master_charts[0]!.accounts;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function posted(calls: ReturnType<typeof stubApi>) {
  return calls.filter((c) => c.method === "POST").map((c) => c.body as { kind: string; payload: unknown });
}

describe("chart page", () => {
  it("renames, deactivates and adds accounts by command", async () => {
    const calls = stubApi({
      "GET /api/me": () => sam,
      "GET /api/clients/c1": () => widgets,
      "GET /api/clients/c1/chart": () => accounts,
      "POST /api/commands": () => ({ seq: 1, entity_id: null }),
    });
    renderApp(<App />, "/clients/c1/chart");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Sales" }));
    const input = screen.getByLabelText("New name for 100");
    await user.clear(input);
    await user.type(input, "Revenue{Enter}");
    await user.click(screen.getByLabelText("800 active"));

    await user.type(screen.getByLabelText("Code"), "236");
    await user.type(screen.getByLabelText("Name"), "Cleaning");
    await user.click(screen.getByRole("button", { name: "Add account" }));

    await vi.waitFor(() => expect(posted(calls)).toHaveLength(3));
    expect(posted(calls)).toEqual([
      { kind: "rename_account", payload: { client_id: "c1", code: "100", name: "Revenue" }, id: expect.any(String) },
      { kind: "set_account_active", payload: { client_id: "c1", code: "800", active: false }, id: expect.any(String) },
      {
        kind: "add_account",
        payload: { client_id: "c1", account: { code: "236", name: "Cleaning", account_type: "expense", active: true } },
        id: expect.any(String),
      },
    ]);
  });

  it("shows why an account can't be made inactive", async () => {
    stubApi({
      "GET /api/me": () => sam,
      "GET /api/clients/c1": () => widgets,
      "GET /api/clients/c1/chart": () => accounts,
      "POST /api/commands": () =>
        jsonResponse(422, {
          code: "account_in_use",
          message: "810 is the retained earnings account, so it stays active.",
          details: null,
        }),
    });
    renderApp(<App />, "/clients/c1/chart");
    await userEvent.setup().click(await screen.findByLabelText("810 active"));
    expect(await screen.findByText("810 is the retained earnings account, so it stays active.")).toBeTruthy();
  });

  it("edits the rounding priority list as a draft, then saves it", async () => {
    const calls = stubApi({
      "GET /api/me": () => sam,
      "GET /api/clients/c1": () => ({ ...widgets, rounding_priority: ["100"] }),
      "GET /api/clients/c1/chart": () => accounts,
      "POST /api/commands": () => ({ seq: 1, entity_id: null }),
    });
    renderApp(<App />, "/clients/c1/chart");
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Account to add"), "800");
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    await user.click(screen.getByRole("button", { name: "Move 800 up" }));
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent?.slice(0, 3))).toEqual(["800", "100"]);
    expect(posted(calls)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Save list" }));
    await vi.waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0]).toMatchObject({
      kind: "set_rounding_priority",
      payload: { client_id: "c1", rounding_priority: ["800", "100"] },
    });
  });

  it("is read-only for viewers", async () => {
    stubApi({
      "GET /api/me": () => val,
      "GET /api/clients/c1": () => widgets,
      "GET /api/clients/c1/chart": () => accounts,
    });
    renderApp(<App />, "/clients/c1/chart");
    expect(await screen.findByText("Sales")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sales" })).toBeNull();
    expect((screen.getByLabelText("100 active") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Add account" })).toBeNull();
    expect(screen.queryByLabelText("Account to add")).toBeNull();
  });
});
