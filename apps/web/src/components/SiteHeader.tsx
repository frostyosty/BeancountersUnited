import { Link } from "react-router";
import { guestBusinessId, useGuest } from "../auth";
import { Icon } from "../lib/icons";
import styles from "../pages/HomePage.module.css";
import { SaveWorkButton } from "./GuestBanner";

/** The logged-out site's header, shared by the home, features, accountants and pricing pages. */
export function SiteHeader() {
  const guest = useGuest();
  const home = guest ? guestBusinessId(guest) : null;
  return (
    <>
    <header className={styles.nav}>
      <Link to="/" className={styles.brand}>
        <Icon name="home.brand" fallback="🫘" /> White Label Accounting
      </Link>
      <nav aria-label="Sections" className={styles.links}>
        <Link to="/features">Features</Link>
        <Link to="/accountants">For accountants</Link>
        <Link to="/pricing">Pricing</Link>
        <Link to="/about">About</Link>
        <Link to="/contact">Contact</Link>
        {guest ? (
          <>
            {home && (
              <Link to={`/businesses/${home}`} className={styles.navCta}>
                <Icon name="business.home" fallback="🏪" /> Your business
              </Link>
            )}
            <SaveWorkButton />
          </>
        ) : (
          <Link to="/#signin" className={styles.navCta}>
            Sign in
          </Link>
        )}
      </nav>
    </header>
    </>
  );
}
