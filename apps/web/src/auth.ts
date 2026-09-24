import type { Me } from "@acct/types/Me";
import type { Role } from "@acct/types/Role";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { fetchMe, login, logout } from "./lib/api";

const ME = ["me"] as const;

/** The logged-in user: `data` is `null` when there's no session. */
export function useMe() {
  return useQuery({ queryKey: ME, queryFn: () => fetchMe() });
}

export function useSignIn() {
  const qc = useQueryClient();
  return (username: string, password: string) =>
    login({ username, password }).then((me) => {
      qc.setQueryData<Me | null>(ME, me);
      return me;
    });
}

export function useSignOut() {
  const qc = useQueryClient();
  return () =>
    logout().then(() => {
      qc.setQueryData<Me | null>(ME, null);
      // Nothing cached for one user should show to the next.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME[0] });
    });
}

/** The signed-in user, provided by `App` around the signed-in part of the app. */
export const CurrentUser = createContext<Me | null>(null);

/** The logged-in user, inside the signed-in part of the app. */
export function useCurrentUser(): Me {
  const me = useContext(CurrentUser);
  if (!me) {
    throw new Error("useCurrentUser outside a session");
  }
  return me;
}

const RANK: Record<Role, number> = { viewer: 0, staff: 1, master: 2 };

/** Whether `me` has at least `role`'s permissions. The server checks again; this only hides UI. */
export function can(me: Me, role: Role): boolean {
  return RANK[me.role] >= RANK[role];
}
