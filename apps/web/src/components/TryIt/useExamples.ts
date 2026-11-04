import type { ExampleStatement } from "@acct/types/ExampleStatement";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getJson } from "../../lib/api";

const NO_EXAMPLES: ExampleStatement[] = [];

/** The three example statements (public, so no session is needed). */
export function useExamples(): ExampleStatement[] {
  const q = useQuery({
    queryKey: ["examples"],
    queryFn: () => getJson<ExampleStatement[]>("/api/examples"),
    staleTime: Infinity,
    retry: false,
  });
  return q.data ?? NO_EXAMPLES;
}

/** Follows a media query. Without `matchMedia` (old browsers, some tests) it answers `fallback`. */
export function useMediaQuery(query: string, fallback = false): boolean {
  const read = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : fallback;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return matches;
}

/** True above the home page's 52rem breakpoint. */
export function useIsDesktop(): boolean {
  return !useMediaQuery("(max-width: 52rem)", false);
}
