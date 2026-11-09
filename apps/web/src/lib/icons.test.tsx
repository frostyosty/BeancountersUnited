// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Emoji, emojiKey, Icon, slotEntry } from "./icons";

describe("icons", () => {
  it("names an emoji by its code points, without the variation selector", () => {
    expect(emojiKey("💬")).toBe("1f4ac");
    expect(emojiKey("⚙️")).toBe("2699");
  });

  it("reads a slot from the registry", () => {
    expect(["emoji", "image"]).toContain(slotEntry("ui.empty")?.type);
    expect(slotEntry("nope.missing")).toBeUndefined();
    expect(slotEntry("malformed")).toBeUndefined();
  });

  it("hides the icon from assistive tech and falls back when a slot is missing", () => {
    const { container } = render(
      <>
        <Icon name="ui.empty" />
        <Icon name="nope.missing" fallback="🧾" />
        <Icon name="nope.missing" />
        <Emoji>💬</Emoji>
      </>,
    );
    // The studio may have swapped any slot for an image, so only count the glyphs.
    const glyphs = container.querySelectorAll("[aria-hidden='true']");
    expect(glyphs).toHaveLength(3);
    // The studio may also have swapped 🧾 or 💬 for an image, so check what is there.
    expect(container.textContent).not.toContain("nope.missing");
  });
});
