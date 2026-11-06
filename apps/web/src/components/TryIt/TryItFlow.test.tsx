// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import type { ExampleStatement } from "@acct/types/ExampleStatement";
import type { SaveTaxCard } from "@acct/types/SaveTaxCard";
import type { SaveTaxQueue } from "@acct/types/SaveTaxQueue";
import type { TaxPosition } from "@acct/types/TaxPosition";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../../lib/queryClient";
import { HomePage } from "../../pages/HomePage";
import { jsonResponse, renderApp, stubApi } from "../../test/render";
import { UploadResult } from "./StepState";
import { LaterStep, RetryButton } from "./TryItSteps";
import { UploadDrop } from "./UploadDrop";
import { useExamples } from "./useExamples";
import { useTryIt } from "./useTryIt";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
});

const example = (n: number, tax: number): ExampleStatement =>
  ({
    number: n,
    title: `Example ${n}`,
    business: ["Tūī Street Coffee", "Kōwhai Design", "Sparky Electrical"][n - 1],
    what: "a business",
    bank: "Test Bank",
    file_name: `example-${n}.ofx`,
    account_number: "01-0001-0000001-00",
    start_date: "2026-04-01",
    gst_source: n === 2 ? "assumed" : "detected",
    period_start: "2026-04-01",
    period_end: "2026-04-30",
    opening_balance: 0,
    closing_balance: 3_750,
    lines: [
      { date: "2026-04-02", description: "Card sales", amount: 5_000 },
      { date: "2026-04-03", description: "Milk supplier", amount: -1_250 },
    ],
    raw: "OFXHEADER:100",
    conservative_tax: tax,
  }) as ExampleStatement;

const examples = [example(1, 911_151), example(2, 450_000), example(3, 120_000)];

const business: BusinessView = {
  client_id: "b1",
  name: "Your business",
  start_date: "2025-04-01",
  gst_registered_from: "2025-04-01",
  gst_frequency: "two_monthly_odd",
  gst_source: "detected",
  gst_evidence: { bank_account_id: "a1", date: "2025-10-22", amount: -123_400, description: "INLAND REVENUE GST AUG-SEP" },
  gst_contradicted_by: null,
  example: null,
  bank_accounts: [
    {
      id: "a1",
      code: "600.01",
      name: "Test cheque",
      account_number: null,
      opening_date: null,
      opening_balance: null,
      needs_opening_balance: false,
      statements: [
        {
          id: "s1",
          file_name: "mine.ofx",
          parser: "ofx",
          start: "2025-10-01",
          end: "2025-10-31",
          opening_balance: 0,
          closing_balance: 100,
          lines_in_file: 27,
          lines_added: 27,
        },
      ],
      gaps: [],
      reconciliation: null,
    },
  ],
  transfers: [],
  ird_payments: [],
  possible_duplicates: [],
};

const onlyIncome: SaveTaxCard = {
  id: "question:only_income:2026",
  kind: "question",
  question: "only_income",
  income_year: 2026,
  lines: [],
  suggestion: null,
  gap: null,
  saving: 200_000,
  best_case: true,
};

const guestMe = {
  id: "g1",
  username: "",
  display_name: "You",
  role: "business_owner",
  guest: { expires_at: "2026-11-13T00:00:00Z", business_id: "b1", example: null },
};

/** A server with one business whose figure drops when the only-income question is answered. */
function server(overrides: Record<string, () => unknown> = {}) {
  let answered = false;
  let example: number | null = null;
  const tax = (): TaxPosition => ({ total: answered ? 700_000 : 900_000, gst: [], income: [], notices: [] });
  const queue = (): SaveTaxQueue => ({
    total: answered ? 700_000 : 900_000,
    conservative_total: 900_000,
    saved_so_far: answered ? 200_000 : 0,
    cards: answered ? [] : [onlyIncome, ...[2, 3, 4, 5].map((i) => ({ ...onlyIncome, id: `question:other:${i}`, question: "student_loan" as const }))],
  });
  const calls = stubApi({
    "GET /api/examples": () => examples,
    "POST /api/guest": (init?: RequestInit) => {
      example = (JSON.parse(String(init?.body)) as { source: { example?: number } }).source.example ?? null;
      return { me: guestMe, business_id: "b1", accepted: { seq: 1, entity_id: "b1" } };
    },
    "GET /api/businesses/b1": () => (example ? { ...business, gst_source: "assumed", gst_evidence: null, example } : business),
    "GET /api/businesses/b1/tax": tax,
    "GET /api/businesses/b1/save-tax": queue,
    "POST /api/commands": () => {
      answered = true;
      return { seq: 2, entity_id: null };
    },
    ...overrides,
  });
  return calls;
}

function Flow({ minWorkMs }: { minWorkMs?: number }) {
  const list = useExamples();
  const tryIt = useTryIt(list, { minWorkMs });
  return (
    <>
      <button type="button" onClick={() => tryIt.useExample(2)}>
        load two
      </button>
      <UploadDrop onExample={tryIt.useExample} onFile={tryIt.useFile} />
      <UploadResult state={tryIt.state} />
      <RetryButton tryIt={tryIt} />
      <LaterStep index={1} tryIt={tryIt} />
      <LaterStep index={2} tryIt={tryIt} />
      <LaterStep index={3} tryIt={tryIt} />
    </>
  );
}

const drop = (name = "mine.ofx") => fireEvent.change(screen.getByLabelText("Bank statement file"), { target: { files: [new File(["OFXHEADER:100"], name)] } });

function reducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

describe("a file dropped on the home page", () => {
  it("starts a guest with the file, shows the loader, then the server's figure", async () => {
    const calls = server();
    renderApp(<Flow minWorkMs={50} />);
    await screen.findByText(/Drag a statement here/);
    drop();

    // The loader first, with the steps.
    expect(await screen.findByText(/Working out GST/)).toBeTruthy();
    expect((await screen.findByTestId("try-tax")).textContent).toBe("$9,000.00");

    const body = calls.find((c) => c.path === "/api/guest")!.body as { id: string; source: { file: { file_name: string; content_base64: string } } };
    expect(body.source.file.file_name).toBe("mine.ofx");
    expect(atob(body.source.file.content_base64)).toBe("OFXHEADER:100");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

    // The Upload step shows what the server read.
    expect(screen.getByText("mine.ofx")).toBeTruthy();
    expect(screen.getByText(/Test cheque/)).toBeTruthy();
    expect(screen.getByText(/27 transactions/)).toBeTruthy();
    // The conservative line, and the GST note with the line that proved it.
    expect(screen.getByText("Counts every deposit as income and claims nothing.")).toBeTruthy();
    expect(screen.getByText(/We spotted a GST payment to IRD on 22 Oct 2025, so we've treated you as GST\s+registered · two-monthly/)).toBeTruthy();
  });

  it("shows the top three cards of the queue, and See all for the rest", async () => {
    server();
    renderApp(<Flow minWorkMs={0} />);
    drop();
    await screen.findByTestId("try-tax");
    expect(screen.getAllByLabelText("Save tax card")).toHaveLength(3);
    const seeAll = screen.getByRole("link", { name: /See all \(2 more\)/ });
    expect(seeAll.getAttribute("href")).toBe("/businesses/b1/save-tax");
  });

  it("an answer sends the real command, then the figure, 'saved so far' and the queue update", async () => {
    const calls = server();
    renderApp(<Flow minWorkMs={0} />);
    drop();
    await screen.findByTestId("try-tax");
    expect(screen.queryByText(/Saved so far/)).toBeNull();

    await userEvent.setup().click(within(screen.getAllByLabelText("Save tax card")[0]!).getByRole("button", { name: "Yes, it's my only income" }));

    await waitFor(() => expect(screen.getByTestId("try-tax").textContent).toBe("$7,000.00"));
    expect(screen.getByText(/Saved so far \$2,000.00/)).toBeTruthy();
    const command = calls.find((c) => c.path === "/api/commands")!.body as { kind: string; payload: { client_id: string; answer: unknown } };
    expect(command.kind).toBe("answer_question");
    expect(command.payload.client_id).toBe("b1");
    expect(command.payload.answer).toEqual({ question: "only_income", yes: true });
    // The queue moved on: the answered card is gone.
    await waitFor(() => expect(screen.getByText(/nothing left here/)).toBeTruthy());
  });

  it("See all and Review your return open the right screens", async () => {
    server();
    const owner = (label: string) => <p>{label}</p>;
    renderApp(
      <Routes>
        <Route path="/" element={<Flow minWorkMs={0} />} />
        <Route path="/businesses/:id" element={owner("owner screen")} />
        <Route path="/businesses/:id/save-tax" element={owner("save tax screen")} />
      </Routes>,
    );
    drop();
    const review = await screen.findByRole("link", { name: /Review your return/ });
    expect(review.getAttribute("href")).toBe("/businesses/b1");
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: /See all/ }));
    expect(await screen.findByText("save tax screen")).toBeTruthy();
  });

  it("Review your return goes to the owner screen", async () => {
    server();
    renderApp(
      <Routes>
        <Route path="/" element={<Flow minWorkMs={0} />} />
        <Route path="/businesses/:id" element={<p>owner screen</p>} />
      </Routes>,
    );
    drop();
    await userEvent.setup().click(await screen.findByRole("link", { name: /Review your return/ }));
    expect(await screen.findByText("owner screen")).toBeTruthy();
  });
});

describe("an example", () => {
  it("is sent by number, never as bytes, and says it can't be filed", async () => {
    const calls = server();
    renderApp(<Flow minWorkMs={0} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "load two" }));
    await screen.findByTestId("try-tax");
    expect(calls.find((c) => c.path === "/api/guest")!.body).toMatchObject({ source: { example: 2 } });
    expect(screen.getByText(/This is an example, so it can't be filed/)).toBeTruthy();
    // Example 2's GST registration is only assumed.
    expect(screen.getByText(/Assumed GST registered · two-monthly/)).toBeTruthy();
  });
});

describe("the loader's minimum time", () => {
  it("lasts about two seconds from the drop even when the server is instant", async () => {
    server();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    renderApp(<Flow />);
    await act(() => vi.advanceTimersByTimeAsync(10));
    drop();

    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.getByText(/Working out GST/)).toBeTruthy();
    expect(screen.queryByTestId("try-tax")).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(screen.getByTestId("try-tax").textContent).toBe("$9,000.00");
  });

  it("with reduced motion, has no animation and a short wait", async () => {
    reducedMotion(true);
    server();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    renderApp(<Flow />);
    await act(() => vi.advanceTimersByTimeAsync(10));
    drop();

    await act(() => vi.advanceTimersByTimeAsync(100));
    // The steps are plain text: nothing is marked as the animated, active one.
    expect(screen.getByText(/Working out GST/)).toBeTruthy();
    expect(document.querySelector("[data-active]")).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(screen.getByTestId("try-tax").textContent).toBe("$9,000.00");
  });

  it("animates the steps one after another when motion is fine", async () => {
    reducedMotion(false);
    server();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    renderApp(<Flow />);
    await act(() => vi.advanceTimersByTimeAsync(10));
    drop();
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(document.querySelector("[data-active]")?.textContent).toMatch(/Reading/);
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(document.querySelector("[data-active]")?.textContent).toMatch(/Working out GST/);
  });
});

describe("errors", () => {
  it("shows the parser's own message for a bad file, then retries", async () => {
    let attempts = 0;
    const calls = server({
      "POST /api/guest": () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(422, { code: "bad_statement", message: "That file isn't a bank statement we can read.", details: null })
          : { me: guestMe, business_id: "b1", accepted: { seq: 1, entity_id: "b1" } };
      },
    });
    renderApp(<Flow minWorkMs={0} />);
    drop("notes.txt");
    expect((await screen.findByRole("alert")).textContent).toBe("That file isn't a bank statement we can read.");
    expect(screen.queryByTestId("try-tax")).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByTestId("try-tax")).textContent).toBe("$9,000.00");
    expect(calls.filter((c) => c.path === "/api/guest")).toHaveLength(2);
  });

  it("shows the server's wording when a guest is refused", async () => {
    server({
      "POST /api/guest": () =>
        jsonResponse(429, {
          code: "limited",
          message: "Lots of people on your network have tried this in the last hour. Try again in about 20 minutes, or sign up to carry on.",
          details: null,
        }),
    });
    renderApp(<Flow minWorkMs={0} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "load two" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Lots of people on your network/);
  });

  it("keeps the command id when the reply was lost, so a retry can't start a second guest", async () => {
    let attempts = 0;
    const calls = server({
      "POST /api/guest": () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("network down");
        return { me: guestMe, business_id: "b1", accepted: { seq: 1, entity_id: "b1" } };
      },
    });
    renderApp(<Flow minWorkMs={0} />);
    drop();
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't reach the server/);
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("try-tax");
    const ids = calls.filter((c) => c.path === "/api/guest").map((c) => (c.body as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe("the hero ticket", () => {
  it("shows Example 1's figure from the server, and loads that example when clicked", async () => {
    const calls = server();
    renderApp(<HomePage />);
    await waitFor(() => expect(screen.getByTestId("hero-amount").textContent).toBe("$9,111.51"));

    await userEvent.setup().click(screen.getByRole("button", { name: /Example: tax if you filed today/ }));
    // The page's own loader runs its full two seconds.
    await screen.findByTestId("try-tax", {}, { timeout: 4_000 });
    expect(calls.find((c) => c.path === "/api/guest")!.body).toMatchObject({ source: { example: 1 } });
  });
});

describe("a guest coming back to the home page", () => {
  it("picks up their trial where they left it, with no loader and nothing sent", async () => {
    const calls = server();
    const client = makeQueryClient();
    client.setQueryData(["me"], { ...guestMe, guest: { ...guestMe.guest, business_id: "b1" } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Flow minWorkMs={60_000} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("try-tax")).toBeTruthy();
    expect(screen.getByText("mine.ofx")).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/guest")).toBe(false);
  });
});
