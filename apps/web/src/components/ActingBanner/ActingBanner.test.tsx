// @vitest-environment jsdom
import type { HistoryEntry } from "@acct/types/HistoryEntry";
import type { Me } from "@acct/types/Me";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { jsonResponse, renderApp, stubApi } from "../../test/render";
import { minutesLeft } from "./ActingBanner";
import { lastSession } from "./ViewedAsNotice";

const olive: Me = { id: "u-olive", username: "olive", display_name: "Olive", role: "overseer", acting_as: null, real: null };
const sam: Me = { id: "u-sam", username: "sam", display_name: "Sam Staff", role: "staff" };

const users = [
  { id: "u-olive", username: "olive", display_name: "Olive", role: "overseer", active: true },
  { id: "u-sam", username: "sam", display_name: "Sam Staff", role: "staff", active: true },
  { id: "u-gone", username: "gone", display_name: "Gail Gone", role: "staff", active: false },
];

function viewingAsSam(minutes: number, allow = false): Me {
  return {
    ...sam,
    acting_as: {
      user_id: "u-sam",
      name: "Sam Staff",
      role: "staff",
      since: new Date(Date.now() - 6 * 60_000).toISOString(),
      expires_at: new Date(Date.now() + minutes * 60_000).toISOString(),
      allow_changes: allow,
    },
    real: { user_id: "u-olive", name: "Olive", role: "overseer" },
  };
}

const refusal = {
  code: "impersonating",
  message: "You're viewing as Sam Staff, read-only. Turn on Allow changes to make this change.",
  details: null,
};

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const quiet = { "GET /api/clients": () => [], "GET /api/practice": () => ({ name: "P" }) };

describe("view as someone", () => {
  it("starts from Settings → Admin with a reason, then shows the banner", async () => {
    let me: Me = olive;
    const calls = stubApi({
      "GET /api/me": () => me,
      "GET /api/users": () => users,
      "POST /api/commands": () => {
        me = viewingAsSam(30);
        return { seq: 1, entity_id: "a1" };
      },
      ...quiet,
    });
    renderApp(<App />, "/settings/admin");
    const user = userEvent.setup();

    // Only people who can be viewed as: not the overseer, not someone inactive.
    const picker = await screen.findByLabelText("Person");
    expect(within(picker).queryByText(/Olive/)).toBeNull();
    expect(within(picker).queryByText(/Gail/)).toBeNull();
    const start = screen.getByRole("button", { name: /Start viewing/ });
    expect((start as HTMLButtonElement).disabled).toBe(true);

    await screen.findByRole("option", { name: /Sam Staff/ });
    await user.selectOptions(picker, "u-sam");
    await user.type(screen.getByLabelText(/Why are you viewing as them/), "  Sam says the TB won't load ");
    await user.click(start);

    expect(await screen.findByText(/read-only/)).toBeTruthy();
    expect(screen.getByText("Sam Staff", { selector: "strong" })).toBeTruthy();
    const sent = calls.filter((c) => c.path === "/api/commands").map((c) => c.body);
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "start_impersonation",
        payload: { user_id: "u-sam", reason: "Sam says the TB won't load" },
      }),
    ]);
  });

  it("only an overseer gets the Admin tab", async () => {
    stubApi({ "GET /api/me": () => ({ ...sam, role: "practice_admin" }), ...quiet });
    renderApp(<App />, "/settings");
    await screen.findByRole("heading", { name: /Settings/ });
    expect(screen.queryByRole("link", { name: /Admin/ })).toBeNull();
  });

  it("counts down to the server's expiry", async () => {
    stubApi({ "GET /api/me": () => viewingAsSam(24), ...quiet });
    const ticks: (() => void)[] = [];
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 15_000) {
        ticks.push(fn);
        return 0;
      }
      return (realSetInterval as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    }) as unknown as typeof setInterval);
    renderApp(<App />, "/");

    expect(await screen.findByText(/24 min left/)).toBeTruthy();
    const later = Date.now() + 2 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    act(() => ticks.forEach((tick) => tick()));
    expect(await screen.findByText(/22 min left/)).toBeTruthy();
    expect(minutesLeft(new Date(later + 30_000).toISOString(), later)).toBe(1);
    expect(minutesLeft(new Date(later - 1000).toISOString(), later)).toBe(0);
  });

  it("ends from the banner, with an optional reason", async () => {
    let me: Me = viewingAsSam(20);
    const calls = stubApi({
      "GET /api/me": () => me,
      "POST /api/commands": () => {
        me = olive;
        return { seq: 2, entity_id: "a1" };
      },
      ...quiet,
    });
    renderApp(<App />, "/");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /End/ }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Note/), "Sorted");
    await user.click(within(dialog).getByRole("button", { name: "End" }));

    await waitFor(() => expect(screen.queryByText(/min left/)).toBeNull());
    expect(screen.getByText(/Olive/)).toBeTruthy();
    expect(calls.filter((c) => c.path === "/api/commands").map((c) => c.body)).toEqual([
      expect.objectContaining({ kind: "end_impersonation", payload: { reason: "Sorted" } }),
    ]);
  });

  it("asks for a reason before allowing changes, and says what stays refused", async () => {
    let me: Me = viewingAsSam(20);
    const calls = stubApi({
      "GET /api/me": () => me,
      "POST /api/commands": () => {
        me = viewingAsSam(20, true);
        return { seq: 3, entity_id: "a1" };
      },
      ...quiet,
    });
    renderApp(<App />, "/");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Allow changes/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/finalising or reopening a year/)).toBeTruthy();
    const go = within(dialog).getByRole("button", { name: "Allow changes" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/Why do you need/), "Fix the GST code");
    await user.click(go);

    expect(await screen.findByText(/changes on/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Allow changes/ })).toBeNull();
    expect(calls.filter((c) => c.path === "/api/commands").map((c) => c.body)).toEqual([
      expect.objectContaining({ kind: "allow_impersonation_changes", payload: { reason: "Fix the GST code" } }),
    ]);
  });

  it("shows a refused write's message in the usual error style", async () => {
    stubApi({
      "GET /api/me": () => viewingAsSam(20),
      "POST /api/commands": () => jsonResponse(403, refusal),
      "GET /api/users": () => users,
      ...quiet,
    });
    renderApp(<App />, "/settings/account");
    const user = userEvent.setup();
    // Any command refused while viewing: here, Sam's own password change.
    await user.type(await screen.findByLabelText("Current password"), "old");
    await user.type(screen.getByLabelText("New password"), "new-pass-1");
    await user.type(screen.getByLabelText("New password again"), "new-pass-1");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You're viewing as Sam Staff, read-only.");
  });

  it("asks who it is again when the server says the view has ended", async () => {
    let me: Me = viewingAsSam(20);
    stubApi({
      "GET /api/me": () => me,
      "POST /api/commands": () => {
        me = olive;
        return jsonResponse(403, { code: "impersonation_ended", message: "That view has ended.", details: null });
      },
      ...quiet,
    });
    renderApp(<App />, "/");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Allow changes/ }));
    await user.type(within(screen.getByRole("dialog")).getByLabelText(/Why do you need/), "x");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Allow changes" }));
    await waitFor(() => expect(screen.queryByText(/min left/)).toBeNull());
  });

  it("never reads or writes the old sessionStorage override", async () => {
    const touched: string[] = [];
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      const original = Storage.prototype[method];
      vi.spyOn(Storage.prototype, method).mockImplementation(function (this: Storage, key: string, value?: string) {
        touched.push(key);
        return (original as (k: string, v?: string) => unknown).call(this, key, value);
      } as never);
    }
    stubApi({ "GET /api/me": () => viewingAsSam(20), ...quiet });
    renderApp(<App />, "/");
    await screen.findByText(/min left/);
    expect(touched).not.toContain("view-as-role");
  });
});

function entry(seq: number, kind: string, at: string, who = "Olive"): HistoryEntry & { acting_as: { user_id: string; name: string } } {
  return {
    seq,
    at,
    kind,
    description:
      kind === "start_impersonation"
        ? `${who} started viewing as Sam Staff: the TB won't load`
        : `${who} stopped viewing as Sam Staff`,
    user_id: "u-olive",
    who,
    business_id: null,
    business_name: null,
    changes: null,
    tax_change: null,
    ai: null,
    acting_as: { user_id: "u-sam", name: "Sam Staff" },
  };
}

describe("the notice that someone viewed as you", () => {
  const first = [entry(30, "end_impersonation", "2026-11-04T01:12:00Z"), entry(20, "start_impersonation", "2026-11-04T01:00:00Z")];

  function history(entries: unknown[]) {
    return { "GET /api/history": () => ({ entries, next_before: null }), "GET /api/me": () => sam, ...quiet };
  }

  it("pairs a start with the end that followed it", () => {
    const found = lastSession([...first, entry(40, "start_impersonation", "2026-11-05T01:00:00Z")], "u-sam");
    expect(found?.start.seq).toBe(40);
    expect(found?.end).toBeNull();
    expect(lastSession(first, "u-sam")?.end?.seq).toBe(30);
    expect(lastSession(first, "someone-else")).toBeNull();
  });

  it("shows who, when, how long and why, then stays dismissed", async () => {
    stubApi(history(first));
    const view = renderApp(<App />, "/");
    const user = userEvent.setup();

    const notice = await screen.findByText(/Olive from support viewed your account as you on/);
    expect(notice.textContent).toContain("for 12 minutes: the TB won't load. See Changes.");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/from support viewed your account/)).toBeNull();
    expect(localStorage.getItem("viewed-as-notice-dismissed")).toBe("20");

    // A fresh load stays quiet…
    view.unmount();
    cleanup();
    stubApi(history(first));
    renderApp(<App />, "/");
    await screen.findByText(/Sam Staff/);
    expect(screen.queryByText(/from support viewed your account/)).toBeNull();

    // …and a later session shows again.
    cleanup();
    stubApi(history([entry(60, "start_impersonation", "2026-11-06T01:00:00Z"), ...first]));
    renderApp(<App />, "/");
    expect(await screen.findByText(/Olive from support viewed your account as you/)).toBeTruthy();
  });

  it("is never shown to the overseer while viewing as someone", async () => {
    stubApi({ ...history(first), "GET /api/me": () => viewingAsSam(20) });
    renderApp(<App />, "/");
    await screen.findByText(/min left/);
    expect(screen.queryByText(/from support viewed your account/)).toBeNull();
  });
});
