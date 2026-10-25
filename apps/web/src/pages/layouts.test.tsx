// @vitest-environment jsdom
import type { MappingCheck } from "@acct/types/MappingCheck";
import type { MappingDetail } from "@acct/types/MappingDetail";
import type { TemplateDetail } from "@acct/types/TemplateDetail";
import type { YearLayoutView } from "@acct/types/YearLayoutView";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { boss, practice, sam, widgets } from "../test/data";
import { jsonResponse, renderApp, stubApi } from "../test/render";

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function posts(calls: ReturnType<typeof stubApi>) {
  return calls.filter((c) => c.path === "/api/commands").map((c) => c.body);
}

const template: TemplateDetail = {
  id: "t1",
  entity_type: "company",
  name: "Company",
  version: 3,
  body: {
    name: "Company",
    statements: [
      {
        key: "performance",
        title: "Performance",
        body: [
          {
            kind: "group",
            key: "revenue",
            label: "Revenue",
            presentation: "credit_positive",
            children: [
              { kind: "line", key: "sales", label: "Sales", presentation: "credit_positive" },
              { kind: "line", key: "interest", label: "Interest", presentation: "credit_positive" },
            ],
            total_label: "Total revenue",
            protect: null,
          },
        ],
      },
    ],
    checks: [],
  },
  mappings: [
    {
      id: "m1",
      name: "Standard",
      version: 2,
      body: {
        ranges: [
          { from: "100", to: "109", line: "sales" },
          { from: "110", to: "199", line: "interest" },
        ],
      },
    },
  ],
};

describe("template editor", () => {
  it("edits rows, then saves with the mapping ranges of a removed line pointed elsewhere", async () => {
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/templates/t1": () => template,
      "POST /api/commands": () => ({ seq: 1, entity_id: "tv4" }),
    });
    renderApp(<App />, "/settings/templates/t1");
    const user = userEvent.setup();

    const sales = await screen.findByLabelText("Label for sales");
    await user.clear(sales);
    await user.type(sales, "Sales of goods");
    // A new line in the Revenue group, keyed from its label.
    await user.type(screen.getByLabelText("New row label in Revenue"), "Grants");
    await user.click(within(screen.getByRole("form", { name: "Add a row to Revenue" })).getByRole("button", { name: "Add row" }));
    expect(screen.getByLabelText("Label for grants")).toBeTruthy();

    // Removing a mapped line asks where its ranges go before it can save.
    await user.click(screen.getByRole("button", { name: "Remove Interest" }));
    const save = screen.getByRole("button", { name: "Save version 4" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const panel = screen.getByRole("region", { name: "Ranges to point elsewhere" });
    await user.selectOptions(within(panel).getByLabelText("Standard: 110–199 (was interest)"), "sales");
    expect(save.disabled).toBe(false);
    await user.click(save);

    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    const command = posts(calls)[0] as { kind: string; payload: { body: TemplateDetail["body"]; mappings: unknown } };
    expect(command.kind).toBe("revise_template");
    const revenue = command.payload.body.statements[0]!.body[0]!;
    expect(revenue.kind === "group" && revenue.children.map((c) => [c.key, c.label])).toEqual([
      ["sales", "Sales of goods"],
      ["grants", "Grants"],
    ]);
    expect(command.payload.mappings).toEqual([
      {
        mapping_id: "m1",
        body: {
          ranges: [
            { from: "100", to: "109", line: "sales" },
            { from: "110", to: "199", line: "sales" },
          ],
        },
      },
    ]);
  });

  it("sets what a total adds up", async () => {
    const withTotal: TemplateDetail = structuredClone(template);
    withTotal.body.statements[0]!.body.push({
      kind: "total",
      key: "profit",
      label: "Profit",
      presentation: "credit_positive",
      of: [],
      protect: null,
    });
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/templates/t1": () => withTotal,
      "POST /api/commands": () => ({ seq: 1, entity_id: "tv4" }),
    });
    renderApp(<App />, "/settings/templates/t1");
    const user = userEvent.setup();
    await user.click(await screen.findByText(/Adds up:/));
    await user.click(screen.getByLabelText("profit adds revenue"));
    await user.type(screen.getByLabelText("Rounding priority for profit"), "1");
    await user.click(screen.getByRole("button", { name: "Save version 4" }));
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    const body = (posts(calls)[0] as { payload: { body: TemplateDetail["body"]; mappings?: unknown } }).payload;
    expect(body.body.statements[0]!.body[1]).toMatchObject({ key: "profit", of: ["revenue"], protect: 1 });
    expect(body.mappings).toBeUndefined();
  });
});

const mapping: MappingDetail = {
  id: "m1",
  name: "Standard",
  entity_type: "company",
  template_id: "t1",
  template_name: "Company",
  version: 2,
  body: template.mappings[0]!.body,
  lines: [
    { key: "sales", label: "Sales", statement: "Performance" },
    { key: "interest", label: "Interest", statement: "Performance" },
  ],
};

describe("mapping editor", () => {
  it("shows coverage for the draft, and saves the ranges", async () => {
    const check: MappingCheck = {
      problems: [],
      accounts: [
        { code: "100", name: "Sales", account_type: "income", active: true, line: "sales" },
        { code: "230", name: "Rent", account_type: "expense", active: true, line: null },
      ],
    };
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/mappings/m1": () => mapping,
      "POST /api/mappings/check": () => check,
      "POST /api/commands": () => ({ seq: 1, entity_id: "mv3" }),
    });
    renderApp(<App />, "/settings/mappings/m1");
    const user = userEvent.setup();
    const coverage = await screen.findByRole("region", { name: "Coverage" });
    expect(await within(coverage).findByText(/1 master chart account maps to no line/)).toBeTruthy();
    expect(within(coverage).getByText("Not mapped").closest("tr")!.textContent).toContain("230 Rent");

    await user.selectOptions(screen.getByLabelText("Range 2 line"), "sales");
    await user.type(screen.getByLabelText("New range from"), "200");
    await user.type(screen.getByLabelText("New range to"), "299");
    await user.selectOptions(screen.getByLabelText("New range line"), "interest");
    await user.click(screen.getByRole("button", { name: "Add range" }));
    await user.click(screen.getByRole("button", { name: "Save version 3" }));

    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      kind: "revise_mapping",
      payload: {
        mapping_id: "m1",
        body: {
          ranges: [
            { from: "100", to: "109", line: "sales" },
            { from: "110", to: "199", line: "sales" },
            { from: "200", to: "299", line: "interest" },
          ],
        },
      },
    });
  });
});

describe("setting up statements for a new entity type", () => {
  it("copies another type's template and mapping, then opens the template", async () => {
    const trust = { ...practice.master_charts[0]!, id: "mc9", entity_type: "trust", name: "Trust" };
    const withTrust = { ...practice, master_charts: [...practice.master_charts, trust] };
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/practice": () => withTrust,
      "GET /api/templates/t1": () => template,
      "GET /api/templates/t9": () => ({ ...template, id: "t9", entity_type: "trust", name: "Trust (standard)", version: 1 }),
      "POST /api/commands": (init) => {
        const kind = (JSON.parse(String(init?.body)) as { kind: string }).kind;
        return { seq: 1, entity_id: kind === "create_template" ? "t9" : "m9" };
      },
    });
    renderApp(<App />, "/settings/charts/trust");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Set up statements" }));
    expect(await screen.findByRole("heading", { name: "Trust (standard)" })).toBeTruthy();
    expect(posts(calls)).toMatchObject([
      { kind: "create_template", payload: { entity_type: "trust", name: "Trust (standard)", body: { ...template.body, name: "Trust (standard)" } } },
      { kind: "create_mapping", payload: { template_id: "t9", name: "Trust (standard)", body: template.mappings[0]!.body } },
    ]);
  });
});

describe("moving a year onto a newer layout", () => {
  // The statements don't build through the current mapping; the panel shows all the same.
  const unbuilt = () =>
    jsonResponse(422, { code: "report_failed", message: "The statements can't be built until these are fixed.", details: [] });
  const layout: YearLayoutView = {
    current: { template_id: "t1", template_name: "Company", template_version: 1, mapping_id: "m1", mapping_name: "Standard", mapping_version: 1 },
    proposed: { template_id: "t1", template_name: "Company", template_version: 1, mapping_id: "m1", mapping_name: "Standard", mapping_version: 2 },
    up_to_date: false,
    open: true,
    choices: [{ mapping_id: "m1", mapping_name: "Standard", template_name: "Company" }],
    changes: [
      {
        statement: "Performance",
        key: "sales",
        before: { label: "Sales", style: "line", current: 1000, prior: null, accounts: ["100"] },
        after: { label: "Sales", style: "line", current: 1200, prior: null, accounts: ["100", "110"] },
      },
    ],
    problems: [],
    current_builds: true,
  };

  it("previews the change, then moves the year by command", async () => {
    const calls = stubApi({
      "GET /api/me": () => sam,
      "GET /api/years/y1": () => widgets.years[0],
      "GET /api/clients/c1": () => widgets,
      "GET /api/clients/c1/chart": () => practice.master_charts[0]!.accounts,
      "GET /api/years/y1/report": () => unbuilt,
      "GET /api/years/y1/layout": () => layout,
      "POST /api/commands": () => ({ seq: 1, entity_id: null }),
    });
    renderApp(<App />, "/years/y1/statements");
    const user = userEvent.setup();
    const panel = await screen.findByRole("region", { name: "Statement layout" });
    expect(panel.textContent).toContain("Newer: Company v1, mapping Standard v2.");
    await user.click(within(panel).getByRole("button", { name: "Preview the change" }));
    const row = within(panel).getAllByRole("row")[1]!;
    expect(row.textContent).toContain("1,000");
    expect(row.textContent).toContain("100, 110");
    await user.click(within(panel).getByRole("button", { name: "Move this year" }));
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "move_year_layout", payload: { client_year_id: "y1" } });
  });

  it("can't move while the statements wouldn't build", async () => {
    stubApi({
      "GET /api/me": () => sam,
      "GET /api/years/y1": () => widgets.years[0],
      "GET /api/clients/c1": () => widgets,
      "GET /api/clients/c1/chart": () => practice.master_charts[0]!.accounts,
      "GET /api/years/y1/report": () => unbuilt,
      "GET /api/years/y1/layout": () => ({ ...layout, changes: [], problems: [{ code: "unmapped", account: "100" }] }),
    });
    renderApp(<App />, "/years/y1/statements");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Preview the change" }));
    expect(screen.getByText("Account 100 has a balance but doesn't map to any report line.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Move this year" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
