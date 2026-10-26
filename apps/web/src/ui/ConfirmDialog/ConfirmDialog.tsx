import { type ReactNode, useCallback, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { Button } from "../Button";
import { Modal } from "../Modal";

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** What will happen, in a sentence or two. */
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" for things that can't be undone (deleting); "primary" otherwise. */
  tone?: "primary" | "danger";
  /** A command in flight: the confirm button spins and the dialog can't be dismissed. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  "aria-label"?: string;
}

/** "Are you sure?" as a modal alertdialog. Focus starts on Cancel, so Enter never confirms by accident. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "primary",
  busy = false,
  onConfirm,
  onCancel,
  "aria-label": ariaLabel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      icon={tone === "danger" ? <Icon name="ui.warning" fallback="⚠️" /> : undefined}
      role="alertdialog"
      size="sm"
      aria-label={ariaLabel}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy} autoFocus>
            {cancelLabel}
          </Button>
          <Button variant={tone} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

export type ConfirmOptions = Omit<ConfirmDialogProps, "open" | "busy" | "onConfirm" | "onCancel">;

/**
 * The imperative form, in place of window.confirm:
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (await confirm({ title: "Delete it?", children: "…", confirmLabel: "Delete", tone: "danger" })) …
 *   …and render {confirmDialog} somewhere in the component.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((yes: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    resolver.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (yes: boolean) => {
    resolver.current?.(yes);
    resolver.current = null;
    setOptions(null);
  };

  const dialog = options ? <ConfirmDialog {...options} open onConfirm={() => settle(true)} onCancel={() => settle(false)} /> : null;
  return [confirm, dialog];
}
