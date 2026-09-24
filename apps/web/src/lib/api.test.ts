import { describe, expect, it } from "vitest";
import { fetchHealth, fetchMe, login } from "./api";

function stubFetch(status: number, body: unknown): typeof fetch {
  return async (input) => {
    expect(input).toBe("/api/health");
    return new Response(JSON.stringify(body), { status });
  };
}

describe("fetchHealth", () => {
  it("returns the server's health", async () => {
    const health = await fetchHealth(stubFetch(200, { status: "ok", version: "0.1.0" }));
    expect(health).toEqual({ status: "ok", version: "0.1.0" });
  });

  it("rejects on a non-2xx response", async () => {
    await expect(fetchHealth(stubFetch(503, {}))).rejects.toThrow("503");
  });
});

function respond(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("fetchMe", () => {
  it("returns null without a session", async () => {
    expect(await fetchMe(respond(401, { code: "unauthenticated" }))).toBeNull();
  });

  it("returns the user with a session", async () => {
    const me = { id: "u1", username: "staff", display_name: "Sam", role: "staff" };
    expect(await fetchMe(respond(200, me))).toEqual(me);
  });
});

describe("login", () => {
  it("rejects with the server's message", async () => {
    const err = { code: "bad_credentials", message: "Wrong username or password.", details: null };
    await expect(login({ username: "x", password: "y" }, respond(401, err))).rejects.toThrow(
      "Wrong username or password.",
    );
  });
});
