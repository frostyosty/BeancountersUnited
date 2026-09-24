import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "./api";

/**
 * The app's query client. Any 401 means the session has ended (it expired, or a master reset the
 * password or deactivated the user), so the app drops back to the sign-in page.
 */
export function makeQueryClient(): QueryClient {
  const signedOut = (err: unknown) => {
    if (err instanceof ApiRequestError && err.status === 401) {
      client.setQueryData(["me"], null);
    }
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: signedOut }),
    mutationCache: new MutationCache({ onError: signedOut }),
    defaultOptions: {
      // The sync feed tells us when data changes, so there's no need to refetch on focus.
      queries: { refetchOnWindowFocus: false, retry: false },
    },
  });
  return client;
}
