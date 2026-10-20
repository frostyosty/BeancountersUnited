import { SiteHeader } from "../components/SiteHeader";
import { Icon } from "../lib/icons";
import styles from "./HomePage.module.css";

const rows = (items: [string, string][]) =>
  items.map(([label, amount]) => (
    <div key={label} className={styles.mockRow}>
      <span>{label}</span>
      <span>{amount}</span>
    </div>
  ));

export function ProductPage() {
  return (
    <div className={styles.site}>
      <SiteHeader />
      <main>
        <section className={styles.section}>
          <h1 className={styles.sectionTitle}>
            <Icon name="home.product" fallback="🧭" /> Product walkthrough
          </h1>
          <p className={styles.sectionLede}>Illustrative mock-ups with made-up numbers.</p>
          <ul className={styles.grid}>
            <li className={styles.mock}>
              <h3>
                <Icon name="home.save" fallback="✂️" /> Save tax
              </h3>
              {rows([
                ["Tax if you filed today", "$4,820"],
                ["Home office (categorised)", "−$310"],
                ["Vehicle expenses (categorised)", "−$540"],
              ])}
              <div className={`${styles.mockRow} ${styles.mockTotal}`}>
                <span>New estimate</span>
                <span>$3,970</span>
              </div>
            </li>
            <li className={styles.mock}>
              <h3>
                <Icon name="home.statements" fallback="📑" /> Statements
              </h3>
              {rows([
                ["Income", "$98,400"],
                ["Expenses", "$61,250"],
              ])}
              <div className={`${styles.mockRow} ${styles.mockTotal}`}>
                <span>Net profit</span>
                <span>$37,150</span>
              </div>
            </li>
            <li className={styles.mock}>
              <h3>
                <Icon name="home.assets" fallback="🏗️" /> Asset register
              </h3>
              {rows([
                ["Delivery van", "$18,000"],
                ["Depreciation this year", "$3,600"],
              ])}
              <div className={`${styles.mockRow} ${styles.mockTotal}`}>
                <span>Book value</span>
                <span>$14,400</span>
              </div>
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
