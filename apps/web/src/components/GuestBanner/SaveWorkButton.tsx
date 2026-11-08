import type { ClaimFrom } from "@acct/types/ClaimFrom";
import { useState } from "react";
import { useLocation } from "react-router";
import { useGuest } from "../../auth";
import { Icon } from "../../lib/icons";
import { Button, type ButtonProps } from "../../ui";
import { ClaimForm } from "../ClaimForm";

/** The accountant view's pages: `/businesses/{id}/books` and below (ADR 015, 4). */
const BOOKS_PATH = /^\/businesses\/[^/]+\/books(\/|$)/;

/**
 * "Save your work": a button that opens the claim form. Renders nothing for anyone who isn't a guest.
 * `from` names the prompt it sits in, which the claim records (ADR 015, 4).
 */
export function SaveWorkButton({
  variant = "primary",
  size = "sm",
  from,
  ...rest
}: Omit<ButtonProps, "onClick" | "children"> & { from?: ClaimFrom }) {
  const guest = useGuest();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  if (!guest) {
    return null;
  }
  // The most specific prompt wins: a lock or line passes its own, then the page, then the banner.
  const claimFrom: ClaimFrom = from ?? (BOOKS_PATH.test(pathname) ? "accountant_view" : "banner");
  return (
    <>
      <Button variant={variant} size={size} {...rest} onClick={() => setOpen(true)}>
        <Icon name="guest.save" fallback="💾" /> Save your work
      </Button>
      <ClaimForm open={open} onClose={() => setOpen(false)} hasOwnBusiness={guest.business_id !== null} from={claimFrom} />
    </>
  );
}

/** Something a guest can't do yet: the reason, and the way to unlock it. Never a dead button. */
export function LockedForGuest({ reason, from }: { reason: string; from?: ClaimFrom }) {
  return (
    <p className="muted" role="note">
      <Icon name="guest.locked" fallback="🔒" /> {reason} <SaveWorkButton variant="secondary" from={from} />
    </p>
  );
}
