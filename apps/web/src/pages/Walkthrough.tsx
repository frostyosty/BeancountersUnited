import { useState, type CSSProperties } from "react";
import { Icon } from "../lib/icons";
import { formatDollars } from "../lib/money";
import { Button } from "../ui";
import styles from "./Walkthrough.module.css";

type Mode = "playing" | "paused" | "still";

/** True when the OS or browser asks for less motion (on Windows: Settings › Ease of Access › Show animations). */
function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** Where each confetti piece flies to, in rem from the "Filed" badge, and how far it spins. */
const CONFETTI = Array.from({ length: 14 }, (_, i) => {
  const angle = (i / 14) * 2 * Math.PI - Math.PI / 2;
  const reach = 2.2 + (i % 3) * 0.7;
  return {
    "--x": `${(Math.cos(angle) * reach).toFixed(2)}rem`,
    "--y": `${(Math.sin(angle) * reach * 0.8).toFixed(2)}rem`,
    "--r": `${(i % 2 ? 1 : -1) * (180 + i * 40)}deg`,
  } as CSSProperties;
});

/**
 * A looping animation of the three steps (upload, Save tax, Submit), with a pointer showing where to click.
 * The owner's screen shows it until their first statement is uploaded. It is pure CSS on one shared
 * timeline, so there are no timers. It plays by itself unless the viewer asks for reduced motion; then it
 * holds still on the finished state until they press Play. Either way it can be paused.
 * The amounts are made up for the demo.
 */
export function Walkthrough() {
  const [mode, setMode] = useState<Mode>(() => (prefersReducedMotion() ? "still" : "playing"));
  const playing = mode === "playing";

  return (
    <figure className={styles.walkthrough} data-mode={mode}>
      <div className={styles.head}>
        <figcaption className={styles.caption}>
          <Icon name="walkthrough.title" fallback="🎬" /> See how it works
        </figcaption>
        <Button size="sm" variant="ghost" onClick={() => setMode(playing ? "paused" : "playing")}>
          {playing ? (
            <>
              <Icon name="walkthrough.pause" fallback="⏸️" /> Pause
            </>
          ) : (
            <>
              <Icon name="walkthrough.play" fallback="▶️" /> Play
            </>
          )}
        </Button>
      </div>
      <p className={styles.lede}>Upload a statement, sort a few items, submit. That's it.</p>

      {/* Decorative: the caption and the step labels underneath say the same thing in words. */}
      <div className={styles.stage} aria-hidden="true">
        <div className={`${styles.card} ${styles.c1}`}>
          <span className={styles.step}>1 · Upload</span>
          <span className={styles.file}>
            <Icon name="walkthrough.file" fallback="📄" /> bank-may.csv
          </span>
          <span className={styles.bar}>
            <span className={styles.barFill} />
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
            <span className={`${styles.saved} ${styles.s1}`}>−${formatDollars(1100)}</span>
            <span className={`${styles.saved} ${styles.s2}`}>−${formatDollars(450)}</span>
          </span>
          <span className={`${styles.sorted} ${styles.sorted1}`}>
            <Icon name="walkthrough.sorted" fallback="☕" /> Coffee: work
          </span>
          <span className={`${styles.sorted} ${styles.sorted2}`}>
            <Icon name="walkthrough.sorted2" fallback="🚗" /> Fuel: work
          </span>
          <span className={`${styles.button} ${styles.primary} ${styles.b2}`}>
            <Icon name="business.save" fallback="✂️" /> Save tax
          </span>
        </div>

        <div className={`${styles.card} ${styles.c3}`}>
          <span className={styles.step}>3 · Submit</span>
          <span className={styles.filedWrap}>
            <span className={styles.filed}>
              <Icon name="walkthrough.filed" fallback="🎉" /> Filed with IRD
            </span>
            <span className={styles.confetti}>
              {CONFETTI.map((style, i) => (
                <i key={i} style={style} />
              ))}
            </span>
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
