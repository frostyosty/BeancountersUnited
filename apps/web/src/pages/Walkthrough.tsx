import { Icon } from "../lib/icons";
import { formatDollars } from "../lib/money";
import styles from "./Walkthrough.module.css";

/**
 * A looping animation of the three steps (upload, Save tax, Submit), with a pointer showing where to click.
 * The owner's screen shows it until their first statement is uploaded. It is pure CSS on one shared
 * timeline, so there are no timers, and it holds still for people who ask for reduced motion.
 * The amounts are made up for the demo.
 */
export function Walkthrough() {
  return (
    <figure className={styles.walkthrough}>
      <figcaption className={styles.caption}>
        <Icon name="walkthrough.title" fallback="🎬" /> See how it works
      </figcaption>
      <p className={styles.lede}>Upload a statement, sort a few items, submit. That's it.</p>

      {/* Decorative: the caption and the step labels underneath say the same thing in words. */}
      <div className={styles.stage} aria-hidden="true">
        <div className={`${styles.card} ${styles.c1}`}>
          <span className={styles.step}>1 · Upload</span>
          <span className={styles.file}>
            <Icon name="walkthrough.file" fallback="📄" /> bank-may.csv
          </span>
          <span className={styles.read}>
            <Icon name="business.ok" fallback="✅" /> 42 lines read
          </span>
          <span className={`${styles.button} ${styles.b1}`}>
            <Icon name="business.upload" fallback="📤" /> Choose files
          </span>
        </div>

        <div className={`${styles.card} ${styles.c2}`}>
          <span className={styles.step}>2 · Save tax</span>
          <span className={styles.figures}>
            <span className={styles.f1}>${formatDollars(4200)}</span>
            <span className={styles.f2}>${formatDollars(3100)}</span>
            <span className={styles.f3}>${formatDollars(2650)}</span>
          </span>
          <span className={styles.sorted}>
            <Icon name="walkthrough.sorted" fallback="☕" /> Coffee: work
          </span>
          <span className={`${styles.button} ${styles.primary} ${styles.b2}`}>
            <Icon name="business.save" fallback="✂️" /> Save tax
          </span>
        </div>

        <div className={`${styles.card} ${styles.c3}`}>
          <span className={styles.step}>3 · Submit</span>
          <span className={styles.filed}>
            <Icon name="walkthrough.filed" fallback="🎉" /> Filed with IRD
          </span>
          <span className={`${styles.button} ${styles.b3}`}>
            <Icon name="business.submit" fallback="📨" /> Submit
          </span>
        </div>

        <span className={styles.pointer}>
          <span className={styles.ripple} />
          <svg viewBox="0 0 16 22" width="22" height="30">
            <path d="M1 1 L1 17 L5 13 L8 20 L11 19 L8 12 L14 12 Z" />
          </svg>
        </span>
      </div>

      <ol className={styles.steps}>
        <li>Drop in your bank statement.</li>
        <li>Tell us what a few payments were for, and watch the tax come down.</li>
        <li>Submit to IRD.</li>
      </ol>
    </figure>
  );
}
