// @vitest-environment jsdom
import type { HistoryEntry } from "@acct/types/HistoryEntry";
import type { PresentUser } from "@acct/types/PresentUser";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryProvider, historyQuery } from "../lib/history";
import { renderApp, stubApi } from "../test/render";
import { ChangesButton } from "./ChangesButton";
import { HistoryPanel } from "./HistoryPanel";

beforeEach(() => {
  // The panel starts hidden; most of these tests are about what it shows once open.
  window.localStorage.setItem("history-panel-collapsed", "0");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const here: PresentUser[] = [
  { user_id: "u-ana", display_name: "Ana", role: "business_owner", business_id: "b1", business_name: "Ana's Gardens", last_seen: "", is_you: true },
  { user_id: "u-sam", display_name: "Sam", role: "staff", business_id: "b1", business_name: "Ana's Gardens", last_seen: "", is_you: false },
];

const coded: HistoryEntry = {
  seq: 12,
  at: "2026-10-24T01:02:03Z",
  kind: "code_bank_lines",
  description: "Sam accepted 12 AI suggestions: marked 12 COUNTDOWN transactions as personal. Tax to pay went up $84.",
  user_id: "u-sam",
  who: "Sam",
  business_id: "b1",
  business_name: "Ana's Gardens",
  changes: {
    fields: [{ subject: "COUNTDOWN on 1 Mar 2026 (-$7)", label: "category", before: "not sorted yet", after: "personal" }],
  },
  tax_change: 8400,
  ai: { model: "claude-haiku-5-5", suggestions: 12 },
};

const uploaded: HistoryEntry = {
  ...coded,
  seq: 9,
  kind: "import_statement",
  description: "Ana uploaded the statement aug.csv, adding 5 new transactions. Tax to pay went down $12.",
  user_id: "u-ana",
  who: "Ana",
  changes: { fields: [] },
  tax_change: -1200,
  ai: null,
};

function setup() {
  const asked: URLSearchParams[] = [];
  const beats: unknown[] = [];
  stubApi({
    "POST /api/presence": (init) => {
      beats.push(JSON.parse(String(init?.body)));
      return here;
    },
    "GET /api/history": (_, url) => {
      asked.push(url.searchParams);
      const figure = url.searchParams.get("figure");
      return { entries: figure ? [coded] : [coded, uploaded], next_before: null };
    },
  });
  renderApp(
    <HistoryProvider>
      <HistoryPanel />
      <ChangesButton figure={{ label: "tax to pay", figure: "tax" }} />
    </HistoryProvider>,
    "/businesses/b1",
  );
  return { asked, beats };
}

describe("history panel", () => {
  it("starts hidden, behind a Show changes button", async () => {
    window.localStorage.clear();
    setup();
    await userEvent.setup().click(await screen.findByRole("button", { name: /Show changes/ }));
    expect(await screen.findByRole("list", { name: /here now/i })).toBeTruthy();
  });

  it("shows who's here and the changes, with before and after, tax effect and AI attribution", async () => {
    const { beats } = setup();
    const people = await screen.findByRole("list", { name: /here now/i });
    const [you, other] = within(people).getAllByRole("listitem");
    expect(you!.textContent).toBe("Ana (you) · on Ana's Gardens");
    expect(other!.textContent).toBe("Sam · on Ana's Gardens");
    expect(beats[0]).toEqual({ business_id: "b1" });

    const feed = await screen.findByRole("list", { name: "Changes, newest first" });
    const items = [...feed.children];
    expect(items[0]!.textContent).toContain("marked 12 COUNTDOWN transactions as personal");
    expect(items[0]!.textContent).toContain("AI suggestion (claude-haiku-5-5), accepted by Sam");
    expect(items[0]!.textContent).toContain("Tax to pay up $84.00");
    expect(items[0]!.textContent).toContain("not sorted yet → personal");
    expect(items[1]!.textContent).toContain("Tax to pay down $12.00");
    expect(items[1]!.textContent).not.toContain("AI suggestion");
  });

  it("filters to the changes behind a figure when it's clicked, and back", async () => {
    const { asked } = setup();
    await screen.findByRole("list", { name: "Changes, newest first" });
    expect(asked.at(-1)!.get("business")).toBe("b1");
    expect(asked.at(-1)!.has("figure")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "What changed tax to pay" }));
    await waitFor(() => expect(asked.at(-1)!.get("figure")).toBe("tax"));
    expect(screen.getByRole("status").textContent).toContain("What changed tax to pay");
    await waitFor(() => expect(screen.queryAllByText(/uploaded the statement/)).toHaveLength(0));

    await userEvent.click(screen.getByRole("button", { name: "Show all changes" }));
    await waitFor(() => expect(asked.at(-1)!.has("figure")).toBe(false));
  });

  it("filters by person, kind of change and business", async () => {
    const { asked } = setup();
    await screen.findByRole("list", { name: "Changes, newest first" });
    await userEvent.click(screen.getByRole("button", { name: "Filter changes" }));
    await userEvent.selectOptions(screen.getByLabelText("Person"), "u-sam");
    await waitFor(() => expect(asked.at(-1)!.get("user")).toBe("u-sam"));
    await userEvent.click(screen.getByLabelText("Staff only"));
    await waitFor(() => expect(asked.at(-1)!.get("staff_only")).toBe("true"));
    await userEvent.click(screen.getByLabelText("Manual entries"));
    await waitFor(() => expect(asked.at(-1)!.get("manual")).toBe("true"));
    await userEvent.click(screen.getByLabelText("Every business"));
    await waitFor(() => expect(asked.at(-1)!.has("business")).toBe(false));
  });
});

describe("historyQuery", () => {
  it("sends a statement line's accounts with its year", () => {
    expect(
      historyQuery({
        business: null,
        user: null,
        figure: { label: "Sales", year: "y1", accounts: ["100", "110"] },
      }),
    ).toBe("?year=y1&accounts=100%2C110");
  });
});
