import { SiteHeader } from "../components/SiteHeader";
import { Icon } from "../lib/icons";
import styles from "./HomePage.module.css";

const steps = [
  { title: "Upload", body: "Add your bank statements." },
  { title: "Review", body: "See the tax you'd pay right now." },
  { title: "Save tax", body: "Categorise to bring it down." },
  { title: "Submit", body: "File your GST and income tax returns." },
];

export function AboutPage() {
  return (
    <div className={styles.site}>
      <SiteHeader />
      <main>
        <section className={`${styles.section} ${styles.about}`}>
          <h1 className={styles.sectionTitle}>
            <Icon name="home.about" fallback="🥝" /> About White Label Accounting
          </h1>
          <p>
            White Label Accounting is online accounting for New Zealand small businesses and the accountants who look
            after them. Owners get a clear picture of their tax and simple ways to reduce it. Accountants get proper
            double-entry books, statements and year-end finalisation.
          </p>
          <p>
            Both work from the same ledger, so there is one set of numbers, one history of who changed what, and nothing
            to reconcile between the two.
          </p>
        </section>
        <section className={styles.section}>
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
      </main>
    </div>
  );
}
