import type { Me } from "@acct/types/Me";
import { Link, NavLink, Outlet } from "react-router";
import { useSignOut } from "../auth";
import { Icon } from "../lib/icons";
import { useLiveRefresh } from "../lib/sync";
import styles from "./Layout.module.css";

export function Layout({ me }: { me: Me }) {
  const signOut = useSignOut();
  useLiveRefresh();
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          acct
        </Link>
        <nav className={styles.nav} aria-label="Main">
          <NavLink to="/" end>
            <Icon name="nav.clients" className={styles.icon} />
            Clients
          </NavLink>
          {me.role === "master" && (
            <NavLink to="/settings">
              <Icon name="nav.settings" className={styles.icon} />
              Practice settings
            </NavLink>
          )}
        </nav>
        <NavLink to="/account" className={styles.user}>
          <Icon name="nav.account" className={styles.icon} />
          {me.display_name} <span className={styles.role}>{me.role}</span>
        </NavLink>
        <button type="button" onClick={() => void signOut()}>
          <Icon name="nav.signout" className={styles.icon} />
          Sign out
        </button>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
