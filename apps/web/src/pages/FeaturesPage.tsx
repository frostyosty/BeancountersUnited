import { Link } from "react-router";
import { GuestBanner } from "../components/GuestBanner";
import { SiteHeader } from "../components/SiteHeader";
import { Badge, type Target, TrialLink } from "../components/TryIt/TrialLink";
import { type TrialPath, useOpenInTrial } from "../components/TryIt/useOpenInTrial";
import { booksPath } from "../lib/books";
import { Icon } from "../lib/icons";
import home from "./HomePage.module.css";
import styles from "./FeaturesPage.module.css";

const overview: TrialPath = (id) => `/businesses/${id}`;
const saveTax: TrialPath = (id) => `/businesses/${id}/save-tax`;

/** The four steps, as on the home page. Each opens that part of a trial. */
const steps: { key: string; icon: string; fallback: string; title: string; body: string; target: Target; next: string }[] = [
  {
    key: "step-upload",
    icon: "business.upload",
    fallback: "📤",
    title: "Upload bank statements",
    body: "Drop in a statement and your transactions are ready to sort. No re-typing.",
    target: { home: true },
    next: "one click",
  },
  {
    key: "step-tax",
    icon: "home.tax",
    fallback: "💰",
    title: "See your tax, any day",
    body: "A cautious estimate of the tax you'd pay if you filed today, so there are no surprises.",
    target: { trial: overview },
    next: "a few clicks",
  },
  {
    key: "step-save",
    icon: "business.save",
    fallback: "✂️",
    title: "Save tax",
    body: "Step through your spending and categorise it properly to bring that figure down.",
    target: { trial: saveTax },
    next: "one click",
  },
  {
    key: "step-file",
    icon: "business.bank",
    fallback: "🏛️",
    title: "File tax",
    body: "No-nonsense direct submission to the IRD.",
    target: { trial: overview },
    next: "",
  },
];

/**
 * A feature in the detail list. `account`: it needs a free account (every plan has it). `soon`: not
 * built yet. A feature with a target can be seen on an example even when it's locked there.
 */
interface Feature {
  title: string;
  body: string;
  target?: Target;
  account?: boolean;
  soon?: boolean;
}

const groups: { icon: string; fallback: string; title: string; features: Feature[] }[] = [
  {
    icon: "business.upload",
    fallback: "📤",
    title: "Getting your numbers in",
    features: [
      {
        title: "Bank statements from your bank",
        body: "Drop in an OFX, QIF or CSV file. Each statement lands in its own bank account, ready to sort.",
        target: { home: true },
      },
      {
        title: "Checks it for you",
        body: "Gaps between statements, transfers between your own accounts, payments to IRD and possible duplicates are all spotted and flagged.",
        target: { trial: overview },
      },
      {
        title: "Bring your history from Xero and MYOB",
        body: "Move past years across, so this year's figures start from the right place.",
        soon: true,
      },
      {
        title: "Invoice scanner",
        body: "Snap a receipt or invoice. It's read, checked and matched to the right bank line.",
        soon: true,
      },
    ],
  },
  {
    icon: "business.tax",
    fallback: "💰",
    title: "Knowing your tax",
    features: [
      {
        title: "Tax to pay if you filed today",
        body: "Income tax and GST together, worked out cautiously and kept up to date as you go.",
        target: { trial: overview },
      },
      {
        title: "GST worked out for you",
        body: "It spots from your statements whether you're GST registered and how often you file.",
        target: { trial: saveTax },
      },
    ],
  },
  {
    icon: "business.save",
    fallback: "✂️",
    title: "Saving tax",
    features: [
      {
        title: "Save tax questions",
        body: "Plain questions about your spending, one card at a time. Each answer shows what it saved you.",
        target: { trial: saveTax },
      },
      {
        title: "Suggestions",
        body: "What each line probably is, from your own history first and an AI model only after that. Off until you turn it on.",
        target: { trial: saveTax },
        account: true,
      },
    ],
  },
  {
    icon: "business.submit",
    fallback: "📨",
    title: "Filing",
    features: [
      {
        title: "Review your return",
        body: "See exactly what you'd file before anything goes to IRD.",
        target: { trial: overview },
      },
      {
        title: "File GST and income tax with IRD",
        body: "One button, straight to IRD.",
        account: true,
        soon: true,
      },
    ],
  },
  {
    icon: "ui.empty",
    fallback: "📒",
    title: "Proper books underneath",
    features: [
      {
        title: "The accountant view",
        body: "The books your accountant sees: statements, trial balance, journals, general ledger and asset register.",
        target: { trial: (id) => booksPath(id, "statements") },
      },
      {
        title: "Statements as a PDF",
        body: "Whole-dollar statements with last year alongside, ready to print or send.",
        target: { trial: (id) => booksPath(id, "statements") },
        account: true,
      },
      {
        title: "Who changed what",
        body: "Every change, who made it, and what it did to your tax.",
        target: { trial: (id) => booksPath(id, "changes") },
      },
    ],
  },
  {
    icon: "business.invite",
    fallback: "🤝",
    title: "Working with your accountant",
    features: [
      {
        title: "Invite your accountant",
        body: "Send them a link. They work in the same books, so nothing gets typed in twice.",
        target: { trial: overview },
        account: true,
      },
    ],
  },
  {
    icon: "tools.invoice",
    fallback: "🧾",
    title: "Handy extras",
    features: [
      {
        title: "Invoice maker",
        body: "Make a tidy invoice for a customer and download it. Saved to your account, separate from your books.",
        account: true,
      },
    ],
  },
];

function Badges({ f }: { f: Feature }) {
  return (
    <span className={styles.badges}>
      {f.account && <Badge kind="free" />}
      {f.soon && <Badge kind="soon" />}
      {!f.account && !f.soon && <Badge kind="try" />}
    </span>
  );
}

export function FeaturesPage() {
  const o = useOpenInTrial();
  return (
    <div className={home.site}>
      <SiteHeader />
      <main>
        <section className={home.section}>
          <h1 className={home.sectionTitle}>
            <Icon name="defaults.ranges" fallback="🧭" /> Features
          </h1>
          <p className={home.sectionLede}>
            Everything it does. Click any of it to try it on an example, with no sign-up.
          </p>
          {o.error && (
            <p role="alert" className={styles.error}>
              <Icon name="ui.warning" fallback="⚠️" /> {o.error}
            </p>
          )}

          <h2 className={styles.subTitle}>From bank statement to IRD</h2>
          <ol className={styles.steps}>
            {steps.map((s) => (
              <li key={s.key} className={styles.stepItem}>
                <div className={`${home.feature} ${styles.step}`}>
                  <span className={home.featureIcon}>
                    <Icon name={s.icon} fallback={s.fallback} />
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                  <TrialLink o={o} id={s.key} target={s.target} />
                </div>
                {s.next && (
                  <div className={styles.arrow}>
                    <span aria-hidden="true" className={styles.arrowGlyph} />
                    <span>{s.next}</span>
                  </div>
                )}
              </li>
            ))}
          </ol>

          <h2 className={styles.subTitle}>In more detail</h2>
          <div className={styles.groups}>
            {groups.map((g) => (
              <section key={g.title} className={styles.group} aria-label={g.title}>
                <h3 className={styles.groupTitle}>
                  <span className={home.featureIcon}>
                    <Icon name={g.icon} fallback={g.fallback} />
                  </span>
                  {g.title}
                </h3>
                <ul className={styles.list}>
                  {g.features.map((f) => (
                    <li key={f.title} className={styles.item}>
                      <div className={styles.itemHead}>
                        <h4>{f.title}</h4>
                        <Badges f={f} />
                      </div>
                      <p>{f.body}</p>
                      {f.target && <TrialLink o={o} id={f.title} target={f.target} />}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <aside className={styles.not}>
            <h2>
              <Icon name="ui.info" fallback="ℹ️" /> What it doesn't do
            </h2>
            <p>
              No payroll and no foreign currencies. It's for sole traders for now; companies, partnerships and trusts
              come later.
            </p>
          </aside>

          <p className={styles.more}>
            <Link to="/accountants">
              <Icon name="layouts.statements" fallback="🧮" /> Are you an accountant? See what's there for you
            </Link>
            <Link to="/pricing">
              <Icon name="business.save_categorise" fallback="🏷️" /> See pricing
            </Link>
          </p>
        </section>
      </main>
      <GuestBanner />
    </div>
  );
}
