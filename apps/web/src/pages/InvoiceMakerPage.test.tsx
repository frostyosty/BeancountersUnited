// @vitest-environment jsdom
import { cleanup, configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { sam, val } from "../test/data";
import { renderApp, stubApi } from "../test/render";

// The full suite runs ~45 jsdom workers at once, so the default 1s findBy timeout is too tight here.
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const blocks = () => screen.getByTestId("invoice-page").querySelectorAll(".invoice-element").length;

const UPLOADED = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DEVICE_DRAFT =
  '<div class="invoice-element image-element style-default" style="left: 10px; top: 10px; width: 100px; height: 50px; background-image: url(&quot;data:image/png;base64,iVBORw0KGgo=&quot;);"></div>' +
  '<div class="invoice-element style-default" style="left: 10px; top: 80px;"><div contenteditable="true" class="invoice-text">Made before signing in</div></div>';

interface Sent {
  kind: string;
  payload: Record<string, string>;
}

/** The server's invoice endpoints, in memory. */
function fakeServer(me: typeof sam, draft: string | null = null) {
  const templates = new Map<string, { name: string; html: string }>();
  let next = 1;
  const calls = stubApi({
    "GET /api/me": () => me,
    "GET /api/invoices/draft": () => ({ html: draft }),
    "GET /api/invoices/templates": () => [...templates].map(([id, t]) => ({ id, name: t.name })),
    "POST /api/commands": (init) => {
      const { kind, payload } = JSON.parse(String(init?.body)) as Sent;
      if (kind === "save_invoice_draft") draft = payload.html!;
      if (kind === "save_invoice_template") {
        const found = [...templates].find(([, t]) => t.name === payload.name);
        const id = found?.[0] ?? `t${next++}`;
        templates.set(id, { name: payload.name!, html: payload.html! });
        return { seq: next, entity_id: id };
      }
      if (kind === "delete_invoice_template") templates.delete(payload.template_id!);
      if (kind === "add_invoice_image") return { seq: next++, entity_id: UPLOADED };
      return { seq: next++, entity_id: null };
    },
  });
  // GET /api/invoices/templates/{id} has an id in the path, so it's answered here.
  const stubbed = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const match = /^\/api\/invoices\/templates\/(.+)$/.exec(path);
    if (match) {
      const t = templates.get(match[1]!);
      return Promise.resolve(new Response(JSON.stringify({ id: match[1], ...t }), { status: t ? 200 : 404 }));
    }
    return stubbed(input, init);
  });
  const sent = () => calls.filter((c) => c.path === "/api/commands").map((c) => c.body as Sent);
  return { sent, draft: () => draft, templates };
}

describe("invoice maker", () => {
  it("is tucked under Settings → Tools, for any role, and starts from the sample", async () => {
    fakeServer(val);
    renderApp(<App />, "/settings/tools");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("link", { name: "Open the invoice maker" }));
    expect(await screen.findByRole("heading", { name: /Invoice maker/ })).toBeTruthy();
    expect((await screen.findByTestId("invoice-page")).textContent).toContain("TAX INVOICE");
  });

  it("opens the saved draft, cleaned, and saves changes to the account", async () => {
    const saved =
      '<div class="invoice-element style-default" style="left: 10px; top: 10px;"><div contenteditable="true" class="invoice-text">Saved before</div>' +
      '<img src="x" onerror="window.hacked = true"><script>window.hacked = true</script></div>';
    const server = fakeServer(sam, saved);
    renderApp(<App />, "/tools/invoice");
    const user = userEvent.setup();
    const page = await screen.findByTestId("invoice-page");
    expect(page.textContent).toContain("Saved before");
    expect(page.querySelector("img, script")).toBeNull();
    expect(blocks()).toBe(1);

    const toolbar = screen.getByRole("toolbar", { name: "Invoice tools" });
    await user.click(within(toolbar).getByRole("button", { name: /Text/ }));
    expect(blocks()).toBe(2);
    await vi.waitFor(() => expect(server.draft()).toContain("New text"), { timeout: 5000 });
    expect(server.draft()).not.toContain("element-controls");
    await vi.waitFor(() =>
      expect(screen.getByRole("status", { name: "Save status" }).textContent).toMatch(/Saved$/),
    );

    await user.click(within(toolbar).getByRole("button", { name: /Undo/ }));
    expect(blocks()).toBe(1);
    await vi.waitFor(() => expect(server.draft()).not.toContain("New text"), { timeout: 5000 });
  });

  it("saves, loads and deletes templates on the account, asking first", async () => {
    const server = fakeServer(sam);
    renderApp(<App />, "/tools/invoice");
    const user = userEvent.setup();
    const toolbar = await screen.findByRole("toolbar", { name: "Invoice tools" });
    await screen.findByTestId("invoice-page");
    const sample = blocks();

    await user.click(within(toolbar).getByRole("button", { name: /Text/ }));
    await user.type(screen.getByLabelText("Template name"), "Standard");
    await user.click(within(toolbar).getByRole("button", { name: /Save template/ }));
    await screen.findByText(/Saved the template "Standard"/);
    expect(server.templates.get("t1")?.html).toContain("New text");
    const picker = screen.getByLabelText("Saved templates");
    await within(picker).findByRole("option", { name: "Standard" });

    // Loading asks first, and can be undone.
    await user.click(within(toolbar).getByRole("button", { name: /Undo/ }));
    expect(blocks()).toBe(sample);
    await user.selectOptions(picker, "Standard");
    await user.click(within(toolbar).getByRole("button", { name: /Load/ }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(blocks()).toBe(sample);
    await user.click(within(toolbar).getByRole("button", { name: /Load/ }));
    await user.click(await screen.findByRole("button", { name: "Load template" }));
    await vi.waitFor(() => expect(blocks()).toBe(sample + 1));
    await user.click(within(toolbar).getByRole("button", { name: /Undo/ }));
    expect(blocks()).toBe(sample);

    // Saving under the same name asks before replacing.
    await user.type(screen.getByLabelText("Template name"), "Standard");
    await user.click(within(toolbar).getByRole("button", { name: /Save template/ }));
    await user.click(await screen.findByRole("button", { name: "Replace it" }));
    await vi.waitFor(() => expect(server.templates.get("t1")?.html).not.toContain("New text"));
    expect(server.templates.size).toBe(1);

    await user.click(within(toolbar).getByRole("button", { name: /Delete template/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete template" }));
    await vi.waitFor(() => expect(server.templates.size).toBe(0));
    expect(server.sent().map((c) => c.kind)).toContain("delete_invoice_template");
  });
});

describe("an invoice made on this device before signing in", () => {
  it("is offered, and moves into the account with its images uploaded", async () => {
    localStorage.setItem("wla.invoice.draft", DEVICE_DRAFT);
    const server = fakeServer(sam);
    renderApp(<App />, "/tools/invoice");
    const user = userEvent.setup();
    const page = await screen.findByTestId("invoice-page");
    // Nothing moves until asked.
    expect(page.textContent).toContain("TAX INVOICE");
    expect(server.draft()).toBeNull();

    await user.click(await screen.findByRole("button", { name: "Use that invoice" }));
    await vi.waitFor(() => expect(page.textContent).toContain("Made before signing in"));
    await vi.waitFor(() => expect(server.draft()).toContain("Made before signing in"), { timeout: 5000 });
    expect(server.draft()).toContain(`/api/invoices/images/${UPLOADED}`);
    expect(server.draft()).not.toContain("data:image");
    expect(localStorage.getItem("wla.invoice.draft")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use that invoice" })).toBeNull();
  });

  it("can be thrown away instead", async () => {
    localStorage.setItem("wla.invoice.draft", DEVICE_DRAFT);
    const server = fakeServer(sam);
    renderApp(<App />, "/tools/invoice");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Throw it away" }));
    expect(localStorage.getItem("wla.invoice.draft")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use that invoice" })).toBeNull();
    expect(screen.getByTestId("invoice-page").textContent).toContain("TAX INVOICE");
    expect(server.sent()).toEqual([]);
  });

  it("isn't offered when there's nothing kept", async () => {
    fakeServer(sam);
    renderApp(<App />, "/tools/invoice");
    await screen.findByTestId("invoice-page");
    expect(screen.queryByRole("button", { name: "Use that invoice" })).toBeNull();
  });
});

describe("invoice maker without an account", () => {
  /** Signed out: only /api/me is answered, so any other request (a draft, templates, a command) fails the test. */
  function signedOut() {
    return stubApi({ "GET /api/me": () => null });
  }

  it("opens for a visitor, and keeps the draft on this device instead of the server", async () => {
    const calls = signedOut();
    renderApp(<App />, "/tools/invoice");
    const user = userEvent.setup();
    const page = await screen.findByTestId("invoice-page");
    expect(page.textContent).toContain("TAX INVOICE");
    expect(screen.getByText(/Saved templates need a free account/)).toBeTruthy();
    expect(screen.queryByLabelText("Template name")).toBeNull();
    expect(screen.getByRole("status", { name: "Save status" }).textContent).toMatch(/Kept on this device$/);

    const toolbar = screen.getByRole("toolbar", { name: "Invoice tools" });
    await user.click(within(toolbar).getByRole("button", { name: /Text/ }));
    await vi.waitFor(() => expect(localStorage.getItem("wla.invoice.draft")).toContain("New text"), { timeout: 5000 });
    expect(localStorage.getItem("wla.invoice.draft")).not.toContain("element-controls");
    // Nothing went to the server but the check for who's signed in.
    expect(calls.map((c) => c.path)).toEqual(["/api/me"]);
  });

  it("opens the draft kept on this device, cleaned", async () => {
    localStorage.setItem(
      "wla.invoice.draft",
      '<div class="invoice-element style-default" style="left: 10px; top: 10px;"><div contenteditable="true" class="invoice-text">Kept here</div><script>window.hacked = true</script></div>',
    );
    signedOut();
    renderApp(<App />, "/tools/invoice");
    const page = await screen.findByTestId("invoice-page");
    expect(page.textContent).toContain("Kept here");
    expect(page.querySelector("script")).toBeNull();
  });
});
