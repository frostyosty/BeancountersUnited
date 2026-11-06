import { useState } from "react";
import { useGuest } from "../../auth";
import { Icon } from "../../lib/icons";
import { Button, type ButtonProps } from "../../ui";
import { ClaimForm } from "../ClaimForm";

/** "Save your work": a button that opens the claim form. Renders nothing for anyone who isn't a guest. */
export function SaveWorkButton({ variant = "primary", size = "sm", ...rest }: Omit<ButtonProps, "onClick" | "children">) {
  const guest = useGuest();
  const [open, setOpen] = useState(false);
  if (!guest) {
    return null;
  }
  return (
    <>
      <Button variant={variant} size={size} {...rest} onClick={() => setOpen(true)}>
        <Icon name="guest.save" fallback="💾" /> Save your work
      </Button>
      <ClaimForm open={open} onClose={() => setOpen(false)} hasOwnBusiness={guest.business_id !== null} />
    </>
  );
}

/** Something a guest can't do yet: the reason, and the way to unlock it. Never a dead button. */
export function LockedForGuest({ reason }: { reason: string }) {
  return (
    <p className="muted" role="note">
      <Icon name="guest.locked" fallback="🔒" /> {reason} <SaveWorkButton variant="secondary" />
    </p>
  );
}
