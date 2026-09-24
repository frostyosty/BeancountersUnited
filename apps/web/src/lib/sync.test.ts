import type { Change } from "@acct/types/Change";
import { describe, expect, it, vi } from "vitest";
import { followSync } from "./sync";

const change = (seq: number): Change => ({ seq, kind: "post_journal", client_id: "c1", client_year_id: "y1", at: "" });

/** A fake feed over `log`, a list of seqs, answering like the server does. */
function feed(log: number[], limit = 500) {
  const asked: string[] = [];
  let failNext = 0;
  const fetchFn: typeof fetch = async (input) => {
    const url = new URL(String(input), "http://x");
    asked.push(url.search);
    if (failNext > 0) {
      failNext--;
      return new Response("down", { status: 502 });
    }
    const after = Number(url.searchParams.get("after"));
    const n = Number(url.searchParams.get("limit") ?? limit);
    const changes = log.filter((s) => s > after).slice(0, n).map(change);
    const body = { changes, last_seq: changes.at(-1)?.seq ?? after, head_seq: Math.max(0, ...log) };
    return new Response(JSON.stringify(body));
  };
  return { fetchFn, asked, failOnce: () => (failNext = 1) };
}

describe("followSync", () => {
  it("starts at the head, then reports only new changes", async () => {
    const log = [1, 2, 3];
    const f = feed(log);
    const seen: number[][] = [];
    const stop = followSync({ intervalMs: 5, fetchFn: f.fetchFn, onChanges: (c) => seen.push(c.map((x) => x.seq)) });
    await vi.waitFor(() => expect(f.asked.length).toBeGreaterThan(2));
    expect(seen).toEqual([]);
    log.push(4, 5);
    await vi.waitFor(() => expect(seen).toEqual([[4, 5]]));
    stop();
    expect(f.asked[0]).toBe("?after=0&limit=1");
    expect(f.asked.slice(1).every((q) => q.startsWith("?after=3") || q.startsWith("?after=5"))).toBe(true);
  });

  it("pages through a backlog before waiting", async () => {
    // Changes 2 to 6 land after the follower read the head (1), and pages hold two.
    const f = feed([1, 2, 3, 4, 5, 6], 2);
    const fetchFn: typeof fetch = async (input, init) =>
      String(input).includes("limit=1")
        ? new Response(JSON.stringify({ changes: [], last_seq: 0, head_seq: 1 }))
        : f.fetchFn(input, init);
    const seen: number[][] = [];
    const stop = followSync({ intervalMs: 5, fetchFn, onChanges: (c) => seen.push(c.map((x) => x.seq)) });
    await vi.waitFor(() => expect(seen).toEqual([[2, 3], [4, 5], [6]]));
    stop();
    // All three pages came in one tick, one after another.
    expect(f.asked.slice(0, 3)).toEqual(["?after=1", "?after=3", "?after=5"]);
  });

  it("carries on after an error", async () => {
    const log = [1];
    const f = feed(log);
    const errors: unknown[] = [];
    const seen: number[] = [];
    const stop = followSync({
      intervalMs: 5,
      fetchFn: f.fetchFn,
      onChanges: (c) => seen.push(...c.map((x) => x.seq)),
      onError: (e) => errors.push(e),
    });
    await vi.waitFor(() => expect(f.asked.length).toBeGreaterThan(1));
    f.failOnce();
    log.push(2);
    await vi.waitFor(() => expect(seen).toEqual([2]));
    stop();
    expect(errors).toHaveLength(1);
  });
});
