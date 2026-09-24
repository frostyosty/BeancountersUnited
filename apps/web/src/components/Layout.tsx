import type { Me } from "@acct/types/Me";
import { Link, Outlet } from "react-router";
import { useSignOut } from "../auth";
import styles from "./Layout.module.css";

export function Layout({ me }: { me: Me }) {
  const signOut = useSignOut();
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          acct
        </Link>
        <nav className={styles.nav} aria-label="Main" />
        <span className={styles.user}>
          {me.display_name} <span className={styles.role}>{me.role}</span>
        </span>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
