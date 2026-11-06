import type { ClaimRequest } from "@acct/types/ClaimRequest";
import type { Me } from "@acct/types/Me";
import type { MeGuest } from "@acct/types/MeGuest";
import type { Role } from "@acct/types/Role";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { SignUpRequest } from "@acct/types/SignUpRequest";
import { adoptGuest, claimGuest, fetchMe, login, logout, signUp } from "./lib/api";
import { historyKey } from "./lib/history";
import { newId } from "./lib/id";

const ME = ["me"] as const;

/** The logged-in user: `data` is `null` when there's no session. */
export function useMe() {
  return useQuery({ queryKey: ME, queryFn: () => fetchMe() });
}

/**
 * The guest session, if this is one. Reads the cached `me` without fetching it again, so small
 * pieces of the page (the banner, Save your work buttons) don't each refetch it on mount.
 */
export function useGuest(): MeGuest | null {
  const me = useQuery({ queryKey: ME, queryFn: () => fetchMe(), staleTime: Infinity });
  return me.data?.guest ?? null;
}

export function useSignIn() {
  const qc = useQueryClient();
  return (username: string, password: string) =>
    login({ username, password }).then((me) => {
      // A guest who signs in leaves the guest's business behind: nothing cached for it shows now.
      if (qc.getQueryData<Me | null>(ME)?.guest) {
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME[0] });
      }
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

/**
 * A guest saves their work (M20). Their business, lines and answers stay where they are, so the only
 * things to refresh are who they are and how Changes names them.
 */
export function useClaimGuest() {
  const qc = useQueryClient();
  return (req: Omit<ClaimRequest, "id">) =>
    claimGuest({ id: newId(), ...req }).then((res) => {
      qc.setQueryData<Me | null>(ME, res.me);
      void qc.invalidateQueries({ queryKey: historyKey });
      return res.business_id;
    });
}

/** Moves the trial this browser had into the signed-in account (`move_it`) or leaves it. */
export function useAdoptTrial() {
  const qc = useQueryClient();
  return (moveIt: boolean) =>
    adoptGuest({ id: newId(), move_it: moveIt }).then(async (res) => {
      await qc.invalidateQueries({ queryKey: ME });
      if (res.business_id) {
        await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== ME[0] });
      }
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

/** A visitor trying the app with no account yet (M20): they hold a guest session. */
export function isGuest(me: Me): me is Me & { guest: MeGuest } {
  return !!me.guest;
}

/** The business a guest lands on: their own, else the example they're trying. */
export function guestBusinessId(guest: MeGuest): string | null {
  return guest.business_id ?? guest.example?.business_id ?? null;
}
