import type { ReactNode } from "react";
import { cx } from "../cx";
import styles from "./Badge.module.css";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

/** A small status pill: "open", "finalised", a role. */
export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx(styles.badge, styles[tone], className)}>{children}</span>;
}
