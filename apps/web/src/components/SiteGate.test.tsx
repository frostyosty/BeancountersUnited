// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SiteGate } from "./SiteGate";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("SiteGate", () => {
  it("reveals the site after five taps on the header", async () => {
    render(<SiteGate>secret site</SiteGate>);
    const user = userEvent.setup();
    const header = screen.getByRole("heading");
    for (let i = 0; i < 4; i++) {
      await user.click(header);
    }
    expect(screen.queryByText("secret site")).toBeNull();
    await user.click(header);
    expect(screen.getByText("secret site")).toBeTruthy();
  });

  it("stays open for the rest of the session", () => {
    sessionStorage.setItem("site-revealed", "1");
    render(<SiteGate>secret site</SiteGate>);
    expect(screen.getByText("secret site")).toBeTruthy();
  });
});
