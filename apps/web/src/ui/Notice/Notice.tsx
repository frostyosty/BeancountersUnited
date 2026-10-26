import type { ReactNode } from "react";
import { Icon } from "../../lib/icons";
import { cx } from "../cx";
import styles from "./Notice.module.css";

const icons = {
  info: <Icon name="ui.info" fallback="💡" />,
  ok: <Icon name="ui.ok" fallback="✅" />,
  warn: <Icon name="ui.warning" fallback="⚠️" />,
  danger: <Icon name="ui.warning" fallback="⚠️" />,
};

export interface NoticeProps {
  tone?: keyof typeof icons;
  /** Replaces the tone's icon; pass null for none. */
  icon?: ReactNode;
  role?: "status" | "alert" | "note";
  className?: string;
  children: ReactNode;
}

/** A tinted callout: something to know before going on. */
export function Notice({ tone = "info", icon, role, className, children }: NoticeProps) {
  const glyph = icon === undefined ? icons[tone] : icon;
  return (
    <div className={cx(styles.notice, styles[tone], className)} role={role}>
      {glyph && <span className={styles.icon}>{glyph}</span>}
      <div className={styles.text}>{children}</div>
    </div>
  );
}
