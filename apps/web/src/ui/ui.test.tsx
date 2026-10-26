// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyScheme, saveScheme, storedScheme } from "../lib/theme";
import { ConfirmDialog, Modal, useConfirm } from ".";

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
