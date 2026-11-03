import { describe, expect, it } from "vitest";
import { lineDescription } from "./lines";

describe("lineDescription", () => {
  it("shows a placeholder for a line with no text", () => {
    expect(lineDescription("")).toBe("(no description)");
    expect(lineDescription("   ")).toBe("(no description)");
  });

  it("leaves any other description as it is", () => {
    expect(lineDescription("PIKORUA CAFE")).toBe("PIKORUA CAFE");
  });
});
