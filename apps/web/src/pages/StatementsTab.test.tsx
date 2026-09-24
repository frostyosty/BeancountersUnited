// @vitest-environment jsdom
import type { ReportDoc } from "@acct/types/ReportDoc";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import fy2026 from "../../../../crates/core/tests/snapshots/fixture__fy2026_reportdoc.snap?raw";
import { App } from "../App";
import { practice, val, widgets } from "../test/data";
import { jsonResponse, renderApp, stubApi } from "../test/render";
import { headings } from "./StatementsTab";

/** M1's golden ReportDoc for the fixture company's FY2026: the body after the insta header. */
const doc = JSON.parse(fy2026.split("\n---\n")[1]!) as ReportDoc;
const accounts = [...practice.master_charts[0]!.accounts, { code: "110", name: "Interest received", account_type: "income" as const, active: true }];

function routes(report: () => unknown) {
  return {
    "GET /api/me": () => val,
    "GET /api/years/y1": () => widgets.years[0],
    "GET /api/clients/c1": () => widgets,
    "GET /api/clients/c1/chart": () => accounts,
    "GET /api/years/y1/report": report,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("statements", () => {
  it("renders the fixture ReportDoc with comparatives", async () => {
    stubApi(routes(() => doc));
    renderApp(<App />, "/years/y1/statements");
    const perf = (await screen.findByRole("heading", { name: "Statement of Financial Performance" })).closest("section")!;
    const head = within(perf).getAllByRole("columnheader").map((th) => th.textContent);
    expect(head).toEqual(["", "2026 $", "2025 $"]);
    const sales = within(perf).getByRole("button", { name: "Sales" }).closest("tr")!;
    expect(sales.textContent).toBe("Sales103,41287,643");
    const revenue = within(perf).getByText("Total revenue").closest("tr")!;
    expect(revenue.textContent).toBe("Total revenue103,46487,677");
    // Finalised comparatives: no notice.
    expect(screen.queryByText(/isn't finalised/)).toBeNull();
    // The fallback rounding is explained.
    expect(within(screen.getByRole("list", { name: "Warnings" })).getAllByRole("listitem")[0]!.textContent).toContain(
      "Sales took the rounding for this year",
    );
  });

  it("drills down to accounts in cents with a rounding entry that makes them add up", async () => {
    stubApi(routes(() => doc));
    renderApp(<App />, "/years/y1/statements");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sales" }));
    const table = screen.getByRole("table", { name: "Accounts behind Sales" });
    const rows = within(table).getAllByRole("row").map((r) => r.textContent);
    // 103,412.60 shown as 103,412 (−0.60); 87,642.35 shown as 87,643 (+0.65).
    expect(rows).toEqual(["100Sales103,412.6087,642.35", "Rounding(0.60)0.65"]);
  });

  it("marks unfinalised comparatives and shows nil as a dash", async () => {
    const unfinalised: ReportDoc = { ...doc, comparatives: "unfinalised", warnings: [] };
    stubApi(routes(() => unfinalised));
    renderApp(<App />, "/years/y1/statements");
    expect((await screen.findByRole("status")).textContent).toContain("isn't finalised");
    const perf = screen.getByRole("heading", { name: "Statement of Financial Performance" }).closest("section")!;
    expect(within(perf).getAllByRole("columnheader")[2]!.textContent).toBe("2025 $*");
    expect(within(perf).getByText("* Unfinalised.")).toBeTruthy();
    const gst = screen.getByRole("button", { name: /GST/ }).closest("tr")!;
    expect(gst.textContent).toMatch(/12–$/);
  });

  it("explains a report that can't be built", async () => {
    stubApi(
      routes(() =>
        jsonResponse(422, {
          code: "report_failed",
          message: "The statements can't be built until these are fixed.",
          details: [{ code: "unmapped", account: "100" }],
        }),
      ),
    );
    renderApp(<App />, "/years/y1/statements");
    expect(await screen.findByText("Account 100 has a balance but doesn't map to any report line.")).toBeTruthy();
  });
});

describe("headings", () => {
  it("uses end years, or full dates when they'd clash", () => {
    expect(headings({ start: "2025-04-01", end: "2026-03-31" }, { start: "2024-04-01", end: "2025-03-31" })).toEqual([
      "2026 $",
      "2025 $",
    ]);
    expect(headings({ start: "2026-04-01", end: "2026-09-30" }, { start: "2025-04-01", end: "2026-03-31" })).toEqual([
      "30 Sep 2026 $",
      "31 Mar 2026 $",
    ]);
    expect(headings({ start: "2024-04-01", end: "2025-03-31" }, null)).toEqual(["2025 $", ""]);
  });
});
