// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import type { TaxPosition } from "@acct/types/TaxPosition";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { sam } from "../test/data";
import { renderApp, stubApi } from "../test/render";

/** The worked example's position (docs/domain.md), as the server reports it. */
const tax: TaxPosition = {
  total: 250632,
  gst: [
    {
      start: "2025-08-01",
      end: "2025-09-30",
      so_far: false,
      can_file_from: "2025-10-01",
      boxes: { box5: 436708, box6: 0, box7: 436708, box8: 56962, box9: 0, box10: 56962, box11: 0, box12: 0, box13: 0, box14: 0, box15: 56962 },
      problem: null,
    },
  ],
  income: [
    {
      income_year: 2026,
      so_far: false,
      can_file_from: "2026-04-01",
      taxable_income: 379745,
      basis: "top_rate_flat",
      income_tax: 148101,
      student_loan_basis: "all_income",
      student_loan: 45569,
      problem: null,
    },
  ],
  notices: [{ code: "incomplete", message: "Rimu savings has 1 stretch(es) with no statement." }],
};

const business: BusinessView = {
  client_id: "b1",
  name: "Marsh Hollow Candles",
  start_date: "2025-08-01",
  gst_registered_from: "2025-08-01",
  gst_frequency: "two_monthly_odd",
  bank_accounts: [
    {
      id: "a3",
      code: "600.03",
      name: "Rimu savings",
      account_number: "99-7702-0000789-00",
      opening_date: null,
      opening_balance: null,
      needs_opening_balance: true,
      statements: [
        {
          file_name: "rimu.csv",
          parser: "rimu-csv-1",
          start: "2025-08-29",
          end: "2025-09-30",
          opening_balance: null,
          closing_balance: null,
          lines_in_file: 4,
          lines_added: 4,
        },
      ],
      gaps: [{ start: "2025-08-01", end: "2025-08-28", change: null }],
      reconciliation: { date: "2025-09-30", ledger: 15376, statement: null, agrees: null },
    },
  ],
  transfers: [],
  ird_payments: [{ bank_account_id: "a2", date: "2025-09-25", amount: 16342, description: "IRD GST REFUND" }],
  possible_duplicates: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("business screen", () => {
  it("shows the three areas, with Submit switched off", async () => {
    stubApi({
      "GET /api/me": () => sam,
      "GET /api/businesses/b1": () => business,
      "GET /api/businesses/b1/tax": () => tax,
    });
    renderApp(<App />, "/businesses/b1");
    expect(await screen.findByText("$2,506.32")).toBeTruthy();
    expect(screen.getByText(/Anything not sorted yet is counted the safe way/)).toBeTruthy();
    expect(screen.getByText(/until you tell us whether you have one/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save tax/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No statement from 1 Aug 2025 to 28 Aug 2025/)).toBeTruthy();
    expect(screen.getByText(/Maybe a payment to or from IRD/)).toBeTruthy();
  });

  it("uploads each file as an import_statement command", async () => {
    const calls = stubApi({
      "GET /api/me": () => sam,
      "GET /api/businesses/b1": () => business,
      "GET /api/businesses/b1/tax": () => tax,
      "POST /api/commands": () => ({ seq: 9, entity_id: "a3" }),
    });
    renderApp(<App />, "/businesses/b1");
    const input = (await screen.findByLabelText(/Choose statement files/)) as HTMLInputElement;
    await userEvent.setup().upload(input, new File(["hello"], "rimu.csv", { type: "text/csv" }));
    await waitFor(() => expect(screen.getByText(/rimu.csv: read/)).toBeTruthy());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      kind: "import_statement",
      payload: { client_id: "b1", file_name: "rimu.csv", content_base64: "aGVsbG8=" },
    });
  });

  it("asks for the opening balance when the first statement starts late", async () => {
    const calls = stubApi({
      "GET /api/me": () => sam,
      "GET /api/businesses/b1": () => business,
      "GET /api/businesses/b1/tax": () => tax,
      "POST /api/commands": () => ({ seq: 10, entity_id: null }),
    });
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Opening balance"), "1,000");
    await user.click(screen.getByRole("button", { name: "Save balance" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      kind: "set_opening_balance",
      payload: { bank_account_id: "a3", balance: 100000 },
    });
  });
});
