// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import type { Me } from "@acct/types/Me";
import type { TaxPosition } from "@acct/types/TaxPosition";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { jsonResponse, renderApp, stubApi } from "../../test/render";

const guest: Me = {
  id: "g1",
  username: "",
  display_name: "You",
  role: "business_owner",
  guest: { expires_at: "2026-11-12T03:04:05Z", business_id: "b1", example: null },
};

const exampleOnly: Me = {
  ...guest,
  guest: {
    expires_at: "2026-11-12T03:04:05Z",
    business_id: null,
    example: { business_id: "x1", number: 1, expires_at: "2026-11-07T03:04:05Z" },
  },
};

const saved: Me = { id: "g1", username: "ana@example.com", display_name: "Ana Ngata", role: "business_owner", guest: null };

function businessNamed(id: string, name: string): BusinessView {
  return {
    client_id: id,
    name,
    start_date: "2025-04-01",
    gst_registered_from: null,
    gst_frequency: null,
    bank_accounts: [],
    transfers: [],
    ird_payments: [],
    possible_duplicates: [],
  } as unknown as BusinessView;
}

const tax: TaxPosition = { total: 123400, gst: [], income: [], notices: [] };

const business = {
  "GET /api/businesses/b1": () => businessNamed("b1", "Your business"),
  "GET /api/businesses/b1/tax": () => tax,
  "GET /api/businesses/b2": () => businessNamed("b2", "Marsh Hollow Candles"),
  "GET /api/businesses/b2/tax": () => tax,
  "GET /api/businesses/x1": () => businessNamed("x1", "Tūī Street Coffee"),
  "GET /api/businesses/x1/tax": () => tax,
  "GET /api/examples": () => [],
};

/** The open modal. A native <dialog> isn't "visible" to role queries in jsdom, so find it directly. */
function dialog(): HTMLElement {
  return document.querySelector("dialog")!;
}

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a guest inside the app", () => {
  it("lands on their business with no sign-in, the banner and its date", async () => {
    stubApi({ "GET /api/me": () => guest, ...business });
    renderApp(<App />, "/businesses/b1");
    expect(await screen.findByRole("heading", { name: /Your business/ })).toBeTruthy();
    const banner = screen.getByText(/Your work isn't saved yet/).closest("div")!;
    expect(banner.textContent).toContain("kept until 12 Nov 2026");
    expect(within(banner).getByRole("button", { name: /Save your work/ })).toBeTruthy();
    expect(screen.queryByText(/Welcome back/)).toBeNull();
    // The header says what this is, and has no Sign in or Settings.
    expect(screen.getByRole("link", { name: /Your business/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Settings/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Leave and delete your trial/ })).toBeTruthy();
  });

  it("explains what it can't do yet, each with a way to unlock it", async () => {
    stubApi({ "GET /api/me": () => guest, ...business });
    renderApp(<App />, "/businesses/b1");
    await screen.findByText(/Save your work first to invite your accountant/);
    expect(screen.getByText(/Save your work to file/)).toBeTruthy();
    // Submit stays visible, switched off, with its reason beside it.
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
    const notes = screen.getAllByRole("note");
    for (const note of notes) {
      expect(within(note).getByRole("button", { name: /Save your work/ })).toBeTruthy();
    }
  });

  it("sends a guest away from a route they can't use", async () => {
    stubApi({ "GET /api/me": () => guest, ...business });
    renderApp(<App />, "/settings");
    expect(await screen.findByText(/Your work isn't saved yet/)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: /Your business/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Settings/ })).toBeNull();
  });

  it("gives an example its own wording, and sends its Save your work to sign-up", async () => {
    stubApi({ "GET /api/me": () => exampleOnly, ...business });
    renderApp(<App />, "/businesses/x1");
    expect(await screen.findByText(/This is an example · kept until 7 Nov 2026/)).toBeTruthy();
    expect(await screen.findByText(/so it can't be filed/)).toBeTruthy();
    expect(screen.queryByLabelText(/Choose statement files/)).toBeNull();
    const user = userEvent.setup();
    const banner = screen.getByText(/This is an example · kept until/).closest("div")!;
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    expect(await screen.findByText(/Examples can't be saved/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign up" }).getAttribute("href")).toBe("/signup");
  });

  it("saves their work with claim_guest, then the banner goes without reloading the business", async () => {
    let me: Me = guest;
    let businessReads = 0;
    const calls = stubApi({
      "GET /api/me": () => me,
      ...business,
      "GET /api/businesses/b1": () => {
        businessReads += 1;
        return businessNamed("b1", "Ana's Candles");
      },
      "POST /api/guest/claim": () => {
        me = saved;
        return { me: saved, business_id: "b1" };
      },
    });
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    const banner = (await screen.findByText(/Your work isn't saved yet/)).closest("div")!;
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    await user.type(await screen.findByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Your name"), "Ana Ngata");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.type(screen.getByLabelText(/Business name/), "Ana's Candles");
    await user.click(within(dialog()).getByRole("button", { name: "Save your work" }));

    await waitFor(() => expect(screen.queryByText(/Your work isn't saved yet/)).toBeNull());
    const claim = calls.find((c) => c.path === "/api/guest/claim")!;
    expect(claim.body).toMatchObject({
      email: "ana@example.com",
      display_name: "Ana Ngata",
      password: "correct horse battery",
      business_name: "Ana's Candles",
    });
    // Still on the same page, with the invite form now live, and no refetch of the business.
    expect(await screen.findByLabelText("Their email")).toBeTruthy();
    expect(businessReads).toBe(1);
  });

  it("says so when the email is taken, and offers to sign in instead", async () => {
    const calls = stubApi({
      "GET /api/me": () => guest,
      ...business,
      "POST /api/guest/claim": () =>
        jsonResponse(409, {
          code: "email_taken",
          message: "There's already an account with that email. Sign in instead.",
          details: null,
        }),
    });
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    const banner = (await screen.findByText(/Your work isn't saved yet/)).closest("div")!;
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    await user.type(await screen.findByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Your name"), "Ana");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(within(dialog()).getByRole("button", { name: "Save your work" }));

    expect(await screen.findByText(/There's already an account with that email/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Sign in instead/ }).getAttribute("href")).toBe("/#signin");
    expect(calls.filter((c) => c.path === "/api/guest/claim")).toHaveLength(1);
    // Still a guest.
    expect(screen.getByText(/Your work isn't saved yet/)).toBeTruthy();
  });

  it("deletes the trial on request, after asking", async () => {
    const calls = stubApi({ "GET /api/me": () => guest, ...business, "POST /api/commands": () => ({ seq: 4, entity_id: null }) });
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Delete it now/ }));
    await screen.findByText("Delete your trial now?");
    await user.click(within(dialog()).getByRole("button", { name: "Delete it now" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/commands")).toBe(true));
    expect(calls.find((c) => c.path === "/api/commands")!.body).toMatchObject({
      kind: "expire_guest",
      payload: { client_id: "b1", why: "by_you" },
    });
  });
});

describe("a guest who signs in to an existing account", () => {
  const owner: Me = {
    id: "u9",
    username: "sam@example.com",
    display_name: "Sam",
    role: "business_owner",
    guest: null,
    moveable_trial: { statements: 1, lines: 27 },
  };

  it("is offered the trial, and moving it opens that business", async () => {
    let me: Me = owner;
    const calls = stubApi({
      "GET /api/me": () => me,
      "GET /api/clients": () => [],
      ...business,
      "POST /api/guest/adopt": () => {
        me = { ...owner, moveable_trial: undefined };
        return { business_id: "b2" };
      },
    });
    renderApp(<App />, "/businesses/b1");
    expect(await screen.findByText(/Move the statement you just tried into your account/)).toBeTruthy();
    expect(screen.getByText(/1 statement \(27 lines\)/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Move it" }));
    expect(await screen.findByRole("heading", { name: /Marsh Hollow Candles/ })).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/guest/adopt")!.body).toMatchObject({ move_it: true });
    expect(screen.queryByText(/Move the statement/)).toBeNull();
  });

  it("can leave it", async () => {
    const calls = stubApi({
      "GET /api/me": () => owner,
      "GET /api/clients": () => [],
      ...business,
      "POST /api/guest/adopt": () => ({ business_id: null }),
    });
    renderApp(<App />, "/businesses/b1");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Leave it" }));
    await waitFor(() => expect(screen.queryByText(/Move the statement/)).toBeNull());
    expect(calls.find((c) => c.path === "/api/guest/adopt")!.body).toMatchObject({ move_it: false });
  });
});
