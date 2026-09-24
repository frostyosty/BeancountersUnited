import type { Account } from "@acct/types/Account";
import type { ClientDetail } from "@acct/types/ClientDetail";
import type { ClientSummary } from "@acct/types/ClientSummary";
import type { PracticeView } from "@acct/types/PracticeView";
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
