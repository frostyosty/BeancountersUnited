import type { ReactNode } from "react";
import { Icon } from "../../lib/icons";
import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  /** The button or link that fills it. */
  action?: ReactNode;
}

/** What a list shows before it has anything in it. */
export function EmptyState({ icon = <Icon name="ui.empty" fallback="🗂️" />, title, children, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <span className={styles.icon}>{icon}</span>
      <p className={styles.title}>{title}</p>
      {children && <div className={styles.text}>{children}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
