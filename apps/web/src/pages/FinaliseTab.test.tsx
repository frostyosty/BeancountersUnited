// @vitest-environment jsdom
import type { FinaliseCheck } from "@acct/types/FinaliseCheck";
import type { Me } from "@acct/types/Me";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { boss, practice, sam } from "../test/data";
import { jsonResponse, renderApp, stubApi } from "../test/render";

const prior = { id: "y0", client_id: "c1", start: "2023-04-01", end: "2024-03-31", status: "open", books_source: "tb_import" } as const;
const year = { id: "y1", client_id: "c1", start: "2024-04-01", end: "2025-03-31", status: "open", books_source: "tb_import" } as const;
const client = {
  id: "c1",
  name: "Example Widgets Ltd",
  entity_type: "company",
  retained_earnings: "810",
  rounding_priority: [],
  years: [prior, year],
};

const notReady: FinaliseCheck = {
  status: "open",
  has_prior_year: true,
  issues: [
    { code: "prior_not_finalised", prior_end: "2024-03-31", message: "The year ending 2024-03-31 isn't finalised yet. Finalise it first." },
    { code: "depreciation_stale", message: "Depreciation isn't up to date. Run it again." },
  ],
  uncategorised_lines: 0,
  finalised: null,
};

const onlyUnsorted: FinaliseCheck = {
  status: "open",
  has_prior_year: false,
  issues: [{ code: "uncategorised_lines", count: 3, message: "3 bank lines in the year aren't sorted yet." }],
  uncategorised_lines: 3,
  finalised: null,
};

const done: FinaliseCheck = {
  status: "finalised",
  has_prior_year: true,
  issues: [],
  uncategorised_lines: 0,
  finalised: { who: "Bo Boss", at: "2026-10-25T01:30:00Z", seq: 42, sha256: "ab".repeat(32) },
};

function routes(me: Me, check: FinaliseCheck, status: "open" | "finalised" = "open") {
  return {
    "GET /api/me": () => me,
    "GET /api/years/y1": () => ({ ...year, status }),
    "GET /api/clients/c1": () => client,
    "GET /api/clients/c1/chart": () => practice.master_charts[0]!.accounts,
    "GET /api/years/y1/finalise-check": () => check,
    "POST /api/commands": () => ({ seq: 43, entity_id: null }),
  };
}

function posts(calls: ReturnType<typeof stubApi>) {
  return calls.filter((c) => c.path === "/api/commands").map((c) => c.body);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("finalise", () => {
  it("shows each pre-check as passed or failed, with a way to fix a failure", async () => {
    stubApi(routes(boss, notReady));
    renderApp(<App />, "/years/y1/finalise");
    const list = await screen.findByRole("list", { name: "Pre-checks" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.querySelector("strong")!.textContent + i.textContent!.match(/\((.*?)\)/)![1])).toEqual([
      "The prior year is finalisedfailed",
      "The trial balance balancespassed",
      "Every account with a balance maps to a report linepassed",
      "Depreciation is up to datefailed",
      "Every bank line is sortedpassed",
    ]);
    expect(items[0]!.textContent).toContain("isn't finalised yet");
    expect(within(items[0]!).getByRole("link", { name: "Finalise the prior year" }).getAttribute("href")).toBe("/years/y0/finalise");
    expect(within(items[3]!).getByRole("link", { name: "Run depreciation" }).getAttribute("href")).toBe("/years/y1/assets");
    // Passed checks offer no fix.
    expect(within(items[1]!).queryByRole("link")).toBeNull();
    expect((screen.getByRole("button", { name: /Finalise year/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is the practice admin's: staff see the checks but no button", async () => {
    stubApi(routes(sam, onlyUnsorted));
    renderApp(<App />, "/years/y1/finalise");
    expect(await screen.findByText("Only a practice admin can finalise a year.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Finalise year/ })).toBeNull();
    // The first year has no prior year to wait for.
    expect(screen.getByText(/This is the first year/)).toBeTruthy();
  });

  it("accepts unsorted bank lines only when asked, and confirms before finalising", async () => {
    const calls = stubApi(routes(boss, onlyUnsorted));
    renderApp(<App />, "/years/y1/finalise");
    const user = userEvent.setup();
    const button = (await screen.findByRole("button", { name: /Finalise year/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /accepting the 3 unsorted bank lines/ }));
    await user.click(button);
    const dialog = screen.getByRole("alertdialog", { name: "Confirm finalising" });
    expect(dialog.textContent).toContain("Example Widgets Ltd");
    // Cancelling sends nothing.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(posts(calls)).toEqual([]);
    await user.click(screen.getByRole("button", { name: /Finalise year/ }));
    await user.click(screen.getByRole("button", { name: "Yes, finalise" }));
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "finalise_year", payload: { client_year_id: "y1", accept_uncategorised: true } });
  });

  it("shows the server's reasons when finalising is refused", async () => {
    stubApi({
      ...routes(boss, { ...onlyUnsorted, issues: [], uncategorised_lines: 0 }),
      "POST /api/commands": () =>
        jsonResponse(422, {
          code: "not_ready_to_finalise",
          message: "This year can't be finalised yet. The trial balance is out by $1.00.",
          details: [{ code: "unbalanced_tb", difference: -100, message: "The trial balance is out by $1.00." }],
        }),
    });
    renderApp(<App />, "/years/y1/finalise");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Finalise year/ }));
    await user.click(screen.getByRole("button", { name: "Yes, finalise" }));
    expect((await screen.findByRole("alert")).textContent).toContain("out by $1.00");
  });

  it("shows who finalised the year, when, and the snapshot's hash", async () => {
    stubApi(routes(sam, done, "finalised"));
    renderApp(<App />, "/years/y1/finalise");
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Finalised by Bo Boss on");
    expect(status.querySelector("time")!.getAttribute("dateTime")).toBe("2026-10-25T01:30:00Z");
    expect(screen.getByText("ab".repeat(32))).toBeTruthy();
    // Staff can't reopen.
    expect(screen.queryByRole("button", { name: /Reopen year/ })).toBeNull();
    expect(screen.getByText("Only a practice admin can reopen a year.")).toBeTruthy();
  });

  it("reopens only with a reason", async () => {
    const calls = stubApi(routes(boss, done, "finalised"));
    renderApp(<App />, "/years/y1/finalise");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Reopen year/ }));
    const submit = screen.getByRole("button", { name: "Reopen year" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText("Why is it being reopened?"), "   ");
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText("Why is it being reopened?"), "Missing invoice");
    await user.click(submit);
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "reopen_year", payload: { client_year_id: "y1", reason: "Missing invoice" } });
  });
});
