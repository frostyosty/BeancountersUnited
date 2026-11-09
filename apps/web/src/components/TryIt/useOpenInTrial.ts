import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useExamples } from "./useExamples";
import { useTryIt } from "./useTryIt";

/** Where a tile leads inside a trial's business, given its id. */
export type TrialPath = (businessId: string) => string;

export interface OpenInTrial {
  /** Opens `to` in the visitor's trial, loading Example 1 first when there's none. `key` names the tile. */
  open: (key: string, to: TrialPath) => void;
  /** The tile that's waiting for Example 1 to load, if any. */
  opening: string | null;
  /** The visitor already has a trial (their own file or an example), so tiles open at once. */
  hasTrial: boolean;
  /** Why loading Example 1 failed, if it did. */
  error: string | null;
}

/**
 * The site pages' "click anything to see it" tiles (M21), as the home page's accountant tiles do it:
 * with a trial, a tile opens that screen of it; with none, it loads Example 1 and then opens the screen,
 * so one click is enough. There's no loader to watch here, so it doesn't wait the home page's two seconds.
 */
export function useOpenInTrial(): OpenInTrial {
  const examples = useExamples();
  const tryIt = useTryIt(examples, { minWorkMs: 0 });
  const navigate = useNavigate();
  const [opening, setOpening] = useState<{ key: string; to: TrialPath } | null>(null);

  const { state, enterApp } = tryIt;
  const readyBusiness = state.phase === "ready" ? state.businessId : null;
  const failed = state.phase === "error";
  useEffect(() => {
    if (failed) setOpening(null);
    else if (opening && readyBusiness) {
      setOpening(null);
      // The signed-out app doesn't know the guest yet; let it, so the business routes open.
      enterApp();
      void navigate(opening.to(readyBusiness));
    }
  }, [opening, readyBusiness, failed, enterApp, navigate]);

  const hasTrial = state.phase !== "idle" && state.phase !== "error";
  const open = (key: string, to: TrialPath) => {
    setOpening({ key, to });
    if (!hasTrial) tryIt.useExample(1);
  };
  return { open, opening: opening?.key ?? null, hasTrial, error: failed ? state.message : null };
}
