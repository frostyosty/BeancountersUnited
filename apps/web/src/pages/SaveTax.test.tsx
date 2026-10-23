// @vitest-environment jsdom
import type { Account } from "@acct/types/Account";
import type { BusinessView } from "@acct/types/BusinessView";
import type { CardLine } from "@acct/types/CardLine";
import type { SaveTaxCard } from "@acct/types/SaveTaxCard";
import type { SaveTaxQueue } from "@acct/types/SaveTaxQueue";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { sam, val } from "../test/data";
import { renderApp, stubApi } from "../test/render";
import { formatPercent, incomeYearOf, parsePercentBp } from "./SaveTaxCategorise";
import { acceptBatches } from "./SaveTaxPage";

const bank = (id: string, code: string, name: string) => ({
  id,
  code,
  name,
  account_number: null,
  opening_date: null,
  opening_balance: null,
  needs_opening_balance: false,
  statements: [],
  gaps: [],
  reconciliation: null,
});

const business: BusinessView = {
  client_id: "b1",
  name: "Marsh Hollow Candles",
  start_date: "2025-08-01",
  gst_registered_from: "2025-08-01",
  gst_frequency: "two_monthly_odd",
  bank_accounts: [bank("a1", "600.01", "Kauri cheque"), bank("a3", "600.03", "Rimu savings")],
  transfers: [],
  ird_payments: [],
  possible_duplicates: [],
};

const chart: Account[] = [
  { code: "100", name: "Sales", account_type: "income", active: true, default_gst: "standard" },
  { code: "140", name: "Money in, not yet sorted", account_type: "income", active: true, default_gst: "standard" },
  { code: "150", name: "Purchases and materials", account_type: "expense", active: true, default_gst: "standard" },
  { code: "205", name: "Bank fees", account_type: "expense", active: true, default_gst: "exempt" },
  { code: "225", name: "Vehicle costs", account_type: "expense", active: true, default_gst: "standard" },
  { code: "600.01", name: "Kauri cheque", account_type: "asset", active: true },
  { code: "600.03", name: "Rimu savings", account_type: "asset", active: true },
];

const line = (id: string, amount: number, description: string, account = "a1"): CardLine => ({
  bank_line_id: id,
  bank_account_id: account,
  account_name: account === "a1" ? "Kauri cheque" : "Rimu savings",
  date: "2025-09-12",
  amount,
  description,
});

const card = (c: Partial<SaveTaxCard> & Pick<SaveTaxCard, "id" | "kind" | "saving">): SaveTaxCard => ({
  question: null,
  income_year: null,
  lines: [],
  suggestion: null,
  gap: null,
  best_case: false,
  ...c,
});

const queue = (cards: SaveTaxCard[], saved = 0): SaveTaxQueue => ({
  total: 250632 - saved,
  conservative_total: 250632,
  saved_so_far: saved,
  cards,
});

const onlyIncome = card({ id: "question:only_income:2026", kind: "question", question: "only_income", income_year: 2026, saving: 153797 });
const studentLoan = card({ id: "question:student_loan:2026", kind: "question", question: "student_loan", income_year: 2026, saving: 45569 });

function routes(save: () => SaveTaxQueue, me = sam) {
  return stubApi({
    "GET /api/me": () => me,
    "GET /api/businesses/b1": () => business,
    "GET /api/businesses/b1/tax": () => ({ total: 0, gst: [], income: [], notices: [] }),
    "GET /api/businesses/b1/save-tax": save,
    "GET /api/businesses/b1/ai-suggestions": () => ({ available: false, provider: null, model: null, consent_version: null, enabled: false, needs_consent: false, activity: null, private_names: [], suggestions: [] }),
    "GET /api/clients/b1/chart": () => chart,
    "POST /api/commands": () => ({ seq: 20, entity_id: null }),
  });
}

const posts = (calls: { method: string; body: unknown }[]) => calls.filter((c) => c.method === "POST").map((c) => c.body);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("save tax", () => {
  it("opens from the business screen", async () => {
    routes(() => queue([onlyIncome]));
    renderApp(<App />, "/businesses/b1");
    await userEvent.setup().click(await screen.findByRole("button", { name: /Save tax/ }));
    expect(await screen.findByText(/Was this business your only income/)).toBeTruthy();
  });

  it("shows one card at a time, biggest saving first, and refetches after each answer", async () => {
    let answered = false;
    const calls = routes(() => (answered ? queue([studentLoan], 153797) : queue([onlyIncome, studentLoan])));
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/Was this business your only income in the year to 31 March 2026/)).toBeTruthy();
    expect(screen.getByText("Saves $1,537.97")).toBeTruthy();
    expect(screen.queryByText(/student loan/)).toBeNull();
    expect(screen.getByText("2 to go, biggest saving first.")).toBeTruthy();
    expect(screen.getByText("$0.00")).toBeTruthy();

    answered = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "Yes, it's my only income" }));
    expect(await screen.findByText(/Did you have a student loan/)).toBeTruthy();
    expect(screen.getByText("$1,537.97")).toBeTruthy();
    expect(posts(calls)).toEqual([
      expect.objectContaining({
        kind: "answer_question",
        payload: { client_id: "b1", income_year: 2026, answer: { question: "only_income", yes: true } },
      }),
    ]);
  });

  it("asks for other income in dollars and sends cents", async () => {
    const other = card({ id: "question:other_income:2026", kind: "question", question: "other_income", income_year: 2026, saving: 1000, best_case: true });
    const calls = routes(() => queue([other]));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    expect(await screen.findByText("Could save up to $10.00")).toBeTruthy();
    await user.type(screen.getByLabelText(/Other income, before tax/), "45,000");
    await user.type(screen.getByLabelText(/Tax already taken off/), "6,543.21");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      kind: "answer_question",
      payload: { answer: { question: "other_income", income: 4500000, tax_deducted: 654321 } },
    });
  });

  it("skips a card for now and can bring it back", async () => {
    routes(() => queue([onlyIncome, studentLoan]));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    await screen.findByText(/Was this business your only income/);
    await user.click(screen.getByRole("button", { name: /Skip for now/ }));
    expect(screen.getByText(/Did you have a student loan/)).toBeTruthy();
    expect(screen.getByText("Last one!")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Skip for now/ }));
    expect(screen.getByText(/You skipped 2/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Show the ones I skipped/ }));
    expect(screen.getByText(/Was this business your only income/)).toBeTruthy();
  });

  it("confirms a transfer between the owner's accounts", async () => {
    const transfer = card({
      id: "transfer:l1:l2",
      kind: "transfer",
      saving: 5000,
      lines: [line("l1", -50000, "TO SAVINGS"), line("l2", 50000, "FROM CHEQUE", "a3")],
    });
    const calls = routes(() => queue([transfer]));
    renderApp(<App />, "/businesses/b1/save-tax");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Yes, it's a transfer" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "confirm_transfer", payload: { out_line_id: "l1", in_line_id: "l2" } });
  });

  it("records a payment to IRD as income tax for the chosen year", async () => {
    const ird = card({ id: "line:l3", kind: "ird_payment", saving: 80000, best_case: true, lines: [line("l3", -80000, "IRD PAYMENT")] });
    const calls = routes(() => queue([ird]));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Income tax for which year"), "2025");
    await user.click(screen.getByRole("button", { name: "Income tax" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      kind: "confirm_ird_payment",
      payload: { bank_line_id: "l3", payment: { kind: "income_tax", income_year: 2025 } },
    });
  });

  it("confirms a GST refund, and resolves a duplicate", async () => {
    const refund = card({ id: "line:l4", kind: "ird_payment", saving: 2000, lines: [line("l4", 16342, "IRD GST REFUND")] });
    const dup = card({ id: "line:l5", kind: "duplicate", saving: 1000, lines: [line("l5", 2500, "SALE MARKET")] });
    const calls = routes(() => queue([refund, dup]));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Yes, a GST refund" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: /Skip for now/ }));
    await user.click(screen.getByRole("button", { name: "Yes, it's a duplicate" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)).toEqual([
      expect.objectContaining({ kind: "confirm_ird_payment", payload: { bank_line_id: "l4", payment: { kind: "gst" } } }),
      expect.objectContaining({ kind: "resolve_duplicate", payload: { bank_line_id: "l5", is_duplicate: true } }),
    ]);
  });

  it("says what a missing statement costs", async () => {
    const gap = card({
      id: "gap:a3:2025-08-01",
      kind: "gap",
      saving: 31122,
      best_case: true,
      gap: { bank_account_id: "a3", start: "2025-08-01", end: "2025-08-28", change: 100000 },
    });
    routes(() => queue([gap]));
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/no statement for Rimu savings from 1 Aug 2025 to 28 Aug 2025/)).toBeTruthy();
    expect(screen.getByText(/went up by \$1,000.00/)).toBeTruthy();
    expect(screen.getByText("$311.22")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Upload the missing statement/ }).getAttribute("href")).toBe("/businesses/b1");
  });

  it("confirms the supplier's tax invoice", async () => {
    const supply = card({ id: "supply:l6", kind: "supply_info", saving: 6500, lines: [line("l6", -49900, "BIG TOOL SHOP")] });
    const calls = routes(() => queue([supply]));
    renderApp(<App />, "/businesses/b1/save-tax");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Yes, I have it" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "confirm_supply_info", payload: { bank_line_id: "l6" } });
  });

  it("categorises spending by plain names, with the GST tick over $200 and a rule", async () => {
    const spend = card({ id: "line:l7", kind: "categorise", saving: 4000, best_case: true, lines: [line("l7", -34500, "Z ENERGY 123 WELLINGTON")] });
    const calls = routes(() => queue([spend]));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/A business cost/));
    const category = screen.getByLabelText("Category") as HTMLSelectElement;
    await waitFor(() => expect(category.options.length).toBeGreaterThan(1));
    // Plain names, never codes, and only spending categories.
    const names = Array.from(category.options).map((o) => o.textContent);
    expect(names).toEqual(["Choose…", "Purchases and materials", "Bank fees", "Vehicle costs"]);
    expect(screen.queryByText(/225|150/)).toBeNull();

    await user.selectOptions(category, "Vehicle costs");
    await user.click(screen.getByLabelText(/I have the supplier's tax invoice/));
    await user.click(screen.getByLabelText(/Always do this for "Z ENERGY 123 WELLINGTON"/));
    const text = screen.getByLabelText("Description contains");
    await user.clear(text);
    await user.type(text, "Z ENERGY");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    const coding = { direction: "out", kind: "expense", account: "225", gst: "standard" };
    expect(posts(calls)).toEqual([
      expect.objectContaining({ kind: "code_bank_line", payload: { bank_line_id: "l7", coding, supply_info_confirmed: true } }),
      expect.objectContaining({ kind: "add_rule", payload: { client_id: "b1", description_contains: "Z ENERGY", coding } }),
    ]);
  });

  it("hides the GST tick at $200 or less", async () => {
    const spend = card({ id: "line:l8", kind: "categorise", saving: 300, best_case: true, lines: [line("l8", -2000, "PAPER PLUS")] });
    routes(() => queue([spend]));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/A business cost/));
    await waitFor(() => expect((screen.getByLabelText("Category") as HTMLSelectElement).options.length).toBeGreaterThan(1));
    await user.selectOptions(screen.getByLabelText("Category"), "Purchases and materials");
    expect(screen.queryByLabelText(/I have the supplier's tax invoice/)).toBeNull();
  });

  it("splits partly private spending by the personal percentage", async () => {
    const spend = card({ id: "line:l9", kind: "categorise", saving: 900, best_case: true, lines: [line("l9", -12000, "SPARK MOBILE")] });
    const calls = routes(() => queue([spend]));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/Partly business, partly personal/));
    await waitFor(() => expect((screen.getByLabelText("Category") as HTMLSelectElement).options.length).toBeGreaterThan(1));
    await user.selectOptions(screen.getByLabelText("Category"), "Vehicle costs");
    await user.type(screen.getByLabelText(/How much of it was personal/), "12.5");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      kind: "code_bank_line",
      payload: { bank_line_id: "l9", coding: { direction: "out", kind: "part_private", account: "225", gst: "standard", business_bp: 8750 } },
    });
  });

  it("marks a deposit as not income, and says what's missing first", async () => {
    const deposit = card({ id: "line:l10", kind: "categorise", saving: 30000, best_case: true, lines: [line("l10", 100000, "MUM")] });
    const calls = routes(() => queue([deposit]));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Save/ }));
    expect(screen.getByText("Choose what this money was.")).toBeTruthy();
    await user.click(screen.getByLabelText(/Money I put in myself/));
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      kind: "code_bank_line",
      payload: { bank_line_id: "l10", coding: { direction: "in", kind: "owner_funds" } },
    });
  });

  it("accepts a suggestion on its card, or all of them in one batch", async () => {
    const a = card({
      id: "line:l11",
      kind: "categorise",
      saving: 5000,
      lines: [line("l11", -6500, "COUNTDOWN")],
      suggestion: { coding: { direction: "out", kind: "personal" }, source: "rule" },
    });
    const b = card({
      id: "line:l12",
      kind: "categorise",
      saving: 2000,
      lines: [line("l12", -11500, "SPARK")],
      suggestion: { coding: { direction: "out", kind: "expense", account: "150", gst: "standard" }, source: "history" },
    });
    const calls = routes(() => queue([a, b]));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    expect(await screen.findByText("Personal spending")).toBeTruthy();
    expect(screen.getByText("One of your rules says so.")).toBeTruthy();
    expect(screen.getByText(/We have a suggestion for 2 transactions/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Accept all suggestions/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      kind: "code_bank_lines",
      payload: {
        lines: [
          { bank_line_id: "l11", coding: { direction: "out", kind: "personal" } },
          { bank_line_id: "l12", coding: { direction: "out", kind: "expense", account: "150", gst: "standard" } },
        ],
      },
    });
  });

  it("lets viewers look but not answer", async () => {
    routes(() => queue([onlyIncome]), val);
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/viewers can't answer questions/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes, it's my only income" })).toBeNull();
  });

  it("celebrates when there's nothing left", async () => {
    routes(() => queue([], 200000));
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/All done/)).toBeTruthy();
    expect(screen.getByText("$2,000.00")).toBeTruthy();
  });
});

describe("save tax helpers", () => {
  it("parses percentages to basis points without floats", () => {
    expect(parsePercentBp("30")).toBe(3000);
    expect(parsePercentBp("12.5")).toBe(1250);
    expect(parsePercentBp("12.55%")).toBe(1255);
    expect(parsePercentBp("100")).toBe(10000);
    expect(parsePercentBp("100.01")).toBeNull();
    expect(parsePercentBp("-5")).toBeNull();
    expect(parsePercentBp("1.234")).toBeNull();
    expect(formatPercent(1250)).toBe("12.5");
    expect(formatPercent(1255)).toBe("12.55");
    expect(formatPercent(7000)).toBe("70");
  });

  it("puts dates in the income year to 31 March", () => {
    expect(incomeYearOf("2025-03-31")).toBe(2025);
    expect(incomeYearOf("2025-04-01")).toBe(2026);
  });
});

describe("AI suggestions (ADR 009)", () => {
  const ai = (id: string, lineId: string, model: string, amount = -4200): SaveTaxCard =>
    card({
      id: `line:${lineId}`,
      kind: "categorise",
      saving: 1000,
      lines: [line(lineId, amount, "WAREHOUSE STATIONERY")],
      suggestion: { coding: { direction: "out", kind: "expense", account: "150", gst: "standard" }, source: "ai", id, model },
    });
  const rule = card({
    id: "line:r1",
    kind: "categorise",
    saving: 500,
    lines: [line("r1", -6500, "COUNTDOWN")],
    suggestion: { coding: { direction: "out", kind: "personal" }, source: "rule" },
  });

  it("says the AI suggested it, and sends via when accepted unchanged", async () => {
    const calls = routes(() => queue([ai("s1", "l20", "claude-haiku-5-5")]));
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText(/Suggested by AI from the description and amount/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Yes, that's right" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      kind: "code_bank_line",
      payload: { bank_line_id: "l20" },
      via: { kind: "suggestion", model: "claude-haiku-5-5", suggestion_ids: ["s1"] },
    });
  });

  it("says when the practice's merchant list suggested it, and sends no via", async () => {
    const merchant = card({
      id: "line:m1",
      kind: "categorise",
      saving: 800,
      lines: [line("m1", -6100, "GRIDLINE POWER")],
      suggestion: { coding: { direction: "out", kind: "expense", account: "150", gst: "standard" }, source: "merchant" },
    });
    const calls = routes(() => queue([merchant]));
    renderApp(<App />, "/businesses/b1/save-tax");
    expect(await screen.findByText("Your accountant's list of common businesses says so.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Yes, that's right" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "code_bank_line", payload: { bank_line_id: "m1" } });
    expect(posts(calls)[0]).not.toHaveProperty("via");
  });

  it("sends no via when the owner changes the pre-fill", async () => {
    const calls = routes(() => queue([ai("s1", "l20", "claude-haiku-5-5")]));
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "No, it's something else" }));
    await user.click(screen.getByLabelText(/Personal spending/));
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "code_bank_line", payload: { coding: { direction: "out", kind: "personal" } } });
    expect(posts(calls)[0]).not.toHaveProperty("via");
  });

  it("accepts all in one command per model, listing only AI ids in via", async () => {
    const calls = routes(() => queue([ai("s1", "l20", "model-a"), rule, ai("s2", "l21", "model-b"), ai("s3", "l22", "model-a")]));
    renderApp(<App />, "/businesses/b1/save-tax");
    await userEvent.setup().click(await screen.findByRole("button", { name: /Accept all suggestions/ }));
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)).toEqual([
      expect.objectContaining({
        kind: "code_bank_lines",
        payload: { lines: [expect.objectContaining({ bank_line_id: "l20" }), expect.objectContaining({ bank_line_id: "l22" }), expect.objectContaining({ bank_line_id: "r1" })] },
        via: { kind: "suggestion", model: "model-a", suggestion_ids: ["s1", "s3"] },
      }),
      expect.objectContaining({
        kind: "code_bank_lines",
        payload: { lines: [expect.objectContaining({ bank_line_id: "l21" })] },
        via: { kind: "suggestion", model: "model-b", suggestion_ids: ["s2"] },
      }),
    ]);
  });

  it("sends rule and history suggestions alone without via", () => {
    const batches = acceptBatches([rule]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).not.toHaveProperty("via");
  });
});
