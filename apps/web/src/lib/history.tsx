import type { HistoryPage } from "@acct/types/HistoryPage";
import type { PresentUser } from "@acct/types/PresentUser";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { getJson, sendPresence } from "./api";
import { SYNC_INTERVAL_MS } from "./sync";

/**
 * A figure whose changes the history panel lists: the tax to pay or one part of it (`figure`), or
 * the accounts behind a TB or statement line (`year` and `accounts`).
 */
export interface FigureFilter {
  /** What the panel says it's showing, such as "Tax to pay". */
  label: string;
  figure?: string;
  year?: string;
  accounts?: string[];
}

/** The history panel's filters. */
export interface HistoryFilters {
  business: string | null;
  user: string | null;
  from: string | null;
  to: string | null;
  figure: FigureFilter | null;
  /** How many entries to fetch, newest first. */
  limit?: number;
}

/** `GET /api/history`'s query string for these filters. */
export function historyQuery(f: HistoryFilters, before?: number): string {
  const q = new URLSearchParams();
  if (f.business) q.set("business", f.business);
  if (f.user) q.set("user", f.user);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.figure?.figure) q.set("figure", f.figure.figure);
  if (f.figure?.year && f.figure.accounts) {
    q.set("year", f.figure.year);
    q.set("accounts", f.figure.accounts.join(","));
  }
  if (f.limit !== undefined) q.set("limit", String(f.limit));
  if (before !== undefined) q.set("before", String(before));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The key of every history read; the sync feed's refresh invalidates it with everything else. */
export const historyKey = ["history"] as const;

export function useHistory(filters: HistoryFilters) {
  return useQuery({
    queryKey: [...historyKey, filters],
    queryFn: () => getJson<HistoryPage>(`/api/history${historyQuery(filters)}`),
  });
}

/** Who's here now. Polling it is also how this browser says it's here. */
export function usePresence(businessId: string | null) {
  return useQuery<PresentUser[]>({
    queryKey: ["presence", businessId],
    queryFn: () => sendPresence(businessId),
    refetchInterval: SYNC_INTERVAL_MS,
  });
}

interface HistoryContextValue {
  figure: FigureFilter | null;
  /** Shows the changes that moved a figure in the panel. */
  showChanges: (figure: FigureFilter) => void;
  clearFigure: () => void;
}

const HistoryContext = createContext<HistoryContextValue>({
  figure: null,
  showChanges: () => {},
  clearFigure: () => {},
});

export function HistoryProvider({ children }: { children: ReactNode }) {
  const [figure, setFigure] = useState<FigureFilter | null>(null);
  const value = useMemo(
    () => ({ figure, showChanges: setFigure, clearFigure: () => setFigure(null) }),
    [figure],
  );
  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>;
}

export function useHistoryContext() {
  return useContext(HistoryContext);
}
