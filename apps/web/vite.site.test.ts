import { describe, expect, it } from "vitest";
import { parseEnv, readSiteConfig } from "./vite.site";

describe("parseEnv", () => {
  it("reads KEY=value lines, ignoring comments and quotes", () => {
    expect(parseEnv('# c\nSITE_GATE = off\r\nSITE_URL="https://x.nz"\n\nbad line')).toEqual({
      SITE_GATE: "off",
      SITE_URL: "https://x.nz",
    });
  });
});

describe("readSiteConfig", () => {
  it("lets the environment switch the gate off, and trims the URL", () => {
    expect(readSiteConfig({ SITE_GATE: "OFF", SITE_URL: "https://x.nz/" })).toEqual({
      gate: false,
      url: "https://x.nz",
    });
  });
  it("keeps the gate on for anything else", () => {
    expect(readSiteConfig({ SITE_GATE: "on" }).gate).toBe(true);
    expect(readSiteConfig({ SITE_GATE: "banana" }).gate).toBe(true);
  });
});
