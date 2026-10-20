import { Link } from "react-router";
import { Icon } from "../lib/icons";
import { contact } from "../lib/theme";
import { LoginPage } from "./LoginPage";
import styles from "./HomePage.module.css";

const features = [
  {
    icon: "home.upload",
    fallback: "📤",
    title: "Upload your bank statements",
    body: "Drop in a statement and your transactions are ready to sort. No re-typing.",
  },
  {
    icon: "home.tax",
    fallback: "💰",
    title: "See your tax, any day",
    body: "A cautious estimate of the tax you'd pay if you filed today, so there are no surprises.",
  },
  {
    icon: "home.save",
    fallback: "✂️",
    title: "Save tax",
    body: "Step through your spending and categorise it properly to bring that figure down.",
  },
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
    body: "A visible history of every change, and finalised years stay locked unless a master user reopens them.",
  },
];

const accountantTools = [
  {
    icon: "home.charts",
    fallback: "🗂️",
    title: "Practice charts",
    body: "A master chart per entity type. Each client starts with their own copy to adjust.",
  },
  {
    icon: "home.journals",
    fallback: "✍️",
    title: "Journals and bank coding",
    body: "Balanced journals, trial balance import, and GST splits for GST-exclusive ledgers.",
  },
  {
    icon: "home.assets",
    fallback: "🏗️",
    title: "Asset register",
    body: "Depreciation journals and the fixed asset schedule, with rates you control.",
  },
  {
    icon: "home.finalise",
    fallback: "🔒",
    title: "Finalise with confidence",
    body: "Signed-off years are stored as a snapshot, with prior-year comparatives and PDF output.",
  },
];

const steps = [
  { title: "Upload", body: "Add your bank statements." },
  { title: "Review", body: "See the tax you'd pay right now." },
  { title: "Save tax", body: "Categorise to bring it down." },
  { title: "Submit", body: "File your GST and income tax returns." },
];

export function HomePage() {
  return (
    <div className={styles.site}>
      <header className={styles.nav}>
        <a href="#top" className={styles.brand}>
          <Icon name="home.brand" fallback="🫘" /> White Label Accounting
        </a>
        <nav aria-label="Sections" className={styles.links}>
          <Link to="/product">Product</Link>
          <a href="#accountants">Accountants</a>
          <Link to="/pricing">Pricing</Link>
          <a href="#about">About</a>
          <a href="#contact">Contact</a>
          <a href="#how">How it works</a>
          <a href="#signin" className={styles.navCta}>
            Sign in
          </a>
        </nav>
      </header>

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
          <h2 className={styles.sectionTitle}>Built for owners and their accountants</h2>
          <p className={styles.sectionLede}>One place for the everyday and the year-end.</p>
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

        <section id="how" className={`${styles.section} ${styles.how}`}>
          <h2 className={styles.sectionTitle}>How it works</h2>
          <ol className={styles.steps}>
            {steps.map((s, i) => (
              <li key={s.title} className={styles.step}>
                <span className={styles.stepNo}>{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="accountants" className={`${styles.section} ${styles.how}`}>
          <h2 className={styles.sectionTitle}>For accountants</h2>
          <p className={styles.sectionLede}>Practice-grade tools, working on the same books your clients see.</p>
          <ul className={`${styles.grid} ${styles.accountants}`}>
            {accountantTools.map((t) => (
              <li key={t.title} className={styles.feature}>
                <span className={styles.featureIcon}>
                  <Icon name={t.icon} fallback={t.fallback} />
                </span>
                <h3>{t.title}</h3>
                <p>{t.body}</p>
              </li>
            ))}
          </ul>
        </section>


        <section id="about" className={`${styles.section} ${styles.about}`}>
          <h2 className={styles.sectionTitle}>
            <Icon name="home.about" fallback="🥝" /> About White Label Accounting
          </h2>
          <p>
            White Label Accounting is online accounting for New Zealand small businesses and the accountants who look after them. Owners
            get a clear picture of their tax and simple ways to reduce it. Accountants get proper double-entry books,
            statements and year-end finalisation.
          </p>
          <p>
            Both work from the same ledger, so there is one set of numbers, one history of who changed what, and nothing
            to reconcile between the two.
          </p>
        </section>

        <section id="contact" className={`${styles.section} ${styles.contact}`}>
          <h2 className={styles.sectionTitle}>
            <Icon name="home.contact" fallback="✉️" /> Contact
          </h2>
          <p className={styles.sectionLede}>Questions? We'd love to hear from you. (Sample details for now.)</p>
          <ul className={styles.contactList}>
            <li>
              <Icon name="home.email" fallback="📧" /> <a href={`mailto:${contact.email}`}>{contact.email}</a>
            </li>
            <li>
              <Icon name="home.phone" fallback="📞" /> {contact.phone}
            </li>
            <li>
              <Icon name="home.address" fallback="📍" /> {contact.address}
            </li>
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
