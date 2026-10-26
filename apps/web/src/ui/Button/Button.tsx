import type { ButtonHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router";
import { cx } from "../cx";
import styles from "./Button.module.css";

export type ButtonVariant = "secondary" | "primary" | "danger" | "ghost";
export type ButtonSize = "md" | "sm";

interface Look {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** The global class names for a button's look (styles/controls.css), so plain markup can match <Button>. */
export function buttonClass({ variant = "secondary", size = "md" }: Look, ...extra: (string | undefined)[]) {
  return cx(variant !== "secondary" && variant, size === "sm" && "sm", ...extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Look {
  /** Shows a spinner and disables the button, for a command in flight. */
  busy?: boolean;
}

/** A button. Defaults to type="button", so it never submits a form by accident. */
export function Button({ variant, size, busy = false, className, type = "button", disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size }, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className={styles.spinner} aria-hidden="true" />}
      {children}
    </button>
  );
}

/** A router link that looks like a button. */
export function ButtonLink({ variant, size, className, ...rest }: LinkProps & Look) {
  return <Link className={buttonClass({ variant, size }, "button", className)} {...rest} />;
}
