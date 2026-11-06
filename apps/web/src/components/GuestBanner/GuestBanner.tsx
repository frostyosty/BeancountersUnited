import { useGuest } from "../../auth";
import { formatDate } from "../../lib/dates";
import { Icon } from "../../lib/icons";
import { useCommand } from "../../lib/useCommand";
import { Button, useConfirm } from "../../ui";
import styles from "./GuestBanner.module.css";
import { SaveWorkButton } from "./SaveWorkButton";

/**
 * The bar on every page a guest sees (M20, ADR 014): their work isn't saved, and when it goes. It
 * reads Me itself, so it works on the home page as well as inside the signed-in layout.
 */
export function GuestBanner() {
  const guest = useGuest();
  const del = useCommand([["me"]]);
  const [confirm, confirmDialog] = useConfirm();
  if (!guest) {
    return null;
  }
  // A guest with only an example is looking at made-up figures, which go sooner.
  const own = guest.business_id !== null;
  const goes = own ? guest.expires_at : (guest.example?.expires_at ?? guest.expires_at);
  const target = guest.business_id ?? guest.example?.business_id;

  const deleteNow = async () => {
    if (!target) {
      return;
    }
    const ok = await confirm({
      title: "Delete your trial now?",
      children: <p>Your statements, answers and figures are deleted for good. This can't be undone.</p>,
      confirmLabel: "Delete it now",
      tone: "danger",
    });
    if (ok) {
      del.mutate({ kind: "expire_guest", payload: { client_id: target, why: "by_you" } });
    }
  };

  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>
        <Icon name="guest.banner" fallback="🧪" /> {own ? "Your work isn't saved yet" : "This is an example"} · kept until{" "}
        {formatDate(goes.slice(0, 10))}
      </span>
      <span className={styles.actions}>
        <SaveWorkButton />
        <Button size="sm" variant="ghost" onClick={() => void deleteNow()} disabled={del.isPending}>
          <Icon name="guest.delete" fallback="🗑️" /> Delete it now
        </Button>
      </span>
      {confirmDialog}
    </div>
  );
}
