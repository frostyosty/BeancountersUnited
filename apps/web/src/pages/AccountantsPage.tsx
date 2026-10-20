import { SiteHeader } from "../components/SiteHeader";
import { Icon } from "../lib/icons";
import styles from "./HomePage.module.css";

const tools = [
  {
    icon: "home.charts",
    fallback: "🗂️",
    title: "Practice charts",
    body: "A master chart per entity type. Each client starts with their own copy to adjust, and changing a default never alters existing client data.",
  },
  {
    icon: "home.journals",
    fallback: "✍️",
    title: "Journals and bank coding",
    body: "Balanced journals, trial balance import, and GST splits for GST-exclusive ledgers. Posted journals never change; corrections are reversing journals.",
  },
  {
    icon: "home.statements",
    fallback: "📑",
    title: "Statements that foot",
    body: "Whole-dollar statements with prior-year comparatives, rounding lines so every column foots, and drill-down from any line to its accounts.",
  },
  {
    icon: "home.assets",
    fallback: "🏗️",
    title: "Asset register",
    body: "Depreciation journals and the fixed asset schedule, with rates cascading from practice to client to the individual asset.",
  },
  {
    icon: "home.finalise",
    fallback: "🔒",
    title: "Finalise with confidence",
    body: "Signed-off years are stored as a snapshot with a checksum. Only a master user can reopen one, and must give a reason.",
  },
  {
    icon: "home.history",
    fallback: "🕑",
    title: "Who changed what",
    body: "Every change to practice or client data is logged, with roles for master, staff and read-only viewers.",
  },
];

export function AccountantsPage() {
  return (
    <div className={styles.site}>
      <SiteHeader />
      <main>
        <section className={styles.section}>
          <h1 className={styles.sectionTitle}>
            <Icon name="home.accountants" fallback="🧮" /> For accountants
          </h1>
          <p className={styles.sectionLede}>Practice-grade tools, working on the same books your clients see.</p>
          <ul className={styles.grid}>
            {tools.map((t) => (
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
      </main>
    </div>
  );
}
