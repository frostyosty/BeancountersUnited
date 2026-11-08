// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui";
import { ExplainBetter } from "./ExplainBetter";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(response: () => Response) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <ToastProvider>
        <ExplainBetter clientId="b1" cardId="line:l1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ExplainBetter", () => {
  it("sends only the card's id and shows the explanation", async () => {
    const fetchMock = setup(() => json(200, { text: "This payment looks like tax.", model: "m" }));
    await userEvent.click(screen.getByRole("button", { name: /explain better/i }));
    expect(await screen.findByText(/looks like tax/)).toBeTruthy();
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/businesses/b1/explain");
    expect(JSON.parse(init.body as string)).toEqual({ card_id: "line:l1" });
  });

  it("says so in a toast when the daily limit is reached, and stops offering it", async () => {
    setup(() => json(422, { code: "ai_daily_limit", message: "Daily usage limit reached. Explanations are back tomorrow." }));
    await userEvent.click(screen.getByRole("button", { name: /explain better/i }));
    expect(await screen.findByText(/Daily usage limit reached/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: /back tomorrow/i }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("shows nothing when the server has no AI service", async () => {
    setup(() => json(422, { code: "ai_unavailable", message: "no" }));
    await userEvent.click(screen.getByRole("button", { name: /explain better/i }));
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  });
});
