import { Link } from "react-router";
import { Emoji, Icon } from "../../lib/icons";
import styles from "../../pages/FeaturesPage.module.css";
import type { OpenInTrial, TrialPath } from "./useOpenInTrial";

/**
 * Where a site page's link leads: the home page's drop, a screen of the visitor's trial, or a page that
 * needs neither (`to`, like the invoice maker).
 */
export type Target = { home: true } | { trial: TrialPath } | { to: string };

/** What the link says: it depends on whether a trial is already loaded. */
function goLabel(o: OpenInTrial, key: string, target: Target): string {
  if ("home" in target) return "Try it on the home page";
  if ("to" in target) return "Open it";
  if (o.opening === key) return "Opening…";
  return o.hasTrial ? "Open it" : "See it on an example";
}

/** The link or button that opens a target. `id` names it, so only the clicked one says "Opening…". */
export function TrialLink({ o, id, target }: { o: OpenInTrial; id: string; target: Target }) {
  const label = (
    <>
      <Icon name="peaks.open" fallback="➡️" /> {goLabel(o, id, target)}
    </>
  );
  if ("home" in target) {
    return (
      <Link to="/#features" className={styles.go}>
        {label}
      </Link>
    );
  }
  if ("to" in target) {
    return (
      <Link to={target.to} className={styles.go}>
        {label}
      </Link>
    );
  }
  return (
    <button type="button" className={styles.go} aria-busy={o.opening === id} onClick={() => o.open(id, target.trial)}>
      {label}
    </button>
  );
}

/**
 * What it takes to use a feature. `free`: a free account (every plan has it). `firm`: an accounting
 * firm's account. `soon`: not built yet.
 */
export type Access = "try" | "free" | "firm" | "soon";

export function Badge({ kind }: { kind: Access }) {
  switch (kind) {
    case "try":
      return (
        <span className={`${styles.badge} ${styles.tryNow}`}>
          <Emoji>✅</Emoji> Try it now
        </span>
      );
    case "free":
      return (
        <span className={styles.badge}>
          <Icon name="guest.locked" fallback="🔒" /> Needs a free account
        </span>
      );
    case "firm":
      return (
        <span className={styles.badge}>
          <Icon name="practice_request.practice" fallback="🏭" /> With a firm account
        </span>
      );
    case "soon":
      return (
        <span className={`${styles.badge} ${styles.soon}`}>
          <Emoji>🌳</Emoji> Coming soon
        </span>
      );
  }
}
