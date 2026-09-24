// @vitest-environment jsdom
import type { JournalView } from "@acct/types/JournalView";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { practice, sam, val, widgets } from "../test/data";
import { jsonResponse, renderApp, stubApi } from "../test/render";

const accounts = practice.master_charts[0]!.accounts;
const year = widgets.years[0]!;

const journal: JournalView = {
  id: "j1",
  kind: "manual",
  date: "2024-06-30",
  narration: "Sales for June",
  lines: [
    { account: "800", amount: 12345 },
    { account: "100", amount: -12345 },
  ],
  reverses_journal_id: null,
  reversed_by: null,
  posted_seq: 5,
};

function routes(me = sam, extra: Record<string, () => unknown> = {}) {
  return {
    "GET /api/me": () => me,
    "GET /api/years/y1": () => year,
    "GET /api/clients/c1": () => widgets,
    "GET /api/clients/c1/chart": () => accounts,
    "GET /api/years/y1/journals": () => [journal],
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("journal entry", () => {
  it("shows the live out-of-balance figure and posts signed cents", async () => {
    const calls = stubApi(routes(sam, { "POST /api/commands": () => ({ seq: 6, entity_id: "j2" }) }));
    renderApp(<App />, "/years/y1");
    const user = userEvent.setup();

    const line1 = await screen.findByLabelText("Line 1 account");
    await user.type(line1, "800");
    expect(line1.closest("tr")!.textContent).toContain("Share capital");
    await user.type(screen.getByLabelText("Line 1 debit"), "100.10");
    expect(screen.getByTestId("difference").textContent).toBe("100.10 Dr");
    const post = screen.getByRole("button", { name: "Post journal" }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);

    await user.type(screen.getByLabelText("Line 2 account"), "100");
    await user.type(screen.getByLabelText("Line 2 credit"), "100");
    expect(screen.getByTestId("difference").textContent).toBe("0.10 Dr");
    await user.clear(screen.getByLabelText("Line 2 credit"));
    await user.click(screen.getAllByRole("button", { name: "Balance" })[1]!);
    expect((screen.getByLabelText("Line 2 credit") as HTMLInputElement).value).toBe("100.10");
    expect(screen.getByTestId("difference").textContent).toBe("Balanced");

    await user.type(screen.getByLabelText("Narration"), "Capital introduced");
    await user.click(post);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      kind: "post_journal",
      payload: {
        client_year_id: "y1",
        date: "2025-03-31",
        narration: "Capital introduced",
        lines: [
          { account: "800", amount: 10010 },
          { account: "100", amount: -10010 },
        ],
      },
    });
    // The grid clears for the next journal.
    await vi.waitFor(() => expect((screen.getByLabelText("Line 1 account") as HTMLInputElement).value).toBe(""));
  });

  it("flags bad rows as they're typed", async () => {
    stubApi(routes());
    renderApp(<App />, "/years/y1");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Line 1 account"), "820");
    await user.type(screen.getByLabelText("Line 1 debit"), "5");
    expect(screen.getByText("820 is inactive.")).toBeTruthy();
  });

  it("puts the server's line problems on the right row", async () => {
    stubApi(
      routes(sam, {
        "POST /api/commands": () =>
          jsonResponse(422, {
            code: "invalid_journal",
            message: "The journal has problems.",
            details: [{ code: "inactive_account", line: 1, account: "100" }],
          }),
      }),
    );
    renderApp(<App />, "/years/y1");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Line 1 account"), "800");
    await user.type(screen.getByLabelText("Line 1 debit"), "1");
    // Line 2 left blank, so the server's line 1 is grid row 3.
    await user.type(screen.getByLabelText("Line 3 account"), "100");
    await user.type(screen.getByLabelText("Line 3 credit"), "1");
    await user.click(screen.getByRole("button", { name: "Post journal" }));
    const row3 = (await screen.findByText("100 is inactive.")).closest("tr")!;
    expect(within(row3).getByLabelText("Line 3 account")).toBeTruthy();
  });
});

describe("journal list", () => {
  it("expands a journal and reverses it", async () => {
    const calls = stubApi(routes(sam, { "POST /api/commands": () => ({ seq: 7, entity_id: "j3" }) }));
    renderApp(<App />, "/years/y1");
    const user = userEvent.setup();
    const toggle = await screen.findByRole("button", { name: "Sales for June" });
    await user.click(toggle);
    const detail = toggle.closest("tr")!.nextElementSibling!;
    expect(detail.textContent).toBe("800Share capital123.45100Sales123.45");

    await user.click(screen.getByRole("button", { name: "Reverse…" }));
    await user.click(screen.getByRole("button", { name: "Post reversal" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      kind: "reverse_journal",
      payload: { journal_id: "j1", date: "2024-06-30" },
    });
  });

  it("is read-only for viewers and finalised years", async () => {
    stubApi(routes(val));
    renderApp(<App />, "/years/y1");
    expect(await screen.findByRole("button", { name: "Sales for June" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "New journal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reverse…" })).toBeNull();
    cleanup();

    stubApi({ ...routes(sam), "GET /api/years/y1": () => ({ ...year, status: "finalised" }) });
    renderApp(<App />, "/years/y1");
    expect(await screen.findByRole("button", { name: "Sales for June" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "New journal" })).toBeNull();
  });
});

describe("trial balance", () => {
  it("shows opening, movement and closing, and foots", async () => {
    stubApi(
      routes(val, {
        "GET /api/years/y1/tb": () => ({
          opening: [{ account: "800", balance: -1000 }],
          closing: [
            { account: "800", balance: -1000 },
            { account: "100", balance: -500 },
            { account: "810", balance: 1500 },
          ],
        }),
      }),
    );
    renderApp(<App />, "/years/y1/tb");
    const table = await screen.findByRole("table");
    const foot = table.querySelector("tfoot tr")!;
    expect(foot.textContent).toBe("Totals15.0015.00");
  });
});
