import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { coinCount, flyMoney, noteAction, recentAction, shares } from "./flyMoney";
import { type TryItState, useReducedMotion } from "./useTryIt";

/**
 * The tax and "saved so far" figures, which count down in step with the coins that fly into the
 * money bag when an answer saves tax. `owed` is what hasn't landed yet.
 */
export function useFlyingFigures(state: TryItState) {
  const ready = state.phase === "ready" ? state : null;
  const tax = ready?.tax ?? 0;
  const saved = ready?.savedSoFar ?? 0;
  const active = ready !== null;
  const refreshing = ready?.refreshing ?? false;
  const [owed, setOwed] = useState({ tax: 0, saved: 0 });
  const previous = useRef<{ tax: number; saved: number } | null>(null);
  const reduced = useReducedMotion();
  const cancel = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active) return;
    document.addEventListener("click", noteAction, true);
    return () => document.removeEventListener("click", noteAction, true);
  }, [active]);

  useLayoutEffect(() => {
    if (!active) {
      previous.current = null;
      return;
    }
    // The tax and the queue are fetched separately: wait until both are in so the coins carry the whole change.
    if (refreshing) return;
    const before = previous.current;
    previous.current = { tax, saved };
    if (!before || saved <= before.saved || reduced) return;
    const savedDelta = saved - before.saved;
    const taxDelta = Math.max(0, before.tax - tax);
    const n = coinCount(savedDelta);
    const taxShares = shares(taxDelta, n);
    const savedShares = shares(savedDelta, n);
    cancel.current();
    // Show the old figures straight away, then let each coin take its share off.
    setOwed({ tax: taxDelta, saved: savedDelta });
    const from = recentAction() ?? { x: window.innerWidth / 3, y: window.innerHeight / 2 };
    let left = { tax: taxDelta, saved: savedDelta };
    cancel.current = flyMoney(
      from,
      n,
      (i) => {
        left = { tax: left.tax - taxShares[i], saved: left.saved - savedShares[i] };
        setOwed(left);
      },
      () => setOwed({ tax: 0, saved: 0 }),
    );
  }, [tax, saved, active, reduced, refreshing]);

  useEffect(() => () => cancel.current(), []);

  // Mid-refresh the new figures are only half in: keep showing the last settled ones.
  if (refreshing && previous.current) return previous.current;
  return { tax: tax + owed.tax, saved: saved - owed.saved };
}

