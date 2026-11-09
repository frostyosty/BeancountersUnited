import { useState } from "react";
import { Icon } from "../../lib/icons";
import { Button, Modal } from "../../ui";
import styles from "./ClaimForm.module.css";

export type Who = "owner" | "accountant";

/**
 * "Who are you?" (M21, ADR 015, 6): asked before the claim form, and only to a guest who opened the
 * accountant view. **I run this business** is selected to begin with: an accountant sent down the
 * owner's path loses one click, but an owner sent down the accountant's path loses their trial. Opening
 * the accountant view is a reason to offer the choice, never a reason to pick it for them.
 */
export function WhoAreYou({ open, onClose, onContinue }: { open: boolean; onClose: () => void; onContinue: (who: Who) => void }) {
  const [who, setWho] = useState<Who>("owner");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Who are you?"
      icon={<Icon name="practice_request.who" fallback="👀" />}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onContinue(who)}>
            Continue
          </Button>
        </>
      }
    >
      <fieldset className={styles.who}>
        <legend className="muted">So we can show you the right next step.</legend>
        <label className={styles.choice}>
          <input type="radio" name="who" checked={who === "owner"} onChange={() => setWho("owner")} />
          <span>I run this business</span>
        </label>
        <label className={styles.choice}>
          <input type="radio" name="who" checked={who === "accountant"} onChange={() => setWho("accountant")} />
          <span>I'm an accountant or bookkeeper</span>
        </label>
      </fieldset>
    </Modal>
  );
}
