import type { Change } from "@acct/types/Change";
import type { SyncFeed } from "@acct/types/SyncFeed";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ApiRequestError, getJson } from "./api";

export const SYNC_INTERVAL_MS = 3000;

/**
 * Follows `GET /api/sync`: starts at the head of the log, then polls for changes after the last
 * one seen and hands each batch to `onChanges`. Errors go to `onError` and polling carries on,
 * so a server restart doesn't end live refresh. Runs until the returned function is called.
 */
export function followSync(opts: {
  onChanges: (changes: Change[]) => void;
  onError?: (err: unknown) => void;
  intervalMs?: number;
  fetchFn?: typeof fetch;
}): () => void {
  const { onChanges, onError, intervalMs = SYNC_INTERVAL_MS, fetchFn = fetch } = opts;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let after: number | null = null;

  const tick = async () => {
    try {
      if (after === null) {
        after = (await getJson<SyncFeed>("/api/sync?after=0&limit=1", fetchFn)).head_seq;
      } else {
        // Page through anything that piled up (a sleeping laptop, say) before waiting again.
        for (;;) {
          const feed: SyncFeed = await getJson<SyncFeed>(`/api/sync?after=${after}`, fetchFn);
          if (stopped) {
            return;
          }
          after = feed.last_seq;
          if (feed.changes.length > 0) {
            onChanges(feed.changes);
          }
          if (feed.last_seq >= feed.head_seq) {
            break;
          }
        }
      }
    } catch (err) {
      if (stopped) {
        return;
      }
      onError?.(err);
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Keeps every screen live: when anyone changes anything, refetch what's cached. Only mounted
 * queries actually refetch, and on a LAN that's cheaper than being clever about which ones.
 * The signed-in user is left alone; a 401 from the feed signs out.
 */
export function useLiveRefresh(intervalMs = SYNC_INTERVAL_MS) {
  const qc = useQueryClient();
  useEffect(
    () =>
      followSync({
        intervalMs,
        onChanges: () => void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" }),
        onError: (err) => {
          if (err instanceof ApiRequestError && err.status === 401) {
            qc.setQueryData(["me"], null);
          }
        },
      }),
    [qc, intervalMs],
  );
}
