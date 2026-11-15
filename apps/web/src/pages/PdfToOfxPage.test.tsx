// @vitest-environment jsdom
import { cleanup, configure, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { ocrTextRuns } from "../lib/pdfToOfx/ocr";
import { sam } from "../test/data";
import { renderApp, stubApi } from "../test/render";
import { page, type TestCell } from "../test/statementRuns";

configure({ asyncUtilTimeout: 5000 });

// pdf.js and Tesseract don't run in jsdom: the text a PDF or a picture would give is handed
// straight to the reader.
const runs = vi.hoisted(() => ({ current: [] as unknown[], ocr: [] as unknown[] }));
vi.mock("../lib/pdfToOfx/pdfText", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/pdfToOfx/pdfText")>();
  return {
    ...real,
    pdfTextRuns: vi.fn(async () => runs.current),
    pdfPagePictures: vi.fn(async () => [new Blob(["page 1"]), new Blob(["page 2"])]),
  };
});
vi.mock("../lib/pdfToOfx/ocr", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/pdfToOfx/ocr")>();
  return { ...real, ocrTextRuns: vi.fn(async () => runs.ocr) };
});

const HEADINGS: TestCell[] = [
  [40, "Date"],
  [110, "Transaction details"],
  [380, "Withdrawals", "right"],
  [450, "Deposits", "right"],
  [530, "Balance", "right"],
];

/** A made-up statement whose dates have no year, so the page asks for one. */
function statement(closing = "1,345.50") {
  return page(1, [
    [[40, "Example Bank"]],
    [
      [40, "Everyday account"],
      [200, "12-3456-0123456-00"],
    ],
    HEADINGS,
    [
      [40, "1 Mar"],
      [110, "Opening balance"],
      [530, "1,000.00", "right"],
    ],
    [
      [40, "3 Mar"],
      [110, "COFFEE CART"],
      [380, "4.50", "right"],
      [530, "995.50", "right"],
    ],
    [
      [40, "5 Mar"],
      [110, "SALARY ACME LTD"],
      [450, "350.00", "right"],
      [530, "1,345.50", "right"],
    ],
    [
      [40, "31 Mar"],
      [110, "Closing balance"],
      [530, closing, "right"],
    ],
  ]);
}

const pdf = (name = "march.pdf") => new File(["%PDF-1.7\n%made up\n"], name, { type: "application/pdf" });
const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, { type: "image/png" });
const INPUT = "Statement PDF, pictures or CSV";
const drop = (...files: File[]) => fireEvent.change(screen.getByLabelText(INPUT), { target: { files } });

let saved: { name: string; text: string }[] = [];

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
  saved = [];
  runs.current = statement();
  runs.ocr = [];
  vi.mocked(ocrTextRuns).mockClear();
  URL.createObjectURL = vi.fn(() => "blob:ofx");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, text: "" });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PDF to OFX", () => {
  it("is under Settings → Tools for anyone signed in", async () => {
    stubApi({ "GET /api/me": () => sam });
    renderApp(<App />, "/settings/tools");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "Open PDF to OFX" }));
    expect(await screen.findByRole("heading", { name: /PDF to OFX/ })).toBeTruthy();
    expect(screen.getByTestId("pdf-drop")).toBeTruthy();
  });

  it("reads a statement, shows it, and downloads it as OFX, with no account", async () => {
    const calls = stubApi({ "GET /api/me": () => null });
    const blobs: Blob[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((b) => {
      blobs.push(b as Blob);
      return "blob:ofx";
    });
    renderApp(<App />, "/tools/pdf-to-ofx");
    const user = userEvent.setup();
    await screen.findByLabelText(INPUT);
    drop(pdf());

    const table = await screen.findByRole("table", { name: "Transactions" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([`3 Mar ${new Date().getFullYear()}COFFEE CART4.50995.50`, `5 Mar ${new Date().getFullYear()}SALARY ACME LTD350.001,345.50`]);
    expect(screen.getByText(/It adds up/)).toBeTruthy();
    // The statement never says the year, so it's asked for.
    expect(screen.getByRole("alert").textContent).toContain("doesn't say which year");
    const year = screen.getByLabelText("Year of the dates");
    await user.clear(year);
    await user.type(year, "2025");
    expect(within(table).getAllByRole("row")[1]!.textContent).toContain("3 Mar 2025");

    expect((screen.getByLabelText("Account number") as HTMLInputElement).value).toBe("12-3456-0123456-00");
    await user.click(screen.getByRole("button", { name: /Download OFX/ }));
    expect(saved.map((s) => s.name)).toEqual(["statement-12-3456-0123456-00-2025-03-05.ofx"]);
    const text = await blobs[0]!.text();
    expect(text).toContain("<ACCTTYPE>CHECKING</ACCTTYPE>");
    expect(text).toContain("<DTPOSTED>20250303</DTPOSTED>");
    expect(text).toContain("<TRNAMT>-4.50</TRNAMT>");
    expect(text).toContain("<TRNAMT>350.00</TRNAMT>");
    expect(text).toContain("<BALAMT>1345.50</BALAMT>");
    expect(await screen.findByText(/Saved statement-12-3456/)).toBeTruthy();
    // Nothing about the statement went to the server.
    expect(calls.filter((c) => c.path !== "/api/me")).toEqual([]);
  });

  it("swaps money in and out, and needs an account number to download", async () => {
    stubApi({ "GET /api/me": () => null });
    renderApp(<App />, "/tools/pdf-to-ofx");
    const user = userEvent.setup();
    await screen.findByLabelText(INPUT);
    drop(pdf());
    const table = await screen.findByRole("table", { name: "Transactions" });

    await user.click(screen.getByRole("button", { name: /Swap money in and out/ }));
    expect(within(table).getAllByRole("row")[1]!.textContent).toContain("COFFEE CART4.50-995.50");

    await user.clear(screen.getByLabelText("Account number"));
    expect((screen.getByRole("button", { name: /Download OFX/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns when the lines don't add up to the closing balance", async () => {
    runs.current = statement("1,400.00");
    stubApi({ "GET /api/me": () => null });
    renderApp(<App />, "/tools/pdf-to-ofx");
    await screen.findByLabelText(INPUT);
    drop(pdf());
    expect((await screen.findByText(/A line may be missing or misread/)).textContent).toContain("comes to 1,345.50, but the closing balance is 1,400.00");
  });

  it("explains files it can't use", async () => {
    stubApi({ "GET /api/me": () => null });
    renderApp(<App />, "/tools/pdf-to-ofx");
    await screen.findByLabelText(INPUT);

    drop(new File(["OFXHEADER:100"], "march.ofx"));
    expect((await screen.findByRole("alert")).textContent).toContain("already a bank file");

    drop(new File(["just some notes"], "notes.txt"));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("isn't a PDF, a picture or a CSV"));

    drop(pdf(), png("page 1.png"));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("one PDF or CSV at a time"));

    // A scan where text recognition finds nothing.
    runs.current = [];
    drop(pdf("scan.pdf"));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("couldn't make out any words in this scan"));
    // The drop zone stays, for the next try.
    expect(screen.getByTestId("pdf-drop")).toBeTruthy();
  });

  it("reads a scanned PDF's pages with text recognition", async () => {
    runs.current = [];
    runs.ocr = statement();
    stubApi({ "GET /api/me": () => null });
    renderApp(<App />, "/tools/pdf-to-ofx");
    await screen.findByLabelText(INPUT);
    drop(pdf("scan.pdf"));

    const table = await screen.findByRole("table", { name: "Transactions" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    // Both drawn pages went to the text reader, and the page says to check what it read.
    expect(vi.mocked(ocrTextRuns).mock.calls[0]![0]).toHaveLength(2);
    expect(screen.getByText(/We read this from a scan with text recognition/)).toBeTruthy();
    expect(screen.getByText("A scanned PDF, with text recognition")).toBeTruthy();
  });

  it("reads a PDF the way Read as says, and tries a file that failed again when it's changed", async () => {
    runs.current = [];
    runs.ocr = statement();
    stubApi({ "GET /api/me": () => null });
    renderApp(<App />, "/tools/pdf-to-ofx");
    const user = userEvent.setup();
    await screen.findByLabelText(INPUT);

    // Only the PDF's text: a scan has none, so it says how to read it instead.
    await user.selectOptions(screen.getByLabelText("Read as"), "text");
    drop(pdf("scan.pdf"));
    expect((await screen.findByRole("alert")).textContent).toContain("Choose “A scan or pictures (text recognition)”");
    expect(ocrTextRuns).not.toHaveBeenCalled();

    // Choosing text recognition reads the same file again, without dropping it in again.
    await user.selectOptions(screen.getByLabelText("Read as"), "ocr");
    await screen.findByRole("table", { name: "Transactions" });
    expect(ocrTextRuns).toHaveBeenCalledTimes(1);
  });

  it("reads a PDF with text recognition when asked to, even if it has text", async () => {
    runs.ocr = statement();
    stubApi({ "GET /api/me": () => null });
    renderApp(<App />, "/tools/pdf-to-ofx");
    const user = userEvent.setup();
    await screen.findByLabelText(INPUT);
    await user.selectOptions(screen.getByLabelText("Read as"), "ocr");
    drop(pdf());
    await screen.findByRole("table", { name: "Transactions" });
    expect(ocrTextRuns).toHaveBeenCalledTimes(1);
  });

  it("reads a bank's CSV, and downloads it as OFX", async () => {
    stubApi({ "GET /api/me": () => null });
    const blobs: Blob[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((b) => {
      blobs.push(b as Blob);
      return "blob:file";
    });
    renderApp(<App />, "/tools/pdf-to-ofx");
    const user = userEvent.setup();
    await screen.findByLabelText(INPUT);
    const csv = "Account,12-3456-0123456-00\nDate,Details,Amount,Balance\n03/03/2026,COFFEE CART,-4.50,995.50\n05/03/2026,SALARY ACME LTD,350.00,\"1,345.50\"\n";
    drop(new File([csv], "export.csv", { type: "text/csv" }));

    const table = await screen.findByRole("table", { name: "Transactions" });
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual([
      "3 Mar 2026COFFEE CART4.50995.50",
      "5 Mar 2026SALARY ACME LTD350.001,345.50",
    ]);
    expect(screen.getByText("A CSV")).toBeTruthy();
    expect(screen.getByText(/It adds up/)).toBeTruthy();
    expect(screen.queryByText(/text recognition, which can misread/)).toBeNull();
    expect(ocrTextRuns).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Download OFX/ }));
    expect(saved.map((s) => s.name)).toEqual(["statement-12-3456-0123456-00-2026-03-05.ofx"]);
    expect(await blobs[0]!.text()).toContain("<TRNAMT>-4.50</TRNAMT>");
  });

  it("says when a CSV is dropped in with Read as set to a PDF way, and when a PDF is read as a CSV", async () => {
    stubApi({ "GET /api/me": () => null });
    renderApp(<App />, "/tools/pdf-to-ofx");
    const user = userEvent.setup();
    await screen.findByLabelText(INPUT);
    await user.selectOptions(screen.getByLabelText("Read as"), "text");
    drop(new File(["Date,Amount\n"], "export.csv"));
    expect((await screen.findByRole("alert")).textContent).toContain("Choose “A CSV from the bank”");

    await user.selectOptions(screen.getByLabelText("Read as"), "csv");
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no lines with a date and an amount"));
    drop(pdf());
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("This is a PDF, not a CSV"));
  });

  it("reads photos or screenshots of the pages, in page order", async () => {
    runs.ocr = statement();
    stubApi({ "GET /api/me": () => null });
    renderApp(<App />, "/tools/pdf-to-ofx");
    await screen.findByLabelText(INPUT);
    drop(png("page 10.png"), png("page 2.png"));

    await screen.findByRole("table", { name: "Transactions" });
    const pictures = vi.mocked(ocrTextRuns).mock.calls[0]![0] as File[];
    expect(pictures.map((p) => p.name)).toEqual(["page 2.png", "page 10.png"]);
    expect(screen.getByText("2 pictures")).toBeTruthy();
    expect(screen.getByText(/We read this from pictures/)).toBeTruthy();
  });

  it("downloads QIF or CSV instead when chosen", async () => {
    stubApi({ "GET /api/me": () => null });
    const blobs: Blob[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((b) => {
      blobs.push(b as Blob);
      return "blob:file";
    });
    renderApp(<App />, "/tools/pdf-to-ofx");
    const user = userEvent.setup();
    await screen.findByLabelText(INPUT);
    drop(pdf());
    await screen.findByRole("table", { name: "Transactions" });
    const year = new Date().getFullYear();

    await user.selectOptions(screen.getByLabelText("File type"), "qif");
    await user.click(screen.getByRole("button", { name: /Download QIF/ }));
    await user.selectOptions(screen.getByLabelText("File type"), "csv");
    await user.click(screen.getByRole("button", { name: /Download CSV/ }));

    expect(saved.map((s) => s.name)).toEqual([
      `statement-12-3456-0123456-00-${year}-03-05.qif`,
      `statement-12-3456-0123456-00-${year}-03-05.csv`,
    ]);
    expect(blobs.map((b) => b.type)).toEqual(["application/qif", "text/csv"]);
    expect(await blobs[0]!.text()).toContain(`D03/03/${year}\r\nT-4.50\r\nPCOFFEE CART`);
    expect((await blobs[1]!.text()).split("\r\n")[1]).toBe(`03/03/${year},COFFEE CART,-4.50,995.50`);
    expect(screen.getByText(/Open it in a spreadsheet/)).toBeTruthy();

    // A CSV can have Xero's columns instead.
    await user.selectOptions(screen.getByLabelText("CSV columns"), "xero");
    await user.click(screen.getByRole("button", { name: /Download CSV/ }));
    expect((await blobs[2]!.text()).split("\r\n").slice(0, 2)).toEqual([
      "Date,Amount,Payee,Description,Reference,Check Number",
      `03/03/${year},-4.50,COFFEE CART,,,`,
    ]);
    await user.selectOptions(screen.getByLabelText("File type"), "ofx");
    expect(screen.queryByLabelText("CSV columns")).toBeNull();
  });
});
