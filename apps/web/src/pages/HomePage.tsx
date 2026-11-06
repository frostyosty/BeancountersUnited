import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router";
import { SiteHeader } from "../components/SiteHeader";
import { ExampleLinks, ExamplesPanel } from "../components/TryIt/ExamplesPanel";
import { UploadResult } from "../components/TryIt/StepState";
import { LaterStep, RetryButton, TaxSavedCard } from "../components/TryIt/TryItSteps";
import { UploadDrop } from "../components/TryIt/UploadDrop";
import { useExamples, useIsDesktop } from "../components/TryIt/useExamples";
import { useReducedMotion, useTryIt } from "../components/TryIt/useTryIt";
import { Icon } from "../lib/icons";
import { formatMoney } from "../lib/money";
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
    icon: "business.save",
    fallback: "✂️",
    title: "Save tax",
    body: "Step through your spending and categorise it properly to bring that figure down.",
    next: "one click",
  },
  {
    icon: "business.bank",
    fallback: "🏛️",
    title: "File tax",
    body: "No-nonsense direct submission to the IRD.",
    next: "",
  },
];

const features = [
  {
    icon: "nav.clients",
    fallback: "📒",
    title: "Real double-entry books",
    body: "Every business-year has a proper ledger underneath, so your accountant can pick up where you left off.",
  },
  {
    icon: "business.save_supply",
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

  const examples = useExamples();
  const tryIt = useTryIt(examples);
  const desktop = useIsDesktop();
  // Once a statement is in, the examples go and the steps re-arrange around the answers.
  const dropped = ["uploading", "working", "ready"].includes(tryIt.state.phase);

  // When a statement goes in, the steps slide to their new places rather than jumping, and the page
  // scrolls so the whole row is in view. Positions are remembered after every render (FLIP).
  const reduced = useReducedMotion();
  const flowRef = useRef<HTMLOListElement>(null);
  const rects = useRef(new Map<Element, DOMRect>());
  const wasDropped = useRef(false);
  const ready = tryIt.state.phase === "ready";
  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const items = Array.from(flow.children);
    if (dropped && !wasDropped.current && !reduced && typeof Element.prototype.animate === "function") {
      for (const el of items) {
        const before = rects.current.get(el);
        if (!before) continue;
        const after = el.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (dx || dy) {
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
            duration: 600,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          });
        }
      }
    }
    if (dropped && !wasDropped.current) flow.scrollIntoView?.({ behavior: reduced ? "auto" : "smooth", block: "start" });
    wasDropped.current = dropped;
  }, [dropped, reduced]);
  useLayoutEffect(() => {
    // Runs after every render: the positions the next change will slide from.
    const flow = flowRef.current;
    if (!flow) return;
    rects.current = new Map(Array.from(flow.children).map((el) => [el, el.getBoundingClientRect()]));
  });

  // The hero ticket: Example 1's real conservative figure, from the server. Clicking it loads that example
  // exactly as a drop would and scrolls to the flow.
  const example1 = examples.find((e) => e.number === 1);
  const loadHeroExample = () => {
    tryIt.useExample(1);
    document.getElementById("features")?.scrollIntoView?.({ behavior: "smooth" });
  };

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
            <button type="button" className={styles.ticket} onClick={loadHeroExample} disabled={!example1}>
              <span className={styles.ticketLabel}>Example: tax if you filed today</span>
              <span className={styles.ticketAmount} data-testid="hero-amount">
                {example1 ? `$${formatMoney(example1.conservative_tax)}` : "…"}
              </span>
              <span className={styles.ticketSave}>
                <Icon name="home.tax" fallback="💰" /> Save tax could bring this down
              </span>
            </button>
          </div>
          <div className={styles.heroCard}>
            <LoginPage id="signin" />
          </div>
        </section>

        <section id="features" className={styles.section}>
          <h2 className={styles.sectionTitle}>From bank statement to IRD</h2>
          <p className={styles.sectionLede}>Four steps, hardly any clicking.</p>
          <div className={`${styles.tryLayout} ${dropped ? styles.tryDropped : ""}`}>
            <ol ref={flowRef} className={`${styles.flow} ${dropped ? styles.flowDropped : ""}`}>
              {steps.map((s, i) => (
                <li key={s.title} className={`${styles.flowItem} ${styles[`step${i}`]}`}>
                  <div className={styles.feature}>
                    <span className={styles.featureIcon} >
                      <Icon name={s.icon} fallback={s.fallback} />
                    </span>
                    <h3>{s.title}</h3>
                    {!(dropped && i === 2) && <p>{s.body}</p>}
                    {i === 0 ? (
                      <>
                        {!desktop && <ExampleLinks examples={examples} />}
                        <UploadDrop onExample={tryIt.useExample} onFile={tryIt.useFile} />
                        <UploadResult state={tryIt.state} />
                        <RetryButton tryIt={tryIt} />
                      </>
                    ) : (
                      <LaterStep index={i as 1 | 2 | 3} tryIt={tryIt} />
                    )}
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
              {dropped && ready && (
                <li key="saved" className={`${styles.flowItem} ${styles.step4}`}>
                  <div className={`${styles.feature} ${styles.slideIn}`}>
                    <span className={styles.featureIcon} data-money-bag="">
                      <Icon name="business.save_saved" fallback="💰" />
                    </span>
                    <h3>Tax saved</h3>
                    <TaxSavedCard tryIt={tryIt} />
                  </div>
                </li>
              )}
            </ol>
            {desktop && !dropped && examples.length > 0 && <ExamplesPanel examples={examples} />}
          </div>
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
