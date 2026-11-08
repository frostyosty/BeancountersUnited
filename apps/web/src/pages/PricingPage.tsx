import { Link } from "react-router";
import { GuestBanner } from "../components/GuestBanner";
import { SiteHeader } from "../components/SiteHeader";
import { Icon } from "../lib/icons";
import styles from "./HomePage.module.css";

// Sample prices (NZD, GST inclusive) until real pricing is decided. M24 moves these to the server
// (`GET /api/plans`). Practice plans are arranged with us until practices can sign themselves up.
type Tier = {
  name: string;
  audience: string;
  price: string;
  per: string;
  featured?: boolean;
  talkToUs?: boolean;
  perks: string[];
};

const tiers: Tier[] = [
  {
    name: "Free",
    audience: "For owners getting started",
    price: "$0",
    per: "forever",
    perks: [
      "1 business",
      "Unlimited bank statement uploads",
      "Up to 100,000 invoice uploads",
      "Your tax-to-pay figure, any day",
      "Save tax walkthrough",
      "One button to file GST returns with IRD",
      "One button to file income tax returns with IRD",
      "Real double-entry books underneath",
      "Statements with last year alongside",
      "History of who changed what",
    ],
  },
  {
    name: "Owner",
    audience: "For owners who want more help",
    price: "$4.99",
    per: "per month",
    featured: true,
    perks: ["Everything in Free", "Up to 3 businesses", "More AI suggestions each day", "Unlimited invoice uploads"],
  },
  {
    name: "Practice",
    audience: "For accountants and bookkeepers",
    price: "$9.99",
    per: "per month, up to 25 clients",
    talkToUs: true,
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
    price: "$24.99",
    per: "per month, unlimited clients",
    talkToUs: true,
    perks: ["Everything in Practice", "Unlimited clients", "Import from Xero and MYOB", "Priority support"],
  },
];

const faqs = [
  ["Is the Free plan really free?", "Yes. No card needed, no time limit, and your data stays yours."],
  ["Can I switch plans?", "Any time. Upgrade when you're ready to file, and drop back down afterwards."],
  ["Will these prices change?", "They'll only stay this low. Or they might even go lower."],
];

export function PricingPage() {
  return (
    <div className={styles.site}>
      <SiteHeader />
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
                {t.talkToUs ? (
                  <Link to="/accountants" className={styles.planCta}>
                    Talk to us
                  </Link>
                ) : (
                  <Link to="/#signin" className={styles.planCta}>
                    {t.price === "$0" ? "Start free" : "Sign in to get started"}
                  </Link>
                )}
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
      <GuestBanner />
    </div>
  );
}
