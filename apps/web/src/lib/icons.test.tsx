import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Emoji, emojiKey, Icon, slotEntry } from "./icons";

describe("icons", () => {
  it("names an emoji by its code points, without the variation selector", () => {
    expect(emojiKey("💬")).toBe("1f4ac");
    expect(emojiKey("⚙️")).toBe("2699");
  });

  it("reads a slot from the registry", () => {
    expect(slotEntry("nav.clients")?.type).toBe("emoji");
    expect(slotEntry("nope.missing")).toBeUndefined();
    expect(slotEntry("malformed")).toBeUndefined();
  });

  it("hides the icon from assistive tech and falls back when a slot is missing", () => {
    const { container } = render(
      <>
        <Icon name="nav.clients" />
        <Icon name="nope.missing" fallback="🧾" />
        <Icon name="nope.missing" />
        <Emoji>💬</Emoji>
      </>,
    );
    const spans = container.querySelectorAll("span[aria-hidden='true']");
    expect(spans).toHaveLength(3);
    expect(spans[1]?.textContent).toBe("🧾");
    expect(spans[2]?.textContent).toBe("💬");
  });
});
