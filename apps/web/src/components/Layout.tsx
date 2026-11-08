import { Link, NavLink, Outlet } from "react-router";
import { guestBusinessId, isGuest, isOwner, useCurrentUser, useSignOut } from "../auth";
import { HistoryProvider } from "../lib/history";
import { Icon } from "../lib/icons";
import { useLiveRefresh } from "../lib/sync";
import { ActingBanner, ViewedAsNotice } from "./ActingBanner";
import { MoveTrial } from "./ClaimForm";
import { GuestBanner } from "./GuestBanner";
import { HistoryPanel } from "./HistoryPanel";
import styles from "./Layout.module.css";

export function Layout() {
  const me = useCurrentUser();
  const signOut = useSignOut();
  useLiveRefresh();
  const guest = isGuest(me) ? me.guest : null;
  const home = guest ? guestBusinessId(guest) : null;
  return (
    <HistoryProvider>
      <div className={styles.shell}>
        <header className={styles.header}>
          <Link to="/" className={styles.brand}>
            <Icon name="home.brand" fallback="🫘" className={styles.logo} />
            White Label Accounting
          </Link>
          <nav className={styles.nav} aria-label="Main">
            {guest ? (
              home && (
                <NavLink to={`/businesses/${home}`}>
                  <Icon name="business.home" fallback="🏪" className={styles.icon} /> Your business
                </NavLink>
              )
            ) : (
              <>
                <NavLink to="/" end>
                  <Icon name="nav.clients" className={styles.icon} />
                  {isOwner(me) ? "Overview" : "Clients"}
                </NavLink>
                <NavLink to="/settings">
                  <Icon name="nav.settings" className={styles.icon} />
                  Settings
                </NavLink>
              </>
            )}
          </nav>
          <div className={styles.tools}>
            {guest ? (
              <span className={styles.user}>
                <Icon name="nav.account" className={styles.icon} />
                {me.display_name} <span className={styles.role}>trial</span>
              </span>
            ) : (
              <NavLink to="/settings/account" className={styles.user}>
                <Icon name="nav.account" className={styles.icon} />
                {me.display_name} <span className={styles.role}>{me.role.replace(/_/g, " ")}</span>
              </NavLink>
            )}
            <button type="button" className={`ghost sm ${styles.tool}`} onClick={() => void signOut()}>
              <Icon name="nav.signout" />
              {guest ? "Leave and delete your trial" : "Sign out"}
            </button>
          </div>
        </header>
        <ActingBanner />
        <MoveTrial />
        <ViewedAsNotice />
        <div className={styles.body}>
          <HistoryPanel />
          <main className={styles.main}>
            <Outlet />
          </main>
        </div>
        <GuestBanner />
      </div>
    </HistoryProvider>
  );
}
