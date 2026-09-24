import { describe, expect, it } from "vitest";
import { ApiRequestError, fetchHealth, fetchMe, getJson, login, submitCommand } from "./api";

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

describe("submitCommand", () => {
  it("sends the envelope and returns the acceptance", async () => {
    let sent: unknown;
    const fetchFn: typeof fetch = async (input, init) => {
      expect(input).toBe("/api/commands");
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ seq: 7, entity_id: "e1" }), { status: 200 });
    };
    const accepted = await submitCommand(
      { kind: "reverse_journal", payload: { journal_id: "j1" } },
      "id-1",
      fetchFn,
    );
    expect(accepted).toEqual({ seq: 7, entity_id: "e1" });
    expect(sent).toEqual({ id: "id-1", kind: "reverse_journal", payload: { journal_id: "j1" } });
  });

  it("rejects with the structured error", async () => {
    const err = { code: "journal_invalid", message: "The journal doesn't balance.", details: [{ x: 1 }] };
    const p = submitCommand({ kind: "reverse_journal", payload: { journal_id: "j1" } }, "id-2", respond(422, err));
    await expect(p).rejects.toBeInstanceOf(ApiRequestError);
    await expect(p).rejects.toMatchObject({ status: 422, code: "journal_invalid", details: [{ x: 1 }] });
  });

  it("copes with a body that isn't JSON", async () => {
    const fetchFn: typeof fetch = async () => new Response("bad gateway", { status: 502 });
    await expect(getJson("/api/clients", fetchFn)).rejects.toMatchObject({ status: 502, code: "http_error" });
  });
});
