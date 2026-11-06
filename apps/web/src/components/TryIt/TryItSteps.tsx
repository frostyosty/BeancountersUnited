import type { SaveTaxCard } from "@acct/types/SaveTaxCard";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Icon } from "../../lib/icons";
import { formatMoney } from "../../lib/money";
import { CardBody } from "../../pages/SaveTaxCards";
import { StepPlaceholder } from "./StepState";
import styles from "./TryIt.module.css";
import {
  MIN_WORK_MS,
  type GstNote,
  type TryIt,
  type TryItState,
  useReducedMotion,
} from "./useTryIt";

type Ready = Extract<TryItState, { phase: "ready" }>;

const dollars = (cents: number) => `$${formatMoney(cents)}`;

/** The three steps after Upload, by the step's index in the flow (1 = See your tax). */
export function LaterStep({
  index,
  tryIt,
}: {
  index: 1 | 2 | 3;
  tryIt: TryIt;
}) {
  if (index === 1) return <SeeYourTax tryIt={tryIt} />;
  if (index === 2) return <SaveTaxStep tryIt={tryIt} />;
  return <FileTaxStep tryIt={tryIt} />;
}

// --- See your tax -----------------------------------------------------------------------------

/** The loader's lines. The count is the file's when we know it. */
export function loaderSteps(lineCount: number | null): string[] {
  const reading =
    lineCount === null
      ? "Reading your transactions…"
      : `Reading ${lineCount} transaction${lineCount === 1 ? "" : "s"}…`;
  return [reading, "Working out GST…", "Income tax…"];
}

/**
 * The loader: one line lights up after another over the minimum wait. With reduced motion there's no
 * animation: the lines are plain text.
 */
export function Loader({ lineCount }: { lineCount: number | null }) {
  const reduced = useReducedMotion();
  const steps = loaderSteps(lineCount);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const each = MIN_WORK_MS / steps.length;
    const timers = steps
      .slice(1)
      .map((_, i) => setTimeout(() => setActive(i + 1), each * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, [reduced, steps.length]);
  return (
    <div
      className={styles.loader}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <ol className={styles.loaderSteps}>
        {steps.map((s, i) => (
          <li
            key={s}
            className={`${styles.loaderStep} ${!reduced && i === active ? styles.loaderActive : ""}`}
            data-active={!reduced && i === active ? "true" : undefined}
          >
            {!reduced && i === active && (
              <span aria-hidden="true" className={styles.spinner} />
            )}
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** "Assumed GST registered · change", or why we treated them as registered (ADR 014, 3). */
export function GstLine({
  gst,
  businessId,
}: {
  gst: GstNote;
  businessId: string;
}) {
  const freq = gst.frequency ? ` · ${gst.frequency}` : "";
  if (!gst.registered) {
    return <p className={styles.gstNote}>Not GST registered{freq}.</p>;
  }
  const change = (
    <Link
      to={`/businesses/${businessId}/save-tax`}
      className={styles.inlineLink}
    >
      change
    </Link>
  );
  if (gst.source === "detected") {
    return (
      <p className={styles.gstNote}>
        <Icon name="home.tax" fallback="💰" /> We spotted{" "}
        {gst.evidence ?? "a GST payment to IRD"}, so we've treated you as GST
        registered{freq}. Not right? {change}
      </p>
    );
  }
  if (gst.source === "assumed") {
    return (
      <p className={styles.gstNote}>
        <Icon name="home.tax" fallback="💰" /> Assumed GST registered{freq} ·{" "}
        {change}
      </p>
    );
  }
  if (gst.source === "ird") {
    return (
      <p className={styles.gstNote}>
        <Icon name="home.tax" fallback="💰" /> IRD has you as GST registered
        {freq}.
      </p>
    );
  }
  return (
    <p className={styles.gstNote}>
      <Icon name="home.tax" fallback="💰" /> GST registered{freq} · {change}
    </p>
  );
}

function SeeYourTax({ tryIt }: { tryIt: TryIt }) {
  const { state, shown } = tryIt;
  if (state.phase === "idle" || state.phase === "error")
    return <StepPlaceholder state={state} />;
  if (state.phase === "uploading")
    return <p className={styles.placeholder}>Waiting for your statement…</p>;
  if (state.phase === "working")
    return <Loader lineCount={state.upload.lineCount} />;
  return (
    <div
      className={styles.result}
      aria-live="polite"
      aria-busy={state.refreshing}
    >
      <p className={styles.figureLabel}>Tax to pay if you filed today</p>
      <p className={styles.figure} data-testid="try-tax">
        {dollars(shown.tax)}
      </p>
      <p className="muted">
        Counts every deposit as income and claims nothing.
      </p>
      {state.notices.map((n) => (
        <p key={n.code} className="muted">
          {n.message}
        </p>
      ))}
      <GstLine gst={state.gst} businessId={state.businessId} />
    </div>
  );
}

/** The section that appears beside See your tax: what the answers have saved. The coins land here. */
export function TaxSavedCard({ tryIt }: { tryIt: TryIt }) {
  const { state, shown } = tryIt;
  if (state.phase !== "ready") return null;
  return (
    <div className={styles.result} aria-live="polite">
      <p className={styles.figureLabel}>Saved by your answers</p>
      <p
        className={`${styles.figure} ${styles.savedFigure}`}
        data-testid="try-saved"
      >
        {dollars(shown.saved)}
      </p>
      {shown.saved > 0 ? (
        <p className="muted">
          <Icon name="business.save_saved" fallback="🎉" /> It was{" "}
          {dollars(state.conservative)} before you answered.
        </p>
      ) : (
        <p className="muted">Answer a question and watch it grow.</p>
      )}
    </div>
  );
}

// --- Save tax ---------------------------------------------------------------------------------

function SaveTaxStep({ tryIt }: { tryIt: TryIt }) {
  const { state } = tryIt;
  // The card the visitor clicked on: it gets more width and the others squish over.
  const [featured, setFeatured] = useState<string | null>(null);
  if (state.phase === "idle" || state.phase === "error")
    return <StepPlaceholder state={state} />;
  if (state.phase !== "ready")
    return <p className={styles.placeholder}>Coming up…</p>;
  return (
    <div className={styles.cards} aria-busy={state.refreshing}>
      {state.cards.length === 0 ? (
        <p className="muted">
          <Icon name="business.save_done" fallback="🥳" /> There's nothing left
          here that would bring your tax down.
        </p>
      ) : (
        <>
          {state.cards.map((c) => (
            <MiniCard
              key={c.id}
              card={c}
              ready={state}
              featured={featured === c.id}
              onFeature={() => setFeatured((f) => (f === c.id ? null : c.id))}
            />
          ))}
        </>
      )}
      <Link
        to={`/businesses/${state.businessId}/save-tax`}
        onClick={tryIt.enterApp}
        className={styles.seeAll}
      >
        <Icon name="business.save" fallback="✂️" /> See all
        {state.moreCards > 0 ? ` (${state.moreCards} more)` : ""}
      </Link>
    </div>
  );
}

/** Clicks on these belong to the control, so they don't feature the card. */
const CONTROLS = "button, a, input, select, textarea, label, summary";

/**
 * A Save tax card in place: the real card body, framed with what it could save. Tall cards are
 * clipped, with a chevron to open them; clicking the card elsewhere gives it more width.
 */
function MiniCard({
  card,
  ready,
  featured,
  onFeature,
}: {
  card: SaveTaxCard;
  ready: Ready;
  featured: boolean;
  onFeature: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(0);
  const [clipped, setClipped] = useState(false);
  const clip = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const inner = content.current;
    const outer = clip.current;
    if (!inner || !outer) return;
    const measure = () => {
      setFull(inner.offsetHeight);
      // Clipped when the content is taller than the collapsed box (max-height is in CSS).
      setClipped(
        inner.offsetHeight > outer.clientHeight + 1 ||
          (open && outer.clientHeight < inner.offsetHeight),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [open]);

  const showToggle = clipped || open;
  return (
    <section
      className={`${styles.miniCard} ${featured ? styles.miniFeatured : ""}`}
      aria-label="Save tax card"
      onClick={(e) => {
        if (!(e.target as Element).closest(CONTROLS)) onFeature();
      }}
      onFocus={(e) => {
        if (e.target.matches?.(":focus-visible")) setOpen(true);
      }}
    >
      <div
        ref={clip}
        className={`${styles.miniClip} ${clipped && !open ? styles.miniFade : ""}`}
        style={open && full > 0 ? { maxHeight: `${full}px` } : undefined}
      >
        <div ref={content}>
          {card.kind !== "reconcile" && (
            <p className={styles.miniSaving}>
              <Icon name="business.save_saving" fallback="💸" />{" "}
              {card.best_case
                ? `Could save up to ${dollars(card.saving)}`
                : `Saves ${dollars(card.saving)}`}
            </p>
          )}
          <CardBody
            card={card}
            clientId={ready.businessId}
            banks={ready.business.bank_accounts}
            gstRegistered={ready.business.gst_registered_from !== null}
            canEdit
          />
        </div>
      </div>
      {showToggle && (
        <button
          type="button"
          className={styles.miniMore}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span
            aria-hidden="true"
            className={`${styles.chevron} ${open ? styles.chevronUp : ""}`}
          >
            ▾
          </span>{" "}
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </section>
  );
}

// --- File tax ---------------------------------------------------------------------------------

function FileTaxStep({ tryIt }: { tryIt: TryIt }) {
  const { state } = tryIt;
  if (state.phase === "idle" || state.phase === "error")
    return <StepPlaceholder state={state} />;
  if (state.phase !== "ready")
    return <p className={styles.placeholder}>Coming up…</p>;
  return (
    <div className={styles.result}>
      {state.example !== null && (
        <p className="muted">
          This is an example, so it can't be filed. Try your own statement.
        </p>
      )}
      <Link
        to={`/businesses/${state.businessId}`}
        onClick={tryIt.enterApp}
        className={styles.reviewLink}
      >
        <Icon name="business.submit" fallback="📨" /> Review your return
      </Link>
    </div>
  );
}

/** The Upload step's error, with a way to try again. */
export function RetryButton({ tryIt }: { tryIt: TryIt }) {
  if (tryIt.state.phase !== "error") return null;
  return (
    <button type="button" className={styles.retry} onClick={tryIt.retry}>
      Try again
    </button>
  );
}
