import { type ReactNode, type Ref, useEffect, useId, useImperativeHandle, useRef } from "react";
import { Icon } from "../../lib/icons";
import { Button } from "../Button";
import { cx } from "../cx";
import styles from "./Modal.module.css";

export interface ModalProps {
  /** Mounted and shown while true; unmounted when false. */
  open: boolean;
  /** Esc, the backdrop and the Close button all call this (unless `dismissable` is false). */
  onClose: () => void;
  title: ReactNode;
  /** An <Icon>/<Emoji> shown before the title. */
  icon?: ReactNode;
  children: ReactNode;
  /** Buttons, right-aligned. Put the main action last. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** "alertdialog" for confirmations that interrupt. */
  role?: "dialog" | "alertdialog";
  /** Names the dialog; defaults to its title. */
  "aria-label"?: string;
  /** False while a command is in flight, so it can't be closed mid-way. */
  dismissable?: boolean;
  ref?: Ref<HTMLDialogElement>;
}

/**
 * The one modal. A native <dialog> opened with showModal(), so the browser traps focus, puts it in the
 * top layer and handles Esc. It renders where it's used (no portal), which keeps it inside the
 * component tree for tests and context.
 */
export function Modal(props: ModalProps) {
  return props.open ? <OpenModal {...props} /> : null;
}

function OpenModal({
  onClose,
  title,
  icon,
  children,
  footer,
  size = "md",
  role = "dialog",
  "aria-label": ariaLabel,
  dismissable = true,
  ref,
}: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useImperativeHandle(ref, () => dialog.current!, []);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    // jsdom has no showModal; the open attribute is enough there.
    if (typeof el.showModal === "function") el.showModal();
    else el.setAttribute("open", "");
    return () => {
      if (typeof el.close === "function" && el.open) el.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      role={role === "alertdialog" ? "alertdialog" : undefined}
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : titleId}
      className={cx(styles.modal, styles[size])}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissable) onClose();
      }}
      onMouseDown={(e) => {
        // A press on the backdrop lands on the <dialog> itself; the panel inside catches every other.
        if (e.target === e.currentTarget && dismissable) onClose();
      }}
    >
      <div className={styles.panel}>
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            {icon}
            {title}
          </h2>
          {dismissable && (
            <Button variant="ghost" size="sm" onClick={onClose} className={styles.close}>
              <Icon name="ui.close" fallback="✖️" /> Close
            </Button>
          )}
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.foot}>{footer}</footer>}
      </div>
    </dialog>
  );
}
