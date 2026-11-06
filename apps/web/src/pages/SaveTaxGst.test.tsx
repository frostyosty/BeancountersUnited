// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp, stubApi } from "../test/render";
import { GstPanel, GstRegisteredQuestion } from "./SaveTaxGst";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const business = (over: Partial<BusinessView>): BusinessView => ({
  client_id: "b1",
  name: "Your business",
  start_date: "2025-04-01",
  gst_registered_from: "2025-04-01",
  gst_frequency: "two_monthly_odd",
  gst_source: "assumed",
  gst_evidence: null,
  gst_contradicted_by: null,
  example: null,
  bank_accounts: [],
  transfers: [],
  ird_payments: [],
  possible_duplicates: [],
  ...over,
});

const gstLine = (amount: number) => ({ bank_account_id: "a1", date: "2025-09-25", amount, description: "IRD GST REFUND" });

function commands() {
  const calls = stubApi({ "POST /api/commands": () => ({ seq: 2, entity_id: null }) });
  return () => calls.filter((c) => c.path === "/api/commands").map((c) => (c.body as { kind: string; payload: unknown }).payload);
}

describe("Are you GST registered?", () => {
  it("answers no as the owner, the answer that saves", async () => {
    const sent = commands();
    renderApp(<GstRegisteredQuestion clientId="b1" canEdit />);
    expect(screen.getByText(/we've worked your tax out as if you are/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "No, I'm not registered" }));
    await waitFor(() => expect(sent()).toEqual([{ client_id: "b1", registered: false, source: "owner" }]));
  });

  it("answers yes with how often they file", async () => {
    const sent = commands();
    renderApp(<GstRegisteredQuestion clientId="b1" canEdit />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("How often do you file GST?"), "six_monthly");
    await user.click(screen.getByRole("button", { name: "Yes, I'm registered" }));
    await waitFor(() =>
      expect(sent()).toEqual([{ client_id: "b1", registered: true, source: "owner", frequency: "six_monthly" }]),
    );
  });
});

describe("the GST panel on Save tax", () => {
  it("says why: the line that proved it, or that it's assumed", () => {
    stubApi({});
    renderApp(<GstPanel business={business({ gst_source: "detected", gst_evidence: gstLine(-123_400) })} canEdit />);
    expect(screen.getByText(/GST registered, two-monthly: we spotted a GST payment to IRD on 25 Sep 2025/)).toBeTruthy();
    cleanup();
    renderApp(<GstPanel business={business({})} canEdit />);
    expect(screen.getByText(/Assumed GST registered, two-monthly, until you tell us/)).toBeTruthy();
  });

  it("changes it from the panel, and IRD's answer can't be changed here", async () => {
    const sent = commands();
    renderApp(<GstPanel business={business({ gst_source: "detected", gst_evidence: gstLine(-123_400) })} canEdit />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.click(screen.getByRole("button", { name: "No, I'm not registered" }));
    await waitFor(() => expect(sent()).toEqual([{ client_id: "b1", registered: false, source: "owner" }]));
    cleanup();
    renderApp(<GstPanel business={business({ gst_source: "ird" })} canEdit />);
    expect(screen.getByText(/IRD has you as GST registered/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("asks again when a later statement has a GST refund after the owner said no", async () => {
    const sent = commands();
    const said = business({ gst_registered_from: null, gst_frequency: null, gst_source: "owner", gst_contradicted_by: gstLine(16_342) });
    renderApp(<GstPanel business={said} canEdit />);
    expect(screen.getByText(/Your statement has a GST refund from IRD on 25 Sep 2025 \(\$163.42\). Are you GST registered after all\?/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Yes, I'm registered" }));
    await waitFor(() =>
      expect(sent()).toEqual([{ client_id: "b1", registered: true, source: "owner", frequency: "two_monthly_odd" }]),
    );
  });
});
