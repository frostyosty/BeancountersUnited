import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import styles from "./PageHeader.module.css";

export interface Crumb {
  to: string;
  label: ReactNode;
}

export interface PageHeaderProps {
  /** The way back up: each a link, separated by slashes. */
  crumbs?: Crumb[];
  title: ReactNode;
  /** An <Icon>/<Emoji> before the title. */
  icon?: ReactNode;
  /** A <Badge> after the title (outside the <h1>, so it isn't part of the heading's name). */
  badge?: ReactNode;
  subtitle?: ReactNode;
  /** Buttons at the top right. */
  actions?: ReactNode;
}

/** The top of every app page: breadcrumbs, the title, and the page's main actions. */
export function PageHeader({ crumbs, title, icon, badge, subtitle, actions }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className={styles.crumbs}>
          {crumbs.map((c, i) => (
            <Fragment key={i}>
              <Link to={c.to}>{c.label}</Link>
              <span aria-hidden="true" className={styles.sep}>
                /
              </span>
            </Fragment>
          ))}
        </nav>
      )}
      <div className={styles.main}>
        <div className={styles.text}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>
              {icon}
              {title}
            </h1>
            {badge}
          </div>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </header>
  );
}
