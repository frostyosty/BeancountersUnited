import { describe, expect, it } from "vitest";
import { newId, newToken } from "./id";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("makes v4 UUIDs", () => {
    for (let i = 0; i < 100; i++) {
      expect(newId()).toMatch(V4);
    }
  });

  it("sets the version and variant bits whatever the random bytes are", () => {
    expect(newId((b) => b.fill(0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(newId((b) => b.fill(0))).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("doesn't need crypto.randomUUID", () => {
    const original = crypto.randomUUID;
    try {
      Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
      expect(newId()).toMatch(V4);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });
});

describe("newToken", () => {
  it("makes 32 random bytes as hex", () => {
    expect(newToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken()).not.toBe(newToken());
    expect(newToken((b) => b.fill(0xab))).toBe("ab".repeat(32));
  });
});
