// @vitest-environment jsdom
import type { Me } from "@acct/types/Me";
import type { PracticeRequestView } from "@acct/types/PracticeRequestView";
import type { TrialCounts } from "@acct/types/TrialCounts";
import type { TrialTally } from "@acct/types/TrialTally";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { boss } from "../../test/data";
import { renderApp, stubApi } from "../../test/render";

const overseer: Me = { id: "u9", username: "ov", display_name: "Olive Overseer", role: "overseer" };

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tally = (over: Partial<TrialTally> = {}): TrialTally => ({
  started: 0,
  saved: 0,
  moved: 0,
  expired: 0,
  expired_unused: 0,
  expired_by_you: 0,
  expired_example_finished: 0,
  saves_by_from: [],
  ...over,
});

const counts: TrialCounts = {
  weeks: [
    {
      starts: "2026-11-09T00:00:00Z",
      counts: tally({ started: 7, saved: 3, moved: 1, expired: 4, expired_unused: 2, expired_by_you: 1, expired_example_finished: 1, saves_by_from: [{ from: "saving", saves: 2 }, { from: null, saves: 1 }] }),
    },
    { starts: "2026-11-02T00:00:00Z", counts: tally({ started: 5, saved: 1, saves_by_from: [{ from: "accountant_view", saves: 1 }] }) },
  ],
  // Deliberately not the sum of the weeks: the page shows the server's numbers and adds nothing up.
  total: tally({ started: 99, saved: 42, moved: 5, expired_unused: 8, expired_by_you: 6, expired_example_finished: 7, saves_by_from: [{ from: "banner", saves: 40 }, { from: null, saves: 2 }] }),
};

const requests: PracticeRequestView[] = [
  {
    id: "r2",
    name: "Pat Lee",
    email: "pat@example.com",
    practice_name: "Lee and Co",
    clients: "11_to_50",
    phone: "021 555 0100",
    from: "who_are_you",
    created_at: "2026-11-08T01:02:03Z",
    delete_after: "2027-02-06T01:02:03Z",
  },
  {
    id: "r1",
    name: "Sam Wu",
    email: "sam@example.com",
    practice_name: "Wu Books",
    clients: "up_to_10",
    phone: null,
    from: null,
    created_at: "2026-11-01T01:02:03Z",
    delete_after: "2027-01-30T01:02:03Z",
  },
];

describe("the trial counts, in Settings → Tools", () => {
  it("shows the server's counts to an overseer, newest week first, with 'not recorded' for no prompt", async () => {
    const calls = stubApi({ "GET /api/me": () => overseer, "GET /api/overseer/trials": () => counts });
    renderApp(<App />, "/settings/tools");
    const table = await screen.findByRole("table", { name: "Trials by week" });
    const rows = within(table).getAllByRole("row");
    // Header, two weeks, then the server's total.
    expect(rows).toHaveLength(4);
    const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent);

    expect(within(rows[1]!).getByRole("rowheader").textContent).toBe("9 Nov 2026");
    expect(cells(rows[1]!)).toEqual(["7", "3", "1", "2", "1", "1", "First saving line 2, not recorded 1"]);
    expect(within(rows[2]!).getByRole("rowheader").textContent).toBe("2 Nov 2026");
    expect(cells(rows[2]!)).toEqual(["5", "1", "0", "0", "0", "0", "Accountant view 1"]);
    // The total is the server's own figure (99), not the weeks added up (12).
    expect(within(rows[3]!).getByRole("rowheader").textContent).toBe("All 12 weeks");
    expect(cells(rows[3]!)).toEqual(["99", "42", "5", "8", "6", "7", "Banner or header button 40, not recorded 2"]);
    expect(calls.filter((c) => c.path === "/api/overseer/trials")).toHaveLength(1);
  });

  it("is absent for a practice admin, who never asks the server for it", async () => {
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/overseer/trials": () => counts,
      "GET /api/practice": () => ({ name: "Example Practice", master_charts: [], templates: [], mappings: [] }),
    });
    renderApp(<App />, "/settings/tools");
    await screen.findByText("Open the invoice maker");
    expect(screen.queryByRole("heading", { name: "Trials" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(calls.some((c) => c.path === "/api/overseer/trials")).toBe(false);
  });
});

describe("the practice requests, in Settings → Admin", () => {
  const admin = (list: () => unknown = () => requests) => ({
    "GET /api/me": () => overseer,
    "GET /api/users": () => [],
    "GET /api/practice-requests": list,
    "POST /api/commands": () => ({ seq: 10, entity_id: null }),
  });

  it("lists them as the server sends them, newest first", async () => {
    stubApi(admin());
    renderApp(<App />, "/settings/admin");
    const card = (await screen.findByRole("region", { name: "Practice requests" })) as HTMLElement;
    const items = await within(card).findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Lee and Co")).toBeTruthy();
    expect(items[0]!.textContent).toContain("Pat Lee");
    expect(within(items[0]!).getByRole("link", { name: "pat@example.com" }).getAttribute("href")).toBe("mailto:pat@example.com");
    expect(items[0]!.textContent).toContain("021 555 0100");
    expect(items[0]!.textContent).toContain("11 to 50 clients");
    expect(items[0]!.textContent).toContain("asked 8 Nov 2026");
    expect(items[0]!.textContent).toContain("deleted 6 Feb 2027");
    expect(within(items[1]!).getByText("Wu Books")).toBeTruthy();
    expect(items[1]!.textContent).toContain("not recorded");
  });

  it("says so when there are none", async () => {
    stubApi(admin(() => []));
    renderApp(<App />, "/settings/admin");
    expect(await screen.findByText("No practice requests")).toBeTruthy();
  });

  it("deletes one through a confirmation, as the overseer's choice", async () => {
    const calls = stubApi(admin());
    renderApp(<App />, "/settings/admin");
    const user = userEvent.setup();
    const card = (await screen.findByRole("region", { name: "Practice requests" })) as HTMLElement;
    await user.click(within((await within(card).findAllByRole("listitem"))[0]!).getByRole("button", { name: /Delete/ }));

    // Nothing is sent until they confirm.
    const dialog = document.querySelector("dialog")!;
    expect(within(dialog).getByText(/Pat Lee \(Lee and Co\) is deleted for good/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/commands")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Delete it" }));

    await vi.waitFor(() => expect(calls.some((c) => c.path === "/api/commands")).toBe(true));
    expect(calls.find((c) => c.path === "/api/commands")!.body).toMatchObject({
      kind: "delete_practice_request",
      payload: { request_id: "r2", why: "by_overseer" },
    });
  });

  it("leaves the request alone when they cancel", async () => {
    const calls = stubApi(admin());
    renderApp(<App />, "/settings/admin");
    const user = userEvent.setup();
    const card = (await screen.findByRole("region", { name: "Practice requests" })) as HTMLElement;
    await user.click(within((await within(card).findAllByRole("listitem"))[1]!).getByRole("button", { name: /Delete/ }));
    await user.click(within(document.querySelector("dialog")!).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.path === "/api/commands")).toBe(false);
  });

  it("is absent from the Admin tab for a practice admin, who is sent away from it", async () => {
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/practice-requests": () => requests,
      "GET /api/practice": () => ({ name: "Example Practice", master_charts: [], templates: [], mappings: [] }),
      "GET /api/users": () => [],
    });
    renderApp(<App />, "/settings/admin");
    await screen.findByRole("heading", { name: /My account|Settings/ });
    expect(screen.queryByRole("region", { name: "Practice requests" })).toBeNull();
    expect(calls.some((c) => c.path === "/api/practice-requests")).toBe(false);
  });
});
