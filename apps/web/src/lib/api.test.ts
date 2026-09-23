import { describe, expect, it } from "vitest";
import { fetchHealth } from "./api";

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
