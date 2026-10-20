import { Link } from "react-router";
import { Icon } from "../lib/icons";
import styles from "./HomePage.module.css";

// Sample prices (NZD, GST inclusive) until real pricing is decided.
const tiers = [
  {
    name: "Free",
    audience: "For owners getting started",
    price: "$0",
    per: "forever",
    perks: [
      "1 business",
      "Unlimited bank statement uploads",
      "Your tax-to-pay figure, any day",
      "Real double-entry books underneath",
      "Statements with last year alongside",
    ],
  },
  {
    name: "Owner",
    audience: "For owners who want to pay less tax",
    price: "$9",
    per: "per month",
    featured: true,
    perks: [
      "Everything in Free",
      "Save tax walkthrough",
      "File GST and income tax returns with IRD",
      "Up to 3 businesses",
      "History of who changed what",
    ],
  },
  {
    name: "Practice",
    audience: "For accountants and bookkeepers",
    price: "$19",
    per: "per month, up to 25 clients",
    perks: [
      "Everything in Owner",
      "Practice master charts and templates",
      "Journals, TB import and bank coding",
      "Asset register and depreciation",
      "Finalisation snapshots and PDF output",
      "Unlimited staff and viewer users",
    ],
  },
  {
    name: "Practice Plus",
    audience: "For larger practices",
    price: "$49",
    per: "per month, unlimited clients",
    perks: ["Everything in Practice", "Unlimited clients", "Import from Xero and MYOB", "Priority support"],
  },
];

const faqs = [
  ["Is the Free plan really free?", "Yes. No card needed, no time limit, and your data stays yours."],
  ["Can I switch plans?", "Any time. Upgrade when you're ready to file, and drop back down afterwards."],
  ["Are these final prices?", "These are sample prices while we finish the product. They'll only stay this low or go lower."],
];

export function PricingPage() {
  return (
    <div className={styles.site}>
      <header className={styles.nav}>
        <Link to="/" className={styles.brand}>
          <Icon name="home.brand" fallback="🫘" /> White Label Accounting
        </Link>
        <nav aria-label="Sections" className={styles.links}>
          <Link to="/">Home</Link>
          <Link to="/product">Product</Link>
          <Link to="/#signin" className={styles.navCta}>
            Sign in
          </Link>
        </nav>
      </header>
      <main>
        <section className={styles.section}>
          <h1 className={styles.sectionTitle}>
            <Icon name="home.pricing" fallback="🏷️" /> Pricing
          </h1>
          <p className={styles.sectionLede}>Generous free plan. Paid plans that cost less than a coffee a week.</p>
          <ul className={`${styles.grid} ${styles.tiers}`}>
            {tiers.map((t) => (
              <li key={t.name} className={`${styles.feature} ${t.featured ? styles.featured : ""}`}>
                <h3>{t.name}</h3>
                <p>{t.audience}</p>
                <p className={styles.price}>
                  {t.price} <small>{t.per}</small>
                </p>
                <ul className={styles.perks}>
                  {t.perks.map((perk) => (
                    <li key={perk}>
                      <Icon name="home.check" fallback="✅" /> {perk}
                    </li>
                  ))}
                </ul>
                <Link to="/#signin" className={styles.planCta}>
                  {t.price === "$0" ? "Start free" : "Sign in to get started"}
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section className={`${styles.section} ${styles.about}`}>
          <h2 className={styles.sectionTitle}>
            <Icon name="home.faq" fallback="💬" /> Questions
          </h2>
          {faqs.map(([q, a]) => (
            <div key={q}>
              <h3>{q}</h3>
              <p>{a}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
