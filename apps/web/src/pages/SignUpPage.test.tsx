// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import type { Me } from "@acct/types/Me";
import type { TaxPosition } from "@acct/types/TaxPosition";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { sam } from "../test/data";
import { jsonResponse, renderApp, stubApi } from "../test/render";

const ana: Me = { id: "u9", username: "ana@example.nz", display_name: "Ana", role: "business_owner" };

const business: BusinessView = {
  client_id: "b1",
  name: "Ana's Gardens",
  start_date: "2025-04-01",
  gst_registered_from: null,
  gst_frequency: null,
  bank_accounts: [],
  transfers: [],
  ird_payments: [],
  possible_duplicates: [],
};

const tax: TaxPosition = { total: 0, gst: [], income: [], notices: [] };

const signedOut = () => jsonResponse(401, { code: "unauthenticated", message: "", details: null });

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SignUpPage", () => {
  it("signs an owner up and lands on their business", async () => {
    const calls = stubApi({
      "GET /api/me": signedOut,
      "POST /api/signup": () => ({ me: ana, business_id: "b1" }),
      "GET /api/businesses/b1": () => business,
      "GET /api/businesses/b1/tax": () => tax,
    });
    renderApp(<App />, "/signup");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Your name"), "Ana");
    await user.type(screen.getByLabelText("Email"), " ana@example.nz ");
    await user.type(screen.getByLabelText(/^Password/), "correct horse battery");
    await user.type(screen.getByLabelText("Business name"), "Ana's Gardens");
    await user.type(screen.getByLabelText("Started on"), "2025-04-01");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByRole("heading", { name: "Ana's Gardens" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Invite your accountant/ })).toBeTruthy();
    // An owner sees their business, not the practice's clients or the accountant view.
    expect(screen.getAllByRole("link", { name: /Overview/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Accountant view" })).toBeNull();

    const body = calls.find((c) => c.path === "/api/signup")?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      email: "ana@example.nz",
      display_name: "Ana",
      password: "correct horse battery",
      business_name: "Ana's Gardens",
      start_date: "2025-04-01",
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty("gst");
  });

  it("shows why a sign-up was refused", async () => {
    stubApi({
      "GET /api/me": signedOut,
      "POST /api/signup": () =>
        jsonResponse(422, { code: "email_taken", message: "There's already an account with that email.", details: null }),
    });
    renderApp(<App />, "/signup");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Your name"), "Ana");
    await user.type(screen.getByLabelText("Email"), "ana@example.nz");
    await user.type(screen.getByLabelText(/^Password/), "correct horse battery");
    await user.type(screen.getByLabelText("Business name"), "Ana's");
    await user.type(screen.getByLabelText("Started on"), "2025-04-01");
    await user.click(screen.getByRole("button", { name: "Sign up" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already an account");
  });
});

describe("invites", () => {
  it("lets an owner make a link for their accountant", async () => {
    const calls = stubApi({
      "GET /api/me": () => ana,
      "GET /api/businesses/b1": () => business,
      "GET /api/businesses/b1/tax": () => tax,
      "POST /api/commands": () => ({ seq: 9, entity_id: "inv1" }),
    });
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Their email"), "sam@practice.nz");
    await user.click(screen.getByRole("button", { name: "Make an invite link" }));

    const link = (await screen.findByLabelText("Invite link")) as HTMLInputElement;
    const sent = calls.find((c) => c.path === "/api/commands")?.body as {
      kind: string;
      payload: { client_id: string; email: string; token: string };
    };
    expect(sent.kind).toBe("create_invite");
    expect(sent.payload.client_id).toBe("b1");
    expect(sent.payload.email).toBe("sam@practice.nz");
    expect(sent.payload.token).toMatch(/^[0-9a-f]{64}$/);
    expect(link.value).toBe(`${window.location.origin}/invite/${sent.payload.token}`);
  });

  it("asks a signed-out visitor to sign in first", async () => {
    stubApi({ "GET /api/me": signedOut });
    renderApp(<App />, "/invite/abc");
    expect(await screen.findByRole("heading", { name: /You've been invited/ })).toBeTruthy();
  });

  it("lets a practice user accept, then opens the business", async () => {
    const calls = stubApi({
      "GET /api/me": () => sam,
      "POST /api/commands": () => ({ seq: 10, entity_id: "b1" }),
      "GET /api/clients": () => [],
      "GET /api/businesses/b1": () => business,
      "GET /api/businesses/b1/tax": () => tax,
    });
    renderApp(<App />, "/invite/abc123");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByRole("heading", { name: "Ana's Gardens" })).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/commands")?.body).toMatchObject({
      kind: "accept_invite",
      payload: { token: "abc123" },
    });
    // The invite form is the owner's, not the accountant's.
    expect(screen.queryByRole("heading", { name: /Invite your accountant/ })).toBeNull();
  });
});
