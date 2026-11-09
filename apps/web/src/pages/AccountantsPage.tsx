import { Link } from "react-router";
import { GuestBanner } from "../components/GuestBanner";
import { PracticeRequestButton } from "../components/PracticeRequest";
import { SiteHeader } from "../components/SiteHeader";
import { type Access, Badge, TrialLink } from "../components/TryIt/TrialLink";
import { useOpenInTrial } from "../components/TryIt/useOpenInTrial";
import { type BooksView, booksPath } from "../lib/books";
import { Icon } from "../lib/icons";
import styles from "./AccountantsPage.module.css";
import features from "./FeaturesPage.module.css";
import home from "./HomePage.module.css";

/** The accountant view's screens (M21), each opened on the visitor's trial or Example 1. */
const screens: { view: BooksView; icon: string; fallback: string; title: string; body: string }[] = [
  {
    view: "statements",
    icon: "year.statements",
    fallback: "📑",
    title: "Statements that foot",
    body: "Whole dollars with last year alongside, rounding lines so every column foots, and drill-down from any line to its accounts.",
  },
  {
    view: "tb",
    icon: "year.tb",
    fallback: "⚖️",
    title: "Trial balance",
    body: "Every account mapped to a report line. An unmapped account is flagged, never quietly dropped.",
  },
  {
    view: "journals",
    icon: "ui.empty",
    fallback: "⏳️",
    title: "Journals",
    body: "Balanced, dated inside the year, and never changed once posted. Corrections are reversing journals.",
  },
  {
    view: "gl",
    icon: "year.gl",
    fallback: "🏭",
    title: "General ledger",
    body: "Every entry behind every account, so you can see where each balance came from.",
  },
  {
    view: "assets",
    icon: "year.assets",
    fallback: "🏗️",
    title: "Asset register",
    body: "Depreciation from your firm's rates, a client override, or a rate on the asset itself, with the fixed asset schedule.",
  },
  {
    view: "changes",
    icon: "history.changes",
    fallback: "🕑",
    title: "Who changed what",
    body: "Every change, who made it and when, and what it did to the tax.",
  },
];

/** What each side does, for "Will my clients mess up the books?". */
const yourClient = [
  "Uploads their bank statements",
  "Answers plain Save tax questions to sort their spending",
  "Watches their tax figure come down",
  "Invites you in when they're ready",
];
const you = [
  "Check and correct how they've sorted things",
  "Post adjusting journals, depreciation, or a trial balance import",
  "Add accounting policies and notes from your own paragraph library",
  "Finalise the year and send the PDF",
];

const guardrails: { icon: string; fallback: string; text: string }[] = [
  {
    icon: "guest.locked",
    fallback: "🔒",
    text: "Owners can't post journals, edit the chart or change a finalised year. They see your screens read-only.",
  },
  {
    icon: "history.changes",
    fallback: "🕑",
    text: "Everything they do shows in Changes, with who did it and what it did to the tax.",
  },
  {
    icon: "ui.ok",
    fallback: "✅",
    text: "Every journal balances and every statement foots. The server checks it, not just the screen.",
  },
  {
    icon: "home.finalise",
    fallback: "🔐",
    text: "Once you finalise a year, nobody can change its numbers until an admin at your firm reopens it, with a reason.",
  },
];

/** What a firm's account adds, in the behaviour accountants already know. */
const firmTools: { title: string; body: string; access: Access }[] = [
  {
    title: "Master charts",
    body: "One per entity type. Each client starts with their own copy, and changing yours never alters an existing client.",
    access: "firm",
  },
  {
    title: "Report layouts",
    body: "Account-code ranges map to report lines, and a layout per entity type sets them out. Overlapping ranges and unmapped accounts are flagged.",
    access: "firm",
  },
  {
    title: "Paragraph library",
    body: "Your own wording for accounting policies and notes, picked per client and filled in for them.",
    access: "firm",
  },
  {
    title: "Trial balance import",
    body: "Bring in a TB from elsewhere. Re-importing replaces only the import, so your adjustments stay put.",
    access: "firm",
  },
  {
    title: "Finalise and sign off",
    body: "Finalising stores the statements exactly as signed, with a fingerprint, so a printout can always be matched to its year.",
    access: "firm",
  },
  {
    title: "Your team",
    body: "Admins, staff and read-only users, each seeing what their role allows.",
    access: "firm",
  },
  {
    title: "Bring clients from Xero and MYOB",
    body: "Move your clients' past years across, so their first year here starts from the right balances.",
    access: "soon",
  },
];

export function AccountantsPage() {
  const o = useOpenInTrial();
  return (
    <div className={home.site}>
      <SiteHeader />
      <main>
        <section className={home.section}>
          <h1 className={home.sectionTitle}>
            <Icon name="accountant_view.accountant" fallback="📊" /> For accountants
          </h1>
          <p className={home.sectionLede}>
            Your clients sort their own bank statements. You get proper books underneath, and the final say.
          </p>
          <p className={styles.cta}>
            <PracticeRequestButton from="accountants_page" variant="primary" />
          </p>
          {o.error && (
            <p role="alert" className={features.error}>
              <Icon name="ui.warning" fallback="⚠️" /> {o.error}
            </p>
          )}

          <h2 className={features.subTitle}>The books, on an example</h2>
          <p className={styles.lede}>Click any of them. It's the real thing, read-only, with made-up figures.</p>
          <ul className={home.grid}>
            {screens.map((s) => (
              <li key={s.view} className={home.tileItem}>
                <button
                  type="button"
                  className={`${home.feature} ${home.tile}`}
                  aria-busy={o.opening === s.view}
                  onClick={() => o.open(s.view, (id) => booksPath(id, s.view))}
                >
                  <span className={home.featureIcon}>
                    <Icon name={s.icon} fallback={s.fallback} />
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                  <span className={home.tileGo}>
                    <Icon name="peaks.open" fallback="➡️" />{" "}
                    {o.opening === s.view ? "Opening…" : o.hasTrial ? "Open it" : "See it on an example"}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <aside className={styles.sample}>
            <span className={home.featureIcon}>
              <Icon name="year.statements" fallback="📑" />
            </span>
            <div>
              <h3>See what you'd send a client</h3>
              <p>A sole trader's statements and notes, exactly as the PDF prints them. Made-up figures.</p>
            </div>
            <a className={styles.sampleLink} href="/samples/sample-statements.pdf" target="_blank" rel="noopener">
              <Icon name="proof.print" fallback="⬇️" /> Download the sample PDF
            </a>
          </aside>

          <h2 className={features.subTitle} id="mess">
            Will my clients mess up the books?
          </h2>
          <p className={styles.lede}>
            No. They do the sorting; you keep the books. Each side has its own job.
          </p>
          <div className={styles.split}>
            <section className={styles.side} aria-labelledby="client-does">
              <h3 id="client-does">
                <Icon name="business.home" fallback="🏪" /> Your client
              </h3>
              <ul>
                {yourClient.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
            <section className={styles.side} aria-labelledby="you-do">
              <h3 id="you-do">
                <Icon name="accountant_view.accountant" fallback="📊" /> You
              </h3>
              <ul>
                {you.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
          </div>
          <ul className={styles.guardrails}>
            {guardrails.map((g) => (
              <li key={g.text}>
                <Icon name={g.icon} fallback={g.fallback} /> <span>{g.text}</span>
              </li>
            ))}
          </ul>
          <p className={styles.lede}>
            <TrialLink o={o} id="mess-changes" target={{ trial: (id) => booksPath(id, "changes") }} />
          </p>

          <h2 className={features.subTitle}>Works the way you already work</h2>
          <p className={styles.lede}>What your firm's account adds, on top of everything above.</p>
          <section className={features.group} aria-label="With a firm account">
            <ul className={features.list}>
              {firmTools.map((t) => (
                <li key={t.title} className={features.item}>
                  <div className={features.itemHead}>
                    <h4>{t.title}</h4>
                    <span className={features.badges}>
                      <Badge kind={t.access} />
                    </span>
                  </div>
                  <p>{t.body}</p>
                </li>
              ))}
            </ul>
          </section>

          <div className={styles.join}>
            <h2>
              <Icon name="practice_request.practice" fallback="🏭" /> Bring your firm on board
            </h2>
            <p>
              We're setting firms up by hand for now. Tell us about yours and we'll be in touch. Your clients can
              already start on their own, and invite you in when they're ready.
            </p>
            <p className={styles.cta}>
              <PracticeRequestButton from="accountants_page" variant="primary" />
            </p>
            <p className={features.more}>
              <Link to="/features">
                <Icon name="defaults.ranges" fallback="🧭" /> What your clients see
              </Link>
              <Link to="/pricing">
                <Icon name="business.save_categorise" fallback="🏷️" /> See pricing
              </Link>
            </p>
          </div>
        </section>
      </main>
      <GuestBanner />
    </div>
  );
}
