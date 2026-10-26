import { Link, NavLink, Outlet } from "react-router";
import { isOwner, useCurrentUser, useSignOut } from "../auth";
import { useViewAs } from "../lib/viewAs";
import { HistoryProvider } from "../lib/history";
import { Icon } from "../lib/icons";
import { useLiveRefresh } from "../lib/sync";
import { ThemeToggle } from "../ui";
import { HistoryPanel } from "./HistoryPanel";
import styles from "./Layout.module.css";

export function Layout() {
  const me = useCurrentUser();
  const view = useViewAs();
  const signOut = useSignOut();
  useLiveRefresh();
  return (
    <HistoryProvider>
      <div className={styles.shell}>
        <header className={styles.header}>
          <Link to="/" className={styles.brand}>
            <Icon name="home.brand" fallback="🫘" className={styles.logo} />
            White Label Accounting
          </Link>
          <nav className={styles.nav} aria-label="Main">
            <NavLink to="/" end>
              <Icon name="nav.clients" className={styles.icon} />
              {isOwner(me) ? "Overview" : "Clients"}
            </NavLink>
            <NavLink to="/settings">
              <Icon name="nav.settings" className={styles.icon} />
              Settings
            </NavLink>
          </nav>
          <div className={styles.tools}>
            <ThemeToggle className={styles.tool} />
            <NavLink to="/settings/account" className={styles.user}>
              <Icon name="nav.account" className={styles.icon} />
              {me.display_name} <span className={styles.role}>{me.role}</span>
            </NavLink>
            <button type="button" className={`ghost sm ${styles.tool}`} onClick={() => void signOut()}>
              <Icon name="nav.signout" />
              Sign out
            </button>
          </div>
        </header>
        {view.as && (
          <div className={styles.viewing} role="status">
            <Icon name="nav.view_as" fallback="👁️" /> Viewing as {view.as.replace(/_/g, " ")}. This only changes what you
            see here; you still have your own permissions.{" "}
            <button type="button" onClick={() => view.setAs(null)}>
              Stop viewing as {view.as.replace(/_/g, " ")}
            </button>
          </div>
        )}
        <div className={styles.body}>
          <HistoryPanel />
          <main className={styles.main}>
            <Outlet />
          </main>
        </div>
      </div>
    </HistoryProvider>
  );
}
