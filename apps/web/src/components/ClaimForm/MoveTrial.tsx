import { useState } from "react";
import { useNavigate } from "react-router";
import { useAdoptTrial, useCurrentUser } from "../../auth";
import { Icon } from "../../lib/icons";
import { Button, Modal } from "../../ui";
import { ErrorMessage } from "../ErrorMessage";

/**
 * After a guest signs in to an existing account (ADR 014, 4): offers to move the statement they
 * just tried into it. It moves as a business of its own, never merged into one they already have.
 */
export function MoveTrial() {
  const { moveable_trial: trial } = useCurrentUser();
  const adopt = useAdoptTrial();
  const navigate = useNavigate();
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  if (!trial || gone) {
    return null;
  }
  const answer = (moveIt: boolean) => {
    setBusy(true);
    setError(null);
    adopt(moveIt)
      .then((businessId) => {
        setGone(true);
        if (businessId) {
          void navigate(`/businesses/${businessId}`);
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setBusy(false));
  };
  const statements = `${trial.statements} ${trial.statements === 1 ? "statement" : "statements"}`;
  const lines = `${trial.lines} ${trial.lines === 1 ? "line" : "lines"}`;
  return (
    <Modal
      open
      onClose={() => answer(false)}
      title="Move the statement you just tried into your account?"
      icon={<Icon name="guest.move" fallback="📦" />}
      size="sm"
      dismissable={!busy}
      footer={
        <>
          <Button onClick={() => answer(false)} disabled={busy}>
            Leave it
          </Button>
          <Button variant="primary" busy={busy} onClick={() => answer(true)}>
            Move it
          </Button>
        </>
      }
    >
      <p>
        You tried {statements} ({lines}) before signing in. It comes in as a business of its own, so it never mixes with
        the ones you already have.
      </p>
      <p className="muted">If you leave it, it's deleted when the trial ends.</p>
      <ErrorMessage error={error} />
    </Modal>
  );
}
