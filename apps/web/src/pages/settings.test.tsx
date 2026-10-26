// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { boss, practice, sam } from "../test/data";
import { jsonResponse, renderApp, stubApi } from "../test/render";

const users = [
  { id: "u0", username: "boss", display_name: "Bo Boss", role: "practice_admin", active: true },
  { id: "u1", username: "sam", display_name: "Sam Staff", role: "staff", active: true },
];

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

describe("practice settings", () => {
  it("manages users", async () => {
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/practice": () => practice,
      "GET /api/users": () => users,
      "GET /api/asset-classes": () => [],
      "POST /api/commands": () => ({ seq: 1, entity_id: null }),
    });
    renderApp(<App />, "/settings");
    const user = userEvent.setup();

    // A practice admin can't deactivate themselves from here.
    expect(((await screen.findByLabelText("boss active")) as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByLabelText("sam active"));
    await user.click(screen.getAllByRole("button", { name: "Reset password…" })[1]!);
    await user.type(screen.getByLabelText("New password for sam"), "a fresh password");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    await user.type(screen.getByLabelText("Username"), "vic");
    await user.type(screen.getByLabelText("Display name"), "Vic Viewer");
    await user.type(screen.getByLabelText("Password"), "another password");
    await user.selectOptions(screen.getByLabelText("Role"), "viewer");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    await vi.waitFor(() => expect(posts(calls)).toHaveLength(3));
    expect(posts(calls)).toMatchObject([
      { kind: "set_user_active", payload: { user_id: "u1", active: false } },
      { kind: "reset_password", payload: { user_id: "u1", new_password: "a fresh password" } },
      {
        kind: "create_user",
        payload: { username: "vic", display_name: "Vic Viewer", password: "another password", role: "viewer" },
      },
    ]);
  });

  it("installs a starter set for an entity type that has no defaults", async () => {
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/practice": () => practice,
      "GET /api/users": () => users,
      "GET /api/asset-classes": () => [],
      "POST /api/commands": () => ({ seq: 1, entity_id: "mc2" }),
    });
    renderApp(<App />, "/settings");
    const user = userEvent.setup();
    // The company defaults are there already, so only the sole-trader set is offered.
    await user.click(await screen.findByRole("button", { name: "Install the sole trader starter set" }));
    expect(screen.queryByRole("button", { name: "Install the company starter set" })).toBeNull();
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ kind: "install_starter_set", payload: { set: "sole_trader" } });
    // Each master chart opens its editor.
    expect(screen.getByRole("link", { name: "Company chart" }).getAttribute("href")).toBe("/settings/charts/company");
  });

  it("makes a master chart as a copy of another, then opens it", async () => {
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/practice": () => practice,
      "GET /api/users": () => users,
      "GET /api/asset-classes": () => [],
      "POST /api/commands": () => ({ seq: 1, entity_id: "mc2" }),
    });
    renderApp(<App />, "/settings");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("New chart's entity type"), " Look Through Company ");
    await user.type(screen.getByLabelText("Chart name"), "LTC");
    await user.selectOptions(screen.getByLabelText("Start from"), "company");
    await user.click(screen.getByRole("button", { name: "Make chart" }));
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({
      kind: "create_master_chart",
      payload: { entity_type: "look_through_company", name: "LTC", accounts: practice.master_charts[0]!.accounts },
    });
    // The new chart isn't in the stubbed practice, so its page says so.
    expect(await screen.findByText("There's no look through company master chart.")).toBeTruthy();
  });

  it("says there are no defaults yet", async () => {
    stubApi({
      "GET /api/me": () => boss,
      "GET /api/practice": () => ({ ...practice, master_charts: [], templates: [], mappings: [] }),
      "GET /api/users": () => users,
      "GET /api/asset-classes": () => [],
    });
    renderApp(<App />, "/settings");
    expect(await screen.findByText(/No defaults yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install the company starter set" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install the sole trader starter set" })).toBeTruthy();
  });

  it("is only for practice admins: staff land on their account", async () => {
    stubApi({ "GET /api/me": () => sam, "GET /api/clients": () => [], "GET /api/practice": () => practice });
    renderApp(<App />, "/settings");
    expect(await screen.findByRole("heading", { name: /Your account/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Practice/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Admin/ })).toBeNull();
  });

  it("lets an admin preview the site as another role", async () => {
    stubApi({ "GET /api/me": () => boss, "GET /api/clients": () => [], "GET /api/practice": () => practice, "GET /api/users": () => users, "GET /api/asset-classes": () => [] });
    renderApp(<App />, "/settings/admin");
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Viewing as"), "viewer");
    expect(await screen.findByRole("button", { name: "Stop viewing as viewer" })).toBeTruthy();
    // The admin tab stays, so they can switch back.
    expect(screen.getByRole("link", { name: /Admin/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stop viewing as viewer" }));
    expect(screen.queryByRole("button", { name: "Stop viewing as viewer" })).toBeNull();
  });
});

describe("master chart", () => {
  it("renames, deactivates and adds accounts by command, for new clients only", async () => {
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/practice": () => practice,
      "POST /api/commands": () => ({ seq: 1, entity_id: null }),
    });
    renderApp(<App />, "/settings/charts/company");
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Company chart master chart" })).toBeTruthy();
    expect(screen.getByText(/Changing it never alters a client already set up/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sales" }));
    const input = screen.getByLabelText("New name for 100");
    await user.clear(input);
    await user.type(input, "Revenue{Enter}");
    await user.click(screen.getByLabelText("820 active"));
    await user.selectOptions(screen.getByLabelText("100 default GST"), "standard");
    await user.type(screen.getByLabelText("Code"), "236");
    await user.type(screen.getByLabelText("Name"), "Cleaning");
    await user.click(screen.getByRole("button", { name: "Add account" }));

    await vi.waitFor(() => expect(posts(calls)).toHaveLength(4));
    expect(posts(calls)).toMatchObject([
      { kind: "rename_master_account", payload: { entity_type: "company", code: "100", name: "Revenue" } },
      { kind: "set_master_account_active", payload: { entity_type: "company", code: "820", active: true } },
      { kind: "set_master_account_gst", payload: { entity_type: "company", code: "100", default_gst: "standard" } },
      {
        kind: "add_master_account",
        payload: { entity_type: "company", account: { code: "236", name: "Cleaning", account_type: "expense", active: true } },
      },
    ]);
  });

  it("is only for practice admins", async () => {
    stubApi({ "GET /api/me": () => sam, "GET /api/clients": () => [], "GET /api/practice": () => practice });
    renderApp(<App />, "/settings/charts/company");
    expect(await screen.findByText("Only practice admins can change practice settings.")).toBeTruthy();
  });
});

describe("own password", () => {
  it("changes it, checking the two new passwords match", async () => {
    const calls = stubApi({ "GET /api/me": () => sam, "POST /api/commands": () => ({ seq: 1, entity_id: null }) });
    renderApp(<App />, "/account");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Current password"), "old password!");
    await user.type(screen.getByLabelText("New password"), "new password!!");
    await user.type(screen.getByLabelText("New password again"), "new password!?");
    expect(screen.getByText("The new passwords don't match.")).toBeTruthy();
    await user.clear(screen.getByLabelText("New password again"));
    await user.type(screen.getByLabelText("New password again"), "new password!!");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Password changed.")).toBeTruthy();
    expect(posts(calls)).toMatchObject([
      { kind: "change_own_password", payload: { current_password: "old password!", new_password: "new password!!" } },
    ]);
  });
});

describe("an ended session", () => {
  it("drops back to the sign-in page", async () => {
    let signedIn = true;
    stubApi({
      "GET /api/me": () => (signedIn ? sam : jsonResponse(401, { code: "unauthenticated", message: "", details: null })),
      "POST /api/commands": () => jsonResponse(401, { code: "unauthenticated", message: "Log in first.", details: null }),
    });
    renderApp(<App />, "/account");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Current password"), "x");
    await user.type(screen.getByLabelText("New password"), "y");
    await user.type(screen.getByLabelText("New password again"), "y");
    signedIn = false;
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });
  it("adds a practice asset class", async () => {
    const chart = [
      { code: "210", name: "Depreciation", account_type: "expense", active: true },
      { code: "250", name: "Loss on disposal", account_type: "expense", active: true },
      { code: "700", name: "Plant at cost", account_type: "asset", active: true },
      { code: "705", name: "Plant accumulated depreciation", account_type: "asset", active: true },
    ];
    const calls = stubApi({
      "GET /api/me": () => boss,
      "GET /api/practice": () => ({ ...practice, master_charts: [{ ...practice.master_charts[0], accounts: chart }] }),
      "GET /api/users": () => users,
      "GET /api/asset-classes": () => [],
      "POST /api/commands": () => ({ seq: 1, entity_id: "k1" }),
    });
    renderApp(<App />, "/settings");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Key"), "plant");
    await user.type(screen.getByLabelText("Class name"), "Plant and equipment");
    await user.type(screen.getByLabelText("Rate %"), "15");
    await user.selectOptions(screen.getByLabelText("Cost account"), "700");
    await user.selectOptions(screen.getByLabelText("Accumulated depreciation account"), "705");
    await user.selectOptions(screen.getByLabelText("Depreciation expense account"), "210");
    await user.selectOptions(screen.getByLabelText("Gain/loss on disposal account"), "250");
    await user.click(screen.getByRole("button", { name: "Add class" }));
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toEqual({
      id: expect.any(String),
      kind: "create_asset_class",
      payload: {
        entity_type: "company",
        key: "plant",
        name: "Plant and equipment",
        settings: {
          method: { kind: "dv", rate_bp: 1500 },
          part_year: { kind: "months_held", count_acquisition_month: true },
          disposal_year: "to_disposal_date",
        },
        accounts: { cost: "700", accumulated: "705", expense: "210", gain_loss: "250" },
      },
    });
  });
});
