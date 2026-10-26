import type { HistorySharing } from "@acct/types/HistorySharing";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "./api";
import { keys } from "./queries";

/** Whether a business's owner lets their accountants see the owner's own edits in Changes. */
export function useHistorySharing(clientId: string | undefined) {
  return useQuery({
    queryKey: [...keys.business(clientId ?? ""), "history-sharing"],
    queryFn: () => getJson<HistorySharing>(`/api/businesses/${clientId}/history-sharing`),
    enabled: !!clientId,
  });
}
