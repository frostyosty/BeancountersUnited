import type { Account } from "@acct/types/Account";
import type { ClientDetail } from "@acct/types/ClientDetail";
import type { ClientSummary } from "@acct/types/ClientSummary";
import type { JournalView } from "@acct/types/JournalView";
import type { PracticeView } from "@acct/types/PracticeView";
import type { UserView } from "@acct/types/UserView";
import type { YearSummary } from "@acct/types/YearSummary";
import type { YearTrialBalance } from "@acct/types/YearTrialBalance";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "./api";

/**
 * Query keys. The first element names what was read, and the second is the client or year it
 * belongs to, so the sync feed can invalidate by client or year.
 */
export const keys = {
  practice: ["practice"] as const,
  users: ["users"] as const,
  clients: ["clients"] as const,
  client: (id: string) => ["client", id] as const,
  chart: (clientId: string) => ["chart", clientId] as const,
  /** Everything read about years. A journal in one year changes the opening balances of the
   * years after it, so commands that post journals invalidate this whole prefix. */
  years: ["year"] as const,
  year: (id: string) => ["year", id] as const,
  journals: (yearId: string) => ["year", yearId, "journals"] as const,
  tb: (yearId: string) => ["year", yearId, "tb"] as const,
  report: (yearId: string) => ["year", yearId, "report"] as const,
};

export function usePractice() {
  return useQuery({ queryKey: keys.practice, queryFn: () => getJson<PracticeView>("/api/practice") });
}

export function useClients() {
  return useQuery({ queryKey: keys.clients, queryFn: () => getJson<ClientSummary[]>("/api/clients") });
}

export function useClient(id: string) {
  return useQuery({ queryKey: keys.client(id), queryFn: () => getJson<ClientDetail>(`/api/clients/${id}`) });
}

export function useChart(clientId: string) {
  return useQuery({ queryKey: keys.chart(clientId), queryFn: () => getJson<Account[]>(`/api/clients/${clientId}/chart`) });
}

export function useYear(id: string) {
  return useQuery({ queryKey: keys.year(id), queryFn: () => getJson<YearSummary>(`/api/years/${id}`) });
}

export function useJournals(yearId: string) {
  return useQuery({ queryKey: keys.journals(yearId), queryFn: () => getJson<JournalView[]>(`/api/years/${yearId}/journals`) });
}

export function useTrialBalance(yearId: string) {
  return useQuery({ queryKey: keys.tb(yearId), queryFn: () => getJson<YearTrialBalance>(`/api/years/${yearId}/tb`) });
}

export function useUsers() {
  return useQuery({ queryKey: keys.users, queryFn: () => getJson<UserView[]>("/api/users") });
}
