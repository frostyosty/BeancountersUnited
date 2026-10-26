import { type HTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "../cx";
import styles from "./Card.module.css";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  /** An <Icon>/<Emoji> before the title. */
  icon?: ReactNode;
  /** Buttons or links at the top right. */
  actions?: ReactNode;
  /** "flat" drops the shadow, for cards inside cards. "accent" draws attention. */
  tone?: "default" | "flat" | "accent";
}

/** A raised panel. With a title it's a labelled region, so tests and screen readers can find it by name. */
export function Card({ title, icon, actions, tone = "default", className, children, ...rest }: CardProps) {
  const titleId = useId();
  return (
    <section
      className={cx(styles.card, tone !== "default" && styles[tone], className)}
      aria-labelledby={title ? titleId : undefined}
      {...rest}
    >
      {(title || actions) && (
        <header className={styles.head}>
          {title && (
            <h2 id={titleId} className={styles.title}>
              {icon}
              {title}
            </h2>
          )}
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
