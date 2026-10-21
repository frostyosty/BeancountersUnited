import { useEffect } from "react";
import { useLocation } from "react-router";
import { SiteHeader } from "../components/SiteHeader";
import { Icon } from "../lib/icons";
import { LoginPage } from "./LoginPage";
import styles from "./HomePage.module.css";

// `next` is the label on the arrow leading to the following step.
const steps = [
  {
    icon: "home.upload",
    fallback: "📤",
    title: "Upload bank statements",
    body: "Drop in a statement and your transactions are ready to sort. No re-typing.",
    next: "one click",
  },
  {
    icon: "home.tax",
    fallback: "💰",
    title: "See your tax, any day",
    body: "A cautious estimate of the tax you'd pay if you filed today, so there are no surprises.",
    next: "a few clicks",
  },
  {
    icon: "home.save",
    fallback: "✂️",
    title: "Save tax",
    body: "Step through your spending and categorise it properly to bring that figure down.",
    next: "one click",
  },
  {
    icon: "home.file",
    fallback: "🏛️",
    title: "File tax",
    body: "No-nonsense direct submission to the IRD.",
    next: "",
  },
];

const features = [
  {
    icon: "home.books",
    fallback: "📒",
    title: "Real double-entry books",
    body: "Every business-year has a proper ledger underneath, so your accountant can pick up where you left off.",
  },
  {
    icon: "home.statements",
    fallback: "📑",
    title: "Statements that foot",
    body: "Whole-dollar statements with last year alongside, balanced to the dollar, drill down to any account.",
  },
  {
    icon: "home.history",
    fallback: "🕑",
    title: "Who changed what",
    body: "A supremely intuitive history of every change, and finalised years stay locked.",
  },
];

export function HomePage() {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <div className={styles.site}>
      <SiteHeader />

      <main id="top">
        <section className={styles.hero}>
          <div className={styles.heroText}>
            <p className={styles.eyebrow}>Online accounting for NZ small business</p>
            <h1 className={styles.headline}>Know your tax before the tax man does.</h1>
            <p className={styles.lede}>
              Upload your bank statements, see what you'd owe if you filed today, then cut it down. Your accountant gets
              proper books underneath.
            </p>
            <div className={styles.ticket} aria-label="Example">
              <span className={styles.ticketLabel}>Example: tax if you filed today</span>
              <span className={styles.ticketAmount}>$4,820</span>
              <span className={styles.ticketSave}>
                <Icon name="home.tax" fallback="💰" /> Save tax could bring this down
              </span>
            </div>
          </div>
          <div className={styles.heroCard}>
            <LoginPage id="signin" />
          </div>
        </section>

        <section id="features" className={styles.section}>
          <h2 className={styles.sectionTitle}>From bank statement to IRD</h2>
          <p className={styles.sectionLede}>Four steps, hardly any clicking.</p>
          <ol className={styles.flow}>
            {steps.map((s) => (
              <li key={s.title} className={styles.flowItem}>
                <div className={styles.feature}>
                  <span className={styles.featureIcon}>
                    <Icon name={s.icon} fallback={s.fallback} />
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
                {s.next && (
                  <div className={styles.arrow}>
                    <span aria-hidden="true" className={styles.arrowGlyph}>
                      ↓
                    </span>
                    <span>{s.next}</span>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section id="accountants" className={styles.section}>
          <h2 className={styles.sectionTitle}>The boring stuff, for accountants</h2>
          <p className={styles.sectionLede}>Proper books underneath, so nothing is lost when you hand over.</p>
          <ul className={styles.grid}>
            {features.map((f) => (
              <li key={f.title} className={styles.feature}>
                <span className={styles.featureIcon}>
                  <Icon name={f.icon} fallback={f.fallback} />
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
        </section>





      </main>

      <footer className={styles.footer}>
        <span>
          <Icon name="home.brand" fallback="🫘" /> White Label Accounting
        </span>
        <a href="#top">Back to top</a>
      </footer>
    </div>
  );
}
