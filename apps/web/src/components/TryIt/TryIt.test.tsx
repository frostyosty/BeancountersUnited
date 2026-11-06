// @vitest-environment jsdom
import type { ExampleStatement } from "@acct/types/ExampleStatement";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dragHasPayload, EXAMPLE_DRAG_TYPE } from "./dnd";
import { ExampleLinks, ExamplesPanel } from "./ExamplesPanel";
import { UploadResult } from "./StepState";
import { UploadDrop } from "./UploadDrop";
import { useIsDesktop } from "./useExamples";
import type { TryItState } from "./useTryIt";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function example(n: number, business: string): ExampleStatement {
  return {
    number: n,
    title: `Example ${n}`,
    business,
    what: "a coffee cart",
    bank: "Test Bank",
    file_name: `example-${n}.ofx`,
    account_number: "01-0001-0000001-00",
    start_date: "2026-04-01",
    period_start: "2026-04-01",
    period_end: "2026-04-30",
    opening_balance: 100_000,
    closing_balance: 100_000 + 5_000 - 1_250,
    lines: [
      { date: "2026-04-02", description: "Card sales", amount: 5_000 },
      { date: "2026-04-03", description: "Milk supplier", amount: -1_250 },
    ],
    raw: "OFXHEADER:100\nDATA:OFXSML",
    conservative_tax: 0,
  } as ExampleStatement;
}

const examples = [example(1, "Tūī Street Coffee"), example(2, "Kōwhai Design"), example(3, "Sparky Electrical")];

function media(matchesNarrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matchesNarrow && query.includes("max-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

function Probe() {
  return <span>{useIsDesktop() ? "desktop" : "phone"}</span>;
}

function dataTransfer(init: { types: string[]; data?: Record<string, string>; files?: File[] }) {
  return {
    types: init.types,
    files: init.files ?? [],
    getData: (t: string) => init.data?.[t] ?? "",
    setData: vi.fn(),
    effectAllowed: "",
  };
}

describe("layout by width", () => {
  it("is desktop above the breakpoint and phone at or below it", () => {
    media(false);
    const { unmount } = render(<Probe />);
    expect(screen.getByText("desktop")).toBeTruthy();
    unmount();
    media(true);
    render(<Probe />);
    expect(screen.getByText("phone")).toBeTruthy();
  });
});

describe("ExamplesPanel (desktop)", () => {
  it("shows three cards, without any example label or use button", () => {
    render(<ExamplesPanel examples={examples} />);
    expect(screen.getByText("Drag and drop an example OFX")).toBeTruthy();
    for (const n of [1, 2, 3]) {
      const card = screen.getByTestId(`example-card-${n}`);
      expect(within(card).queryByText(/· example/)).toBeNull();
      expect(within(card).queryByText(/Use this example/)).toBeNull();
    }
    expect(screen.getAllByText("Card sales")).toHaveLength(3);
  });

  it("opens the full-screen preview and closes it with Escape", async () => {
    render(<ExamplesPanel examples={examples} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Open Example 2/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Money in")).toBeTruthy();
    // Opening balance 1,000.00 plus 50.00 less 12.50, as a running balance.
    expect(within(dialog).getByText("1,050.00")).toBeTruthy();
    // The last running balance is also the closing balance.
    expect(within(dialog).getAllByText("1,037.50")).toHaveLength(2);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the preview with the Close button", async () => {
    render(<ExamplesPanel examples={examples} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Open Example 1/ }));
    await user.click(screen.getByRole("button", { name: /Close/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the raw file on its tab", async () => {
    render(<ExamplesPanel examples={examples} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Open Example 1/ }));
    await user.click(screen.getByRole("tab", { name: /Raw file/ }));
    expect(screen.getByRole("tabpanel", { name: "Raw file" }).textContent).toContain("OFXHEADER:100");
  });

  it("a card carries its number when dragged", () => {
    render(<ExamplesPanel examples={examples} />);
    const dt = dataTransfer({ types: [] });
    fireEvent.dragStart(screen.getByTestId("example-card-2"), { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith(EXAMPLE_DRAG_TYPE, "2");
  });
});

describe("ExampleLinks (phone)", () => {
  it("shows three links that open the preview", async () => {
    render(<ExampleLinks examples={examples} />);
    expect(screen.queryByText("Drag and drop an example OFX")).toBeNull();
    for (const n of [1, 2, 3]) expect(screen.getByRole("button", { name: `Example ${n}` })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Example 3" }));
    expect(within(screen.getByRole("dialog")).getAllByText(/Sparky Electrical/).length).toBeGreaterThan(0);
  });
});

describe("UploadDrop", () => {
  it("highlights while something is dragged over, and stops when it leaves", () => {
    render(<UploadDrop onExample={() => {}} onFile={() => {}} />);
    const zone = screen.getByTestId("upload-drop");
    expect(zone.getAttribute("data-over")).toBeNull();
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer({ types: ["Files"] }) });
    expect(zone.getAttribute("data-over")).toBe("true");
    fireEvent.dragLeave(zone, { relatedTarget: null });
    expect(zone.getAttribute("data-over")).toBeNull();
  });

  it("ignores drags that carry neither a file nor an example", () => {
    expect(dragHasPayload(dataTransfer({ types: ["text/uri-list"] }))).toBe(false);
    render(<UploadDrop onExample={() => {}} onFile={() => {}} />);
    const zone = screen.getByTestId("upload-drop");
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer({ types: ["text/uri-list"] }) });
    expect(zone.getAttribute("data-over")).toBeNull();
  });

  it("accepts a dropped card", () => {
    const onExample = vi.fn();
    const onFile = vi.fn();
    render(<UploadDrop onExample={onExample} onFile={onFile} />);
    const zone = screen.getByTestId("upload-drop");
    fireEvent.drop(zone, {
      dataTransfer: dataTransfer({ types: [EXAMPLE_DRAG_TYPE], data: { [EXAMPLE_DRAG_TYPE]: "2" } }),
    });
    expect(onExample).toHaveBeenCalledWith(2);
    expect(onFile).not.toHaveBeenCalled();
    expect(zone.getAttribute("data-over")).toBeNull();
  });

  it("accepts a dropped file", () => {
    const onFile = vi.fn();
    render(<UploadDrop onExample={() => {}} onFile={onFile} />);
    const file = new File(["x"], "mine.ofx");
    fireEvent.drop(screen.getByTestId("upload-drop"), { dataTransfer: dataTransfer({ types: ["Files"], files: [file] }) });
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("accepts a chosen file", async () => {
    const onFile = vi.fn();
    render(<UploadDrop onExample={() => {}} onFile={onFile} />);
    const file = new File(["x"], "chosen.ofx");
    await userEvent.setup().upload(screen.getByLabelText("Bank statement file"), file);
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("shows no privacy line, only the staging warning", () => {
    const { unmount } = render(<UploadDrop onExample={() => {}} onFile={() => {}} />);
    expect(screen.queryByText(/Nobody looks at it/)).toBeNull();
    unmount();
    render(<UploadDrop onExample={() => {}} onFile={() => {}} stagingWarning />);
    expect(screen.getByText(/Don't upload a real statement/)).toBeTruthy();
  });
});

describe("UploadResult", () => {
  it("shows the file, bank, period and line count", () => {
    const state: TryItState = {
      phase: "working",
      upload: { fileName: "a.ofx", bank: "Test Bank", periodStart: "2026-04-01", periodEnd: "2026-04-30", lineCount: 27 },
    };
    render(<UploadResult state={state} />);
    const text = screen.getByRole("status").textContent;
    expect(text).toContain("a.ofx");
    expect(text).toContain("Test Bank");
    expect(text).toContain("1 Apr 2026 to 30 Apr 2026");
    expect(text).toContain("27 transactions");
  });

  it("shows an error", () => {
    render(<UploadResult state={{ phase: "error", message: "That isn't a statement." }} />);
    expect(screen.getByRole("alert").textContent).toBe("That isn't a statement.");
  });

  it("shows nothing when idle", () => {
    const { container } = render(<UploadResult state={{ phase: "idle" }} />);
    expect(container.textContent).toBe("");
  });
});
