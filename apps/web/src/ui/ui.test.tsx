// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyScheme, saveScheme, storedScheme } from "../lib/theme";
import { ConfirmDialog, DateField, Modal, useConfirm } from ".";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("Modal", () => {
  it("renders only while open, named by its title", () => {
    const { rerender } = render(
      <Modal open={false} onClose={() => {}} title="Edit asset">
        <p>Body</p>
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(
      <Modal open onClose={() => {}} title="Edit asset">
        <p>Body</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Edit asset" }).textContent).toContain("Body");
  });

  it("closes on Esc and the Close button, but not while busy", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Modal open onClose={onClose} title="Edit asset">
        <p>Body</p>
      </Modal>,
    );
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    await userEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(onClose).toHaveBeenCalledTimes(2);

    rerender(
      <Modal open onClose={onClose} title="Edit asset" dismissable={false}>
        <p>Body</p>
      </Modal>,
    );
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("button", { name: /Close/ })).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("ConfirmDialog", () => {
  it("is an alertdialog that confirms or cancels, starting on Cancel", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open title="Delete it?" confirmLabel="Delete" tone="danger" onConfirm={onConfirm} onCancel={onCancel}>
        <p>Gone for good.</p>
      </ConfirmDialog>,
    );
    const dialog = screen.getByRole("alertdialog", { name: /Delete it\?/ });
    expect(dialog.textContent).toContain("Gone for good.");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("useConfirm resolves true or false, and unmounts after", async () => {
    const answers: boolean[] = [];
    function Asker() {
      const [confirm, dialog] = useConfirm();
      const [n, setN] = useState(0);
      return (
        <>
          <button
            onClick={async () => {
              answers.push(await confirm({ title: "Sure?", children: "Really.", confirmLabel: "Yes" }));
              setN(n + 1);
            }}
          >
            Ask
          </button>
          {dialog}
        </>
      );
    }
    render(<Asker />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.click(screen.getByRole("button", { name: "Yes" }));
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(answers).toEqual([true, false]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("DateField", () => {
  function Harness({ initial = "", min, max }: { initial?: string; min?: string; max?: string }) {
    const [value, setValue] = useState(initial);
    return (
      <>
        <DateField label="Disposal date" value={value} onChange={setValue} min={min} max={max} />
        <output>{value}</output>
      </>
    );
  }

  it("reads a typed date the NZ way and tidies it on leaving the box", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByLabelText("Disposal date");
    await user.type(box, "31/3/2026");
    expect(screen.getByRole("status").textContent).toBe("2026-03-31");
    await user.tab();
    expect(box).toHaveProperty("value", "31 Mar 2026");
  });

  it("flags a date that doesn't exist or is out of range, once they've left the box", async () => {
    const user = userEvent.setup();
    render(<Harness max="2026-03-31" />);
    const box = screen.getByLabelText("Disposal date") as HTMLInputElement;
    await user.type(box, "31/4/2026");
    expect(screen.queryByText(/Enter a date like/)).toBeNull();
    await user.tab();
    expect(screen.getByText(/Enter a date like/)).toBeTruthy();
    expect(box.validationMessage).toContain("Enter a date like");
    await user.clear(box);
    await user.type(box, "1/4/2026");
    await user.tab();
    expect(screen.getByText("Choose 31 Mar 2026 or earlier")).toBeTruthy();
  });

  it("picks a day from the calendar, jumping by year and month", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-03-31" />);
    await user.click(screen.getByRole("button", { name: "Choose Disposal date from a calendar" }));
    const dialog = screen.getByRole("dialog", { name: /Disposal date/ });
    expect(dialog.textContent).toContain("Tuesday 31 March 2026");
    await user.click(screen.getByRole("button", { name: /^Year: 2026/ }));
    await user.click(screen.getByRole("button", { name: "2019" }));
    await user.click(screen.getByRole("button", { name: "June" }));
    await user.click(screen.getByRole("button", { name: "Saturday 15 June 2019" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("2019-06-15");
    expect(screen.getByLabelText("Disposal date")).toHaveProperty("value", "15 Jun 2019");
  });

  it("moves with the keyboard and won't offer days outside min and max", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2025-04-02" min="2025-04-01" max="2026-03-31" />);
    await user.click(screen.getByRole("button", { name: /from a calendar/ }));
    expect(screen.getByRole("button", { name: "Monday 31 March 2025" })).toHaveProperty("disabled", true);
    const day = screen.getByRole("button", { name: "Wednesday 2 April 2025" });
    day.focus();
    await user.keyboard("{ArrowDown}");
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Wednesday 9 April 2025"));
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status").textContent).toBe("2025-04-09");
    await user.click(screen.getByRole("button", { name: /from a calendar/ }));
    await user.click(screen.getByRole("button", { name: /^Last day/ }));
    expect(screen.getByRole("status").textContent).toBe("2026-03-31");
  });
});

describe("colour scheme", () => {
  it("pins light or dark on <html>, and system clears it", () => {
    expect(storedScheme()).toBe("system");
    saveScheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(storedScheme()).toBe("dark");
    saveScheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(storedScheme()).toBe("system");
    applyScheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to system when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(storedScheme()).toBe("system");
    vi.restoreAllMocks();
  });
});
