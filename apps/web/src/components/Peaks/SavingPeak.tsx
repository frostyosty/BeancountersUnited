import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { formatMoney } from "../../lib/money";
import { Icon } from "../../lib/icons";
import { Button } from "../../ui";
import { ClaimForm } from "../ClaimForm";
import styles from "./Peaks.module.css";
import { hasSeenSavingPeak, noteSavingPeak, SAVING_THRESHOLD_CENTS } from "./peaks";

/**
 * What goes under "saved so far" once Save tax has brought the figure down (M21, ADR 015, 3.1 and 3.4):
 * - on a guest's own file, the first-saving line, once per trial;
 * - on an example, "Like that? Drop your own statement and see yours."
 *
 * `savedSoFar` is the server's figure. `kind` is the caller's to say, because on the home page the app
 * doesn't know the guest until they enter it. Never mount this for a signed-up owner.
 */
export function SavingPeak({ businessId, savedSoFar, kind }: { businessId: string; savedSoFar: number; kind: "own" | "example" }) {
  if (kind === "example") {
    return savedSoFar >= SAVING_THRESHOLD_CENTS ? <ExampleLine /> : null;
  }
  // Keyed, so a different business starts from its own storage.
  return <OwnSavingLine key={businessId} businessId={businessId} savedSoFar={savedSoFar} />;
}

function OwnSavingLine({ businessId, savedSoFar }: { businessId: string; savedSoFar: number }) {
  // Read once, on arrival: what an earlier visit showed is not shown again, but what this visit has
  // shown stays up, so it isn't snatched away.
  const [seenBefore] = useState(() => hasSeenSavingPeak(businessId));
  const [shownHere, setShownHere] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);

  const visible = savedSoFar >= SAVING_THRESHOLD_CENTS && !dismissed && (shownHere || !seenBefore);
  useEffect(() => {
    if (visible && !shownHere) {
      noteSavingPeak(businessId);
      setShownHere(true);
    }
  }, [visible, shownHere, businessId]);

  if (!visible) {
    return null;
  }
  return (
    <div className={styles.peak} role="note">
      <p>
        <Icon name="peaks.saving" fallback="🥳" /> Keep the ${formatMoney(savedSoFar)} you've saved: save your work. It
        takes 20 seconds.
      </p>
      <div className={styles.actions}>
        <Button variant="primary" size="sm" onClick={() => setSaving(true)}>
          <Icon name="guest.save" fallback="💾" /> Save your work
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
          Not now
        </Button>
      </div>
      <ClaimForm open={saving} onClose={() => setSaving(false)} hasOwnBusiness from="saving" />
    </div>
  );
}

/** An example's peak is their own file, not an account (examples can't be saved). It's never dismissed. */
function ExampleLine() {
  const { pathname } = useLocation();
  return (
    <p className={styles.peak} role="note">
      <Icon name="peaks.example" fallback="👀" /> Like that?{" "}
      <Link
        to="/#features"
        onClick={() => {
          // Already on the home page: the hash may not change, so scroll there by hand.
          if (pathname === "/") {
            document.getElementById("features")?.scrollIntoView?.({ behavior: "smooth" });
          }
        }}
      >
        Drop your own statement and see yours.
      </Link>
    </p>
  );
}
