import type { Me } from "@acct/types/Me";
import type { Role } from "@acct/types/Role";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { CurrentUser } from "../auth";

const KEY = "view-as-role";

/** What each real role may preview: itself and anything below. */
const PREVIEWABLE: Record<Role, Role[]> = {
  overseer: ["overseer", "practice_admin", "staff", "viewer", "business_owner"],
  practice_admin: ["practice_admin", "staff", "viewer"],
  staff: [],
  viewer: [],
  business_owner: [],
};

function read(real: Role): Role | null {
  try {
    const saved = window.sessionStorage.getItem(KEY) as Role | null;
    return saved && saved !== real && PREVIEWABLE[real].includes(saved) ? saved : null;
  } catch {
    return null;
  }
}

interface ViewAs {
  /** The signed-in user as the server knows them. */
  real: Me;
  /** The role the UI is previewing, if any. */
  as: Role | null;
  /** Roles this user may preview, besides their own. */
  options: Role[];
  setAs: (role: Role | null) => void;
}

const Context = createContext<ViewAs | null>(null);

export function useViewAs(): ViewAs {
  const v = useContext(Context);
  if (!v) {
    throw new Error("useViewAs outside a session");
  }
  return v;
}

/**
 * Provides the signed-in user, or, when an admin previews another role, the user with that role.
 * It only changes what the UI shows. The server still checks every request as the real user, so
 * previewing never grants anything (real impersonation is planned in PLAN.md M17).
 */
export function ViewAsProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [as, setAsState] = useState<Role | null>(() => read(me.role));
  const setAs = useCallback((role: Role | null) => {
    try {
      if (role) window.sessionStorage.setItem(KEY, role);
      else window.sessionStorage.removeItem(KEY);
    } catch {
      // A per-tab convenience only.
    }
    setAsState(role);
  }, []);
  const options = PREVIEWABLE[me.role].filter((r) => r !== me.role);
  const active = as && options.includes(as) ? as : null;
  const value = useMemo(() => ({ real: me, as: active, options, setAs }), [me, active, options.join(), setAs]);
  const effective: Me = active ? { ...me, role: active } : me;
  return (
    <Context.Provider value={value}>
      <CurrentUser value={effective}>{children}</CurrentUser>
    </Context.Provider>
  );
}
