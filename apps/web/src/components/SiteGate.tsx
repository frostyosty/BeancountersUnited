import { useRef, useState, type ReactNode } from "react";
import { Icon } from "../lib/icons";

const TAPS = 5;
const WINDOW_MS = 2000;
const KEY = "site-revealed";

function wasRevealed(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Hides the public site behind a plain header until it's tapped or clicked five times in quick
 * succession. Only a shrug for casual snoopers: the pages are still in the bundle.
 */
export function SiteGate({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(wasRevealed);
  const taps = useRef({ count: 0, last: 0 });

  if (open) {
    return <>{children}</>;
  }

  function tap() {
    const now = Date.now();
    const t = taps.current;
    t.count = now - t.last > WINDOW_MS ? 1 : t.count + 1;
    t.last = now;
    if (t.count >= TAPS) {
      try {
        sessionStorage.setItem(KEY, "1");
      } catch {
        // Not remembered; it'll ask again on reload.
      }
      setOpen(true);
    }
  }

  return (
    <header className="page" style={{ textAlign: "center", paddingTop: "30vh" }}>
      <h1 onClick={tap} style={{ cursor: "default", userSelect: "none" }}>
        <Icon name="home.brand" fallback="🫘" /> White Label Accounting
      </h1>
      <p>Coming soon.</p>
    </header>
  );
}
