import type { Me } from "@acct/types/Me";
import type { MeActingAs } from "@acct/types/MeActingAs";
import type { Role } from "@acct/types/Role";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import { CurrentUser } from "../auth";
import { ApiRequestError, submitCommand } from "./api";
import { newId } from "./id";

export const ROLE_LABEL: Record<Role, string> = {
  overseer: "Overseer",
  practice_admin: "Practice admin",
  staff: "Staff",
  viewer: "Viewer",
  business_owner: "Business owner",
};

const ME_KEY = ["me"] as const;

interface ViewAs {
  /**
   * The person who really signed in: the overseer while they're viewing as someone, else the
   * signed-in user. `useCurrentUser()` is the person being viewed as (the server's view).
   */
  real: Me;
  /** Set while this session is viewing as someone (ADR 013). */
  acting: MeActingAs | null;
}

const Context = createContext<ViewAs | null>(null);

export function useViewAs(): ViewAs {
  const v = useContext(Context);
  if (!v) {
    throw new Error("useViewAs outside a session");
  }
  return v;
}

/** The overseer's own identity, as a `Me`, while the server answers as someone else. */
function realOf(me: Me): Me {
  const real = me.acting_as ? me.real : null;
  return real ? { id: real.user_id, username: "", display_name: real.name, role: real.role } : me;
}

/** Everything cached for one identity must go when the identity changes; `me` is refetched, not reset. */
function resetIdentity(qc: QueryClient) {
  return qc.resetQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
}

function endedElsewhere(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.code === "impersonation_ended" || error.code === "not_impersonating");
}

/**
 * Provides the signed-in user as the server sees them. While an overseer views as someone (ADR
 * 013) that's the person, and the server answers every request as them; `real` is still the
 * overseer. Nothing is remembered in the browser: the state belongs to the session, so every tab
 * follows it, and this tab notices a change made in another when it refetches `me` on focus.
 */
export function ViewAsProvider({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const actingId = me.acting_as?.user_id ?? null;

  // Another tab started, ended or timed out the view: show nothing of the other identity.
  const last = useRef(actingId);
  useEffect(() => {
    if (last.current !== actingId) {
      last.current = actingId;
      void resetIdentity(qc);
    }
  }, [qc, actingId]);

  // A tab left in the background asks again when it comes back.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") void qc.invalidateQueries({ queryKey: ME_KEY });
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [qc]);

  // The server says the view has ended (timed out, or ended in another tab): ask who we are now.
  useEffect(() => {
    const onEvent = (event: { type: string; action?: { type: string; error?: unknown } }) => {
      if (event.type === "updated" && event.action?.type === "error" && endedElsewhere(event.action.error)) {
        void qc.invalidateQueries({ queryKey: ME_KEY });
      }
    };
    const stopQueries = qc.getQueryCache().subscribe(onEvent);
    const stopMutations = qc.getMutationCache().subscribe(onEvent);
    return () => {
      stopQueries();
      stopMutations();
    };
  }, [qc]);

  const real = useMemo(() => realOf(me), [me]);
  const value = useMemo(() => ({ real, acting: me.acting_as ?? null }), [real, me.acting_as]);
  return (
    <Context.Provider value={value}>
      <CurrentUser value={me}>{children}</CurrentUser>
    </Context.Provider>
  );
}

/** The three session commands (ADR 013). Each refetches `me`; the provider clears the rest. */
export function useActingCommands() {
  const qc = useQueryClient();
  const run = (command: Parameters<typeof submitCommand>[0]) => submitCommand(command, newId());
  const settle = () => qc.invalidateQueries({ queryKey: ME_KEY });
  const options = { onSuccess: settle, onError: (err: Error) => (endedElsewhere(err) ? settle() : undefined) };
  return {
    start: useMutation({
      mutationFn: (v: { userId: string; reason: string }) =>
        run({ kind: "start_impersonation", payload: { user_id: v.userId, reason: v.reason } }),
      ...options,
    }),
    allow: useMutation({
      mutationFn: (v: { reason: string }) =>
        run({ kind: "allow_impersonation_changes", payload: { reason: v.reason } }),
      ...options,
    }),
    end: useMutation({
      mutationFn: (v: { reason?: string }) =>
        run({ kind: "end_impersonation", payload: v.reason?.trim() ? { reason: v.reason.trim() } : {} }),
      ...options,
    }),
  };
}
