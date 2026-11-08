// @vitest-environment jsdom
import type { BusinessView } from "@acct/types/BusinessView";
import type { SaveTaxQueue } from "@acct/types/SaveTaxQueue";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp, stubApi } from "../../test/render";
import { TaxSavedCard } from "../TryIt/TryItSteps";
import { UploadDrop } from "../TryIt/UploadDrop";
import { useTryIt } from "../TryIt/useTryIt";
import { SAVING_THRESHOLD_CENTS, hasSeenSavingPeak } from "./peaks";
import { SavingPeak } from "./SavingPeak";

beforeEach(() => {
  sessionStorage.setItem("site-revealed", "1");
  localStorage.clear();
  stubApi({ "GET /api/me": () => null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const line = () => screen.queryByText(/Keep the \$[\d,.]+ you've saved/);

describe("the first-saving line (ADR 015, 3.1)", () => {
  it("is the same $100.00 the ADR says", () => {
    expect(SAVING_THRESHOLD_CENTS).toBe(10_000);
  });

  it("stays away below $100.00 and shows at $100.00", () => {
    renderApp(<SavingPeak businessId="b1" savedSoFar={9_999} kind="own" />).unmount();
    expect(line()).toBeNull();
    renderApp(<SavingPeak businessId="b2" savedSoFar={10_000} kind="own" />);
    expect(screen.getByText(/Keep the \$100\.00 you've saved/)).toBeTruthy();
  });

  it("says what they have saved, and follows the figure while it is up", async () => {
    function Harness() {
      const [cents, setCents] = useState(325_717);
      return (
        <>
          <button type="button" onClick={() => setCents(401_000)}>
            more
          </button>
          <SavingPeak businessId="b1" savedSoFar={cents} kind="own" />
        </>
      );
    }
    renderApp(<Harness />);
    expect(screen.getByText(/Keep the \$3,257\.17 you've saved: save your work\. It takes 20 seconds\./)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "more" }));
    expect(screen.getByText(/Keep the \$4,010\.00 you've saved/)).toBeTruthy();
  });

  it("shows once per trial: a later visit doesn't see it again", () => {
    const first = renderApp(<SavingPeak businessId="b1" savedSoFar={20_000} kind="own" />);
    expect(line()).not.toBeNull();
    expect(hasSeenSavingPeak("b1")).toBe(true);
    first.unmount();
    renderApp(<SavingPeak businessId="b1" savedSoFar={20_000} kind="own" />);
    expect(line()).toBeNull();
  });

  it("is remembered per business, so another trial is offered it", () => {
    renderApp(<SavingPeak businessId="b1" savedSoFar={20_000} kind="own" />).unmount();
    renderApp(<SavingPeak businessId="b2" savedSoFar={20_000} kind="own" />);
    expect(line()).not.toBeNull();
  });

  it("goes at once on Not now, and stays gone for the visit", async () => {
    renderApp(<SavingPeak businessId="b1" savedSoFar={20_000} kind="own" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Not now" }));
    expect(line()).toBeNull();
    expect(hasSeenSavingPeak("b1")).toBe(true);
  });

  it("still shows when browser storage is blocked, and the page works", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderApp(<SavingPeak businessId="b1" savedSoFar={20_000} kind="own" />);
    expect(line()).not.toBeNull();
    vi.restoreAllMocks();
  });
});

describe("an example's line (ADR 015, 3.4)", () => {
  it("never shows the account line, and shows 'drop your own statement' from $100.00", () => {
    const below = renderApp(<SavingPeak businessId="x1" savedSoFar={9_999} kind="example" />);
    expect(screen.queryByText(/Like that\?/)).toBeNull();
    below.unmount();

    renderApp(<SavingPeak businessId="x1" savedSoFar={325_717} kind="example" />);
    expect(line()).toBeNull();
    expect(screen.getByText(/Like that\?/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Drop your own statement and see yours." });
    expect(link.getAttribute("href")).toBe("/#features");
  });

  it("asks for no account, so it isn't remembered or dismissed", () => {
    const first = renderApp(<SavingPeak businessId="x1" savedSoFar={325_717} kind="example" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(hasSeenSavingPeak("x1")).toBe(false);
    first.unmount();
    renderApp(<SavingPeak businessId="x1" savedSoFar={325_717} kind="example" />);
    expect(screen.getByText(/Like that\?/)).toBeTruthy();
  });
});

// ---- On the home page: under "saved so far", from the server's figure ----

const business = {
  client_id: "b1",
  name: "Your business",
  start_date: "2025-04-01",
  gst_registered_from: null,
  gst_frequency: null,
  gst_source: "none",
  gst_evidence: null,
  example: null,
  bank_accounts: [],
  transfers: [],
  ird_payments: [],
  possible_duplicates: [],
} as unknown as BusinessView;

function Flow() {
  const tryIt = useTryIt([], { minWorkMs: 0 });
  return (
    <>
      <button type="button" onClick={() => tryIt.useExample(1)}>
        load example
      </button>
      <UploadDrop onExample={tryIt.useExample} onFile={tryIt.useFile} />
      <TaxSavedCard tryIt={tryIt} />
    </>
  );
}

function homeServer(savedSoFar: number, example: number | null) {
  const guestMe = {
    id: "g1",
    username: "",
    display_name: "You",
    role: "business_owner",
    guest: { expires_at: "2026-11-13T00:00:00Z", business_id: example ? null : "b1", example: example ? { business_id: "b1", number: example, expires_at: "2026-11-09T00:00:00Z" } : null },
  };
  const queue: SaveTaxQueue = { total: 700_000, conservative_total: 900_000, saved_so_far: savedSoFar, cards: [] };
  stubApi({
    "GET /api/me": () => null,
    "GET /api/examples": () => [],
    "POST /api/guest": () => ({ me: guestMe, business_id: "b1", accepted: { seq: 1, entity_id: "b1" } }),
    "GET /api/businesses/b1": () => ({ ...business, example }),
    "GET /api/businesses/b1/tax": () => ({ total: 700_000, gst: [], income: [], notices: [] }),
    "GET /api/businesses/b1/save-tax": () => queue,
  });
}

describe("on the home page", () => {
  it("a visitor's own file gets the line once the saving is over $100, with a button that opens Save your work", async () => {
    homeServer(200_000, null);
    renderApp(<Flow />);
    fireEvent.change(await screen.findByLabelText("Bank statement file"), { target: { files: [new File(["OFXHEADER:100"], "mine.ofx")] } });
    const note = (await screen.findByText(/Keep the \$2,000\.00 you've saved/)).closest("[role=note]") as HTMLElement;
    await userEvent.setup().click(within(note).getByRole("button", { name: /Save your work/ }));
    // The visitor isn't known to the signed-out app yet, but the button still works.
    expect(await screen.findByLabelText("Email")).toBeTruthy();
  });

  it("an example never gets it, and gets 'drop your own statement' instead", async () => {
    homeServer(200_000, 1);
    renderApp(<Flow />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "load example" }));
    expect(await screen.findByText(/Like that?/)).toBeTruthy();
    expect(line()).toBeNull();
    expect(hasSeenSavingPeak("b1")).toBe(false);
  });

  it("shows nothing before there's any saving", async () => {
    homeServer(0, null);
    renderApp(<Flow />);
    fireEvent.change(await screen.findByLabelText("Bank statement file"), { target: { files: [new File(["OFXHEADER:100"], "mine.ofx")] } });
    await screen.findByText("Answer a question and watch it grow.");
    expect(line()).toBeNull();
    await waitFor(() => expect(screen.queryByText(/Like that\?/)).toBeNull());
  });
});
