// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Walkthrough } from "./Walkthrough";

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce"), media: query }));
}

describe("Walkthrough", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("plays by itself and can be paused", async () => {
    stubReducedMotion(false);
    const { container } = render(<Walkthrough />);
    expect(container.querySelector("figure")?.dataset.mode).toBe("playing");
    await userEvent.click(screen.getByRole("button", { name: /Pause/ }));
    expect(container.querySelector("figure")?.dataset.mode).toBe("paused");
    await userEvent.click(screen.getByRole("button", { name: /Play/ }));
    expect(container.querySelector("figure")?.dataset.mode).toBe("playing");
  });

  it("holds still for reduced motion until the viewer presses Play", async () => {
    stubReducedMotion(true);
    const { container } = render(<Walkthrough />);
    expect(container.querySelector("figure")?.dataset.mode).toBe("still");
    await userEvent.click(screen.getByRole("button", { name: /Play/ }));
    expect(container.querySelector("figure")?.dataset.mode).toBe("playing");
  });
});
