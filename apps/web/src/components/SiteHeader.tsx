import { Link } from "react-router";
import { Icon } from "../lib/icons";
import styles from "../pages/HomePage.module.css";
import { ThemeToggle } from "../ui";

/** The logged-out site's header, shared by the home, product and pricing pages. */
export function SiteHeader() {
  return (
    <header className={styles.nav}>
      <Link to="/" className={styles.brand}>
        <Icon name="home.brand" fallback="🫘" /> White Label Accounting
      </Link>
      <nav aria-label="Sections" className={styles.links}>
        <Link to="/product">Product</Link>
        <Link to="/pricing">Pricing</Link>
        <Link to="/about">About</Link>
        <Link to="/contact">Contact</Link>
        <Link to="/accountants">For Accountants</Link>
        <ThemeToggle className={styles.navTool} />
        <Link to="/#signin" className={styles.navCta}>
          Sign in
        </Link>
      </nav>
    </header>
  );
}
