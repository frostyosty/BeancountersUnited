import { SiteHeader } from "../components/SiteHeader";
import { Icon } from "../lib/icons";
import { contact } from "../lib/theme";
import styles from "./HomePage.module.css";

export function ContactPage() {
  return (
    <div className={styles.site}>
      <SiteHeader />
      <main>
        <section className={`${styles.section} ${styles.contact}`}>
          <h1 className={styles.sectionTitle}>
            <Icon name="home.contact" fallback="✉️" /> Contact
          </h1>
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
    </div>
  );
}
