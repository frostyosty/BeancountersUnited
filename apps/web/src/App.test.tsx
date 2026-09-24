// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { jsonResponse, renderApp, stubApi } from "./test/render";

const practice = { name: "P", master_charts: [], templates: [], mappings: [] };
const sam = { id: "u1", username: "sam", display_name: "Sam Staff", role: "staff" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("signs in, then signs out", async () => {
    let signedIn = false;
    stubApi({
      "GET /api/me": () => (signedIn ? sam : jsonResponse(401, { code: "unauthenticated", message: "", details: null })),
      "POST /api/login": (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ username: "sam", password: "pw" });
        signedIn = true;
        return sam;
      },
      "POST /api/logout": () => {
        signedIn = false;
        return new Response(null, { status: 204 });
      },
      "GET /api/clients": () => [],
      "GET /api/practice": () => practice,
    });
    renderApp(<App />);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "sam");
    await user.type(screen.getByLabelText("Password"), "pw");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/Sam Staff/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("Username")).toBeTruthy();
  });

  it("shows the server's message for a bad password", async () => {
    stubApi({
      "GET /api/me": () => jsonResponse(401, { code: "unauthenticated", message: "", details: null }),
      "POST /api/login": () =>
        jsonResponse(401, { code: "bad_credentials", message: "Wrong username or password.", details: null }),
    });
    renderApp(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "sam");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong username or password.");
  });

  it("shows not found for an unknown route", async () => {
    stubApi({ "GET /api/me": () => sam });
    renderApp(<App />, "/nowhere");
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy();
  });
});
