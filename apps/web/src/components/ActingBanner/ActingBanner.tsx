import { useEffect, useState } from "react";
import { useCurrentUser } from "../../auth";
import { Icon } from "../../lib/icons";
import { ROLE_LABEL, useActingCommands, useViewAs } from "../../lib/viewAs";
import { Button, Field, Modal } from "../../ui";
import { ErrorMessage } from "../ErrorMessage";
import styles from "./ActingBanner.module.css";

const TICK_MS = 15_000;

/** Now, refreshed every few seconds, for the countdown. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
}

/**
 * The bar on every page while this session is viewing as someone (ADR 013). The state belongs to
 * the session, so the same bar shows in every tab.
 */
export function ActingBanner() {
  const { acting, real } = useViewAs();
  const person = useCurrentUser();
  const { allow, end } = useActingCommands();
  const [asking, setAsking] = useState<"end" | "allow" | null>(null);
  const [reason, setReason] = useState("");
  const now = useNow();

  if (!acting) {
    return null;
  }
  const left = minutesLeft(acting.expires_at, now);
  const close = () => {
    setAsking(null);
    setReason("");
    allow.reset();
    end.reset();
  };
  const command = asking === "allow" ? allow : end;
  const submit = () => {
    if (asking === "allow") {
      allow.mutate({ reason: reason.trim() }, { onSuccess: close });
    } else {
      end.mutate({ reason }, { onSuccess: close });
    }
  };

  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>
        <Icon name="acting.banner" fallback="👁️" /> Viewing as <strong>{acting.name}</strong> (
        {ROLE_LABEL[acting.role].toLowerCase()}) · {acting.allow_changes ? "changes on" : "read-only"} ·{" "}
        {left > 0 ? `${left} min left` : "ending now"}
        <span className="muted"> · you are {real.display_name}</span>
      </span>
      <span className={styles.actions}>
        {!acting.allow_changes && (
          <Button size="sm" onClick={() => setAsking("allow")}>
            <Icon name="acting.allow" fallback="⏳️" /> Allow changes
          </Button>
        )}
        <Button size="sm" onClick={() => setAsking("end")}>
          <Icon name="acting.end" fallback="↩️" /> End
        </Button>
      </span>
      <Modal
        open={asking !== null}
        onClose={close}
        title={asking === "allow" ? `Allow changes as ${person.display_name}` : `Stop viewing as ${person.display_name}`}
        icon={<Icon name={asking === "allow" ? "acting.allow" : "acting.end"} fallback="👁️" />}
        size="sm"
        dismissable={!command.isPending}
        footer={
          <>
            <Button onClick={close} disabled={command.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={command.isPending}
              disabled={asking === "allow" && !reason.trim()}
              onClick={submit}
            >
              {asking === "allow" ? "Allow changes" : "End"}
            </Button>
          </>
        }
      >
        {asking === "allow" ? (
          <>
            <p>
              Changes you make are saved in {person.display_name}'s name and appear in their Changes, with yours. This
              lasts until you end the view.
            </p>
            <p>Still refused, even with changes on:</p>
            <ul className={styles.list}>
              <li>finalising or reopening a year</li>
              <li>anything with IRD</li>
              <li>users, passwords and who can see what</li>
              <li>invites, and the person's own invoices</li>
            </ul>
          </>
        ) : (
          <p>Your screens go back to your own.</p>
        )}
        <Field label={asking === "allow" ? "Why do you need to make changes?" : "Note (optional)"}>
          <textarea
            className={styles.reason}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <p className="muted">{person.display_name} can read this in their Changes.</p>
        <ErrorMessage error={command.error} />
      </Modal>
    </div>
  );
}
