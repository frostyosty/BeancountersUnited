import { describe, expect, it } from "vitest";
import { bytesToBase64, fileToBase64 } from "./files";

describe("bytesToBase64", () => {
  it("encodes with padding", () => {
    const enc = new TextEncoder();
    expect(bytesToBase64(enc.encode("hello"))).toBe("aGVsbG8=");
    expect(bytesToBase64(enc.encode("hi"))).toBe("aGk=");
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("keeps bytes that aren't UTF-8", () => {
    // Windows-1252 "café" as some bank exports write it.
    expect(bytesToBase64(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe("Y2Fm6Q==");
  });

  it("reads a file", async () => {
    expect(await fileToBase64(new Blob(["hello"]))).toBe("aGVsbG8=");
  });
});
