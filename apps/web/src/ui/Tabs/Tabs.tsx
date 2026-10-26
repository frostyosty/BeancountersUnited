import type { ReactNode } from "react";
import { NavLink, type NavLinkProps } from "react-router";
import styles from "./Tabs.module.css";

/** A row of page tabs; each tab is a route (<Tab to="…">), so the URL says which is open. */
export function Tabs({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav className={styles.tabs} aria-label={label}>
      {children}
    </nav>
  );
}

export function Tab(props: NavLinkProps) {
  return <NavLink className={styles.tab} {...props} />;
}
