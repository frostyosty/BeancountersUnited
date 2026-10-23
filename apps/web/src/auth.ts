import type { Me } from "@acct/types/Me";
import type { Role } from "@acct/types/Role";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { SignUpRequest } from "@acct/types/SignUpRequest";
import { fetchMe, login, logout, signUp } from "./lib/api";

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

/** Signs a business owner up and in (M12). Resolves with their new business's id. */
export function useSignUp() {
  const qc = useQueryClient();
  return (req: SignUpRequest) =>
    signUp(req).then((res) => {
      qc.setQueryData<Me | null>(ME, res.me);
      return res.business_id;
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

/** A business owner ranks with staff here because both can work on a business they can see; the
 * server stops owners doing accountants' work (and limits them to their own business). */
const RANK: Record<Role, number> = { viewer: 0, business_owner: 1, staff: 1, practice_admin: 2, overseer: 3 };

/** Whether `me` has at least `role`'s permissions. The server checks again; this only hides UI. */
export function can(me: Me, role: Role): boolean {
  return RANK[me.role] >= RANK[role];
}

/** A business owner, who sees only their own business and the owner's screens. */
export function isOwner(me: Me): boolean {
  return me.role === "business_owner";
}
