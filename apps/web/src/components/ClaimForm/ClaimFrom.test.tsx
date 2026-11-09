// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import type { ClaimFrom } from "@acct/types/ClaimFrom";
import type { Me } from "@acct/types/Me";
import type { SaveTaxQueue } from "@acct/types/SaveTaxQueue";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { rememberAccountantViewOpened } from "../../lib/books";
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
  guest: { expires_at: "2026-11-07T03:04:05Z", business_id: null, example: { business_id: "x1", number: 1, expires_at: "2026-11-07T03:04:05Z" } },
};
const saved: Me = { id: "g1", username: "ana@example.com", display_name: "Ana Ngata", role: "business_owner", guest: null };

const business = {
  client_id: "b1",
  name: "Your business",
  start_date: "2025-04-01",
  gst_registered_from: null,
  gst_frequency: null,
  bank_accounts: [],
  transfers: [],
  ird_payments: [],
  possible_duplicates: [],
} as unknown as BusinessView;

const queue = (savedSoFar: number): SaveTaxQueue => ({ total: 700_000, conservative_total: 900_000, saved_so_far: savedSoFar, cards: [] });

/** What a guest's pages read, plus the claim. */
function server(me: Me = guest, extra: Record<string, () => unknown> = {}) {
  return stubApi({
    "GET /api/me": () => me,
    "GET /api/businesses/b1": () => business,
    "GET /api/businesses/b1/tax": () => ({ total: 123_400, gst: [], income: [], notices: [] }),
    "GET /api/businesses/b1/save-tax": () => queue(25_000),
    "GET /api/clients/b1": () => ({ id: "b1", name: "Your business", entity_type: "sole_trader", is_business: true, retained_earnings: "810", rounding_priority: [], years: [] }),
    "GET /api/clients/b1/chart": () => [],
    "GET /api/examples": () => [],
    "POST /api/guest/claim": () => ({ me: saved, business_id: "b1" }),
    ...extra,
  });
}

const dialog = () => document.querySelector("dialog")!;
const claimBody = (calls: ReturnType<typeof stubApi>) => calls.find((c) => c.path === "/api/guest/claim")!.body as { from?: ClaimFrom };

async function claim(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Email"), "ana@example.com");
  await user.type(screen.getByLabelText("Your name"), "Ana Ngata");
  await user.type(screen.getByLabelText("Password"), "correct horse battery");
  await user.click(within(dialog()).getByRole("button", { name: "Save your work" }));
}

/** The button in a locked line, found by the line's words. */
const inLine = (text: RegExp) => within(screen.getByText(text).closest("p")!).getByRole("button", { name: /Save your work/ });

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("from on every claim path (ADR 015, 4)", () => {
  it("the banner's button sends banner", async () => {
    const calls = server();
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    const banner = (await screen.findByText(/Your work isn't saved yet/)).closest("div")!;
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    await claim(user);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/guest/claim")).toBe(true));
    expect(claimBody(calls).from).toBe("banner");
  });

  it("the Submit lock sends submit, and the invite lock sends locked:invite", async () => {
    for (const [line, from] of [
      [/Save your work to file/, "submit"],
      [/Save your work first to invite your accountant/, "locked:invite"],
    ] as const) {
      const calls = server();
      renderApp(<App />, "/businesses/b1");
      const user = userEvent.setup();
      await screen.findByText(line);
      await user.click(inLine(line));
      await claim(user);
      await waitFor(() => expect(calls.some((c) => c.path === "/api/guest/claim")).toBe(true));
      expect(claimBody(calls).from).toBe(from);
      cleanup();
    }
  });

  it("the AI lock sends locked:ai", async () => {
    const calls = server();
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    await screen.findByText(/get suggestions from the experts/);
    await user.click(inLine(/get suggestions from the experts/));
    await claim(user);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/guest/claim")).toBe(true));
    expect(claimBody(calls).from).toBe("locked:ai");
  });

  it("the first-saving line sends saving", async () => {
    const calls = server();
    renderApp(<App />, "/businesses/b1/save-tax");
    const user = userEvent.setup();
    const line = (await screen.findByText(/Keep the \$250\.00 you've saved/)).closest("[role=note]") as HTMLElement;
    await user.click(within(line).getByRole("button", { name: /Save your work/ }));
    await claim(user);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/guest/claim")).toBe(true));
    expect(claimBody(calls).from).toBe("saving");
  });

  it("the banner on an accountant-view page sends accountant_view", async () => {
    const calls = server();
    renderApp(<App />, "/businesses/b1/books/statements");
    const user = userEvent.setup();
    const banner = (await screen.findByText(/Your work isn't saved yet/)).closest("div")!;
    await screen.findByText(/No books yet/);
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    // They opened the accountant view, so the question comes first; the owner is picked already.
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await claim(user);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/guest/claim")).toBe(true));
    expect(claimBody(calls).from).toBe("accountant_view");
  });
});

describe("Who are you? (ADR 015, 6)", () => {
  it("isn't asked of a guest who never opened the accountant view", async () => {
    server();
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    const banner = (await screen.findByText(/Your work isn't saved yet/)).closest("div")!;
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(screen.queryByText("Who are you?")).toBeNull();
  });

  it("isn't asked because a different guest opened it in this browser", async () => {
    rememberAccountantViewOpened("someone-else");
    server();
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    const banner = (await screen.findByText(/Your work isn't saved yet/)).closest("div")!;
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(screen.queryByText("Who are you?")).toBeNull();
  });

  it("is asked after the accountant view, with I run this business already chosen", async () => {
    rememberAccountantViewOpened("g1");
    server();
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    const banner = (await screen.findByText(/Your work isn't saved yet/)).closest("div")!;
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    expect(await screen.findByText("Who are you?")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "I run this business" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /I'm an accountant or bookkeeper/ }) as HTMLInputElement).checked).toBe(false);
    // Continuing with the default is the claim form, unchanged.
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Email")).toBeTruthy();
  });

  it("sends an owner with only an example to 'Examples can't be saved', after the question", async () => {
    rememberAccountantViewOpened("g1");
    server(exampleOnly, { "GET /api/businesses/x1": () => ({ ...business, client_id: "x1", example: 1 }), "GET /api/businesses/x1/tax": () => ({ total: 0, gst: [], income: [], notices: [] }) });
    renderApp(<App />, "/businesses/x1");
    const user = userEvent.setup();
    const banner = (await screen.findByText(/This is an example/)).closest("div")!;
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    await screen.findByText("Who are you?");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Examples can't be saved/)).toBeTruthy();
  });

  it("sends an accountant to the practice request and leaves the trial alone", async () => {
    rememberAccountantViewOpened("g1");
    const calls = server(guest, { "POST /api/practice-requests": () => ({ seq: 9, entity_id: "r1" }) });
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    const banner = (await screen.findByText(/Your work isn't saved yet/)).closest("div")!;
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    await screen.findByText("Who are you?");
    await user.click(screen.getByRole("radio", { name: /I'm an accountant or bookkeeper/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await user.type(await screen.findByLabelText("Your name"), "Pat Lee");
    await user.type(screen.getByLabelText("Email"), "pat@example.com");
    await user.type(screen.getByLabelText("Firm name"), "Lee and Co");
    await user.selectOptions(screen.getByLabelText("Roughly how many clients?"), "11_to_50");
    await user.click(within(dialog()).getByRole("button", { name: "Send request" }));

    expect(await screen.findByText(/Thanks, Pat Lee\. We'll email pat@example\.com about setting up your firm\./)).toBeTruthy();
    expect(screen.getByText(/Your trial stays as it is: it's kept for 7 days after you last use it/)).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/practice-requests")!.body).toMatchObject({
      name: "Pat Lee",
      email: "pat@example.com",
      practice_name: "Lee and Co",
      clients: "11_to_50",
      from: "who_are_you",
    });
    // No claim: the guest is still a guest.
    expect(calls.some((c) => c.path === "/api/guest/claim")).toBe(false);
    expect(screen.getByText(/Your work isn't saved yet/)).toBeTruthy();
  });
});

describe("the expiry wording (ADR 015, 3.5 A)", () => {
  it("says when the trial goes, with no countdown, and the claim form says how long trials are kept", async () => {
    server();
    renderApp(<App />, "/businesses/b1");
    const user = userEvent.setup();
    const banner = (await screen.findByText(/Your work isn't saved yet/)).closest("div")!;
    expect(banner.textContent).toContain("kept until 12 Nov 2026");
    expect(banner.textContent).not.toMatch(/hours|last 48|days left|countdown/i);
    await user.click(within(banner).getByRole("button", { name: /Save your work/ }));
    expect(await screen.findByText(/Trials are kept for 7 days after you last use them\./)).toBeTruthy();
  });
});

describe("the practice request form", () => {
  it("shows the per-address refusal and sends nothing more", async () => {
    const calls = stubApi({
      "GET /api/me": () => null,
      "POST /api/practice-requests": () =>
        jsonResponse(429, {
          code: "too_many_requests",
          message: "We've had a few requests from your network in the last hour. Try again later, or get in touch through the contact page.",
          details: null,
        }),
    });
    renderApp(<App />, "/accountants");
    const user = userEvent.setup();
    // The page offers it at the top and again at the bottom; either opens the same form.
    await user.click((await screen.findAllByRole("button", { name: /Sign up your firm/ }))[0]!);
    expect(screen.getByText(/Please don't upload a client's statement here without their OK\./)).toBeTruthy();
    await user.type(within(dialog()).getByLabelText("Your name"), "Pat Lee");
    await user.type(within(dialog()).getByLabelText("Email"), "pat@example.com");
    await user.type(within(dialog()).getByLabelText("Firm name"), "Lee and Co");
    await user.type(within(dialog()).getByLabelText("Phone (optional)"), "021 555 0100");
    await user.click(within(dialog()).getByRole("button", { name: "Send request" }));
    expect(await screen.findByText(/We've had a few requests from your network in the last hour/)).toBeTruthy();
    expect(calls.filter((c) => c.path === "/api/practice-requests")).toHaveLength(1);
    expect(calls.find((c) => c.path === "/api/practice-requests")!.body).toMatchObject({ phone: "021 555 0100", from: "accountants_page", clients: "up_to_10" });
    // Nothing was sent, so the form is still there to try again later.
    expect(within(dialog()).getByLabelText("Your name")).toBeTruthy();
  });

  it("is on /signup too, and says what happens next once sent", async () => {
    const calls = stubApi({
      "GET /api/me": () => null,
      "POST /api/practice-requests": () => ({ seq: 1, entity_id: "r1" }),
    });
    renderApp(<App />, "/signup");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Sign up your firm/ }));
    await user.type(within(dialog()).getByLabelText("Your name"), "Pat Lee");
    await user.type(within(dialog()).getByLabelText("Email"), "pat@example.com");
    await user.type(within(dialog()).getByLabelText("Firm name"), "Lee and Co");
    await user.click(within(dialog()).getByRole("button", { name: "Send request" }));
    expect(await screen.findByText(/We'll email pat@example\.com about setting up your firm/)).toBeTruthy();
    expect(screen.queryByText(/Your trial stays as it is/)).toBeNull();
    const body = calls.find((c) => c.path === "/api/practice-requests")!.body as { id: string; from: string; phone?: string };
    expect(body.from).toBe("signup_page");
    expect(body.phone).toBeUndefined();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
