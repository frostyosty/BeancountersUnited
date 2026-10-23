import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { makeQueryClient } from "../lib/queryClient";

type Handler = (init: RequestInit | undefined, url: URL) => unknown;

/**
 * Stubs `fetch` with a handler per `"METHOD /path"`. A handler returns the JSON body, or a
 * `Response` for anything else. Unknown routes fail the test loudly.
 */
export function stubApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}`;
    const handler = routes[key] ?? quiet[key];
    // Background polling a test didn't ask about stays out of `calls`.
    if (routes[key]) {
      calls.push({ method, path: url.pathname, body: init?.body === undefined ? undefined : parseBody(String(init.body)) });
    }
    if (!handler) {
      throw new Error(`unexpected request: ${key}`);
    }
    const result = handler(init, url);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
  });
  return calls;
}

/** What the app polls in the background, when a test doesn't care about it: nothing ever changes,
 * nobody else is here, and there's no history. */
const quiet: Record<string, Handler> = {
  "GET /api/sync": () => ({ changes: [], last_seq: 0, head_seq: 0 }),
  "POST /api/presence": () => [],
  "GET /api/history": () => ({ entries: [], next_before: null }),
};

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

export function renderApp(ui: ReactElement, path = "/") {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
