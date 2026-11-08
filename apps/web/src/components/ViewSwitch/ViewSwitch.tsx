import { Link } from "react-router";
import { booksPath } from "../../lib/books";
import { Icon } from "../../lib/icons";
import styles from "./ViewSwitch.module.css";

/**
 * Your view · Accountant view (M21, ADR 015, 2): the owner's screen, and the same business's books
 * as their accountant sees them, read-only. For business owners and guests.
 */
export function ViewSwitch({ businessId, current }: { businessId: string; current: "yours" | "accountant" }) {
  return (
    <nav className={styles.switch} aria-label="View">
      <Link
        to={`/businesses/${businessId}`}
        className={styles.option}
        aria-current={current === "yours" ? "page" : undefined}
      >
        <Icon name="accountant_view.yours" fallback="💰" /> Your view
      </Link>
      <Link
        to={booksPath(businessId)}
        className={styles.option}
        aria-current={current === "accountant" ? "page" : undefined}
      >
        <Icon name="accountant_view.accountant" fallback="📒" /> Accountant view
      </Link>
    </nav>
  );
}
