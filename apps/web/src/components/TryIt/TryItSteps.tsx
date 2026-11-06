import type { SaveTaxCard } from "@acct/types/SaveTaxCard";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Icon } from "../../lib/icons";
import { formatMoney } from "../../lib/money";
import { CardBody } from "../../pages/SaveTaxCards";
import { coinCount, flyMoney, noteAction, recentAction, shares } from "./flyMoney";
import { StepPlaceholder } from "./StepState";
import styles from "./TryIt.module.css";
import { MIN_WORK_MS, type GstNote, type TryIt, type TryItState, useReducedMotion } from "./useTryIt";

type Ready = Extract<TryItState, { phase: "ready" }>;

const dollars = (cents: number) => `$${formatMoney(cents)}`;

/** The three steps after Upload, by the step's index in the flow (1 = See your tax). */
export function LaterStep({ index, tryIt }: { index: 1 | 2 | 3; tryIt: TryIt }) {
  const { state } = tryIt;
  if (index === 1) return <SeeYourTax state={state} />;
  if (index === 2) return <SaveTaxStep tryIt={tryIt} />;
  return <FileTaxStep tryIt={tryIt} />;
}

// --- See your tax -----------------------------------------------------------------------------

/** The loader's lines. The count is the file's when we know it. */
export function loaderSteps(lineCount: number | null): string[] {
  const reading = lineCount === null ? "Reading your transactions…" : `Reading ${lineCount} transaction${lineCount === 1 ? "" : "s"}…`;
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
    const timers = steps.slice(1).map((_, i) => setTimeout(() => setActive(i + 1), each * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, [reduced, steps.length]);
  return (
    <div className={styles.loader} role="status" aria-live="polite" aria-busy="true">
      <ol className={styles.loaderSteps}>
        {steps.map((s, i) => (
          <li
            key={s}
            className={`${styles.loaderStep} ${!reduced && i === active ? styles.loaderActive : ""}`}
            data-active={!reduced && i === active ? "true" : undefined}
          >
            {!reduced && i === active && <span aria-hidden="true" className={styles.spinner} />}
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** "Assumed GST registered · change", or why we treated them as registered (ADR 014, 3). */
export function GstLine({ gst, businessId }: { gst: GstNote; businessId: string }) {
  const freq = gst.frequency ? ` · ${gst.frequency}` : "";
  if (!gst.registered) {
    return <p className={styles.gstNote}>Not GST registered{freq}.</p>;
  }
  const change = (
    <Link to={`/businesses/${businessId}/save-tax`} className={styles.inlineLink}>
      change
    </Link>
  );
  if (gst.source === "detected") {
    return (
      <p className={styles.gstNote}>
        <Icon name="home.tax" fallback="💰" /> We spotted {gst.evidence ?? "a GST payment to IRD"}, so we've treated you as GST
        registered{freq}. Not right? {change}
      </p>
    );
  }
  if (gst.source === "assumed") {
    return (
      <p className={styles.gstNote}>
        <Icon name="home.tax" fallback="💰" /> Assumed GST registered{freq} · {change}
      </p>
    );
  }
  if (gst.source === "ird") {
    return (
      <p className={styles.gstNote}>
        <Icon name="home.tax" fallback="💰" /> IRD has you as GST registered{freq}.
      </p>
    );
  }
  return (
    <p className={styles.gstNote}>
      <Icon name="home.tax" fallback="💰" /> GST registered{freq} · {change}
    </p>
  );
}

/**
 * The tax and "saved so far" figures, which count down in step with the coins that fly into the
 * money bag when an answer saves tax. `owed` is what hasn't landed yet.
 */
function useFlyingFigures(tax: number, saved: number, active: boolean, refreshing: boolean) {
  const [owed, setOwed] = useState({ tax: 0, saved: 0 });
  const previous = useRef<{ tax: number; saved: number } | null>(null);
  const reduced = useReducedMotion();
  const cancel = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active) return;
    document.addEventListener("click", noteAction, true);
    return () => document.removeEventListener("click", noteAction, true);
  }, [active]);

  useLayoutEffect(() => {
    if (!active) {
      previous.current = null;
      return;
    }
    // The tax and the queue are fetched separately: wait until both are in so the coins carry the whole change.
    if (refreshing) return;
    const before = previous.current;
    previous.current = { tax, saved };
    if (!before || saved <= before.saved || reduced) return;
    const savedDelta = saved - before.saved;
    const taxDelta = Math.max(0, before.tax - tax);
    const n = coinCount(savedDelta);
    const taxShares = shares(taxDelta, n);
    const savedShares = shares(savedDelta, n);
    cancel.current();
    // Show the old figures straight away, then let each coin take its share off.
    setOwed({ tax: taxDelta, saved: savedDelta });
    const from = recentAction() ?? { x: window.innerWidth / 3, y: window.innerHeight / 2 };
    let left = { tax: taxDelta, saved: savedDelta };
    cancel.current = flyMoney(
      from,
      n,
      (i) => {
        left = { tax: left.tax - taxShares[i], saved: left.saved - savedShares[i] };
        setOwed(left);
      },
      () => setOwed({ tax: 0, saved: 0 }),
    );
  }, [tax, saved, active, reduced, refreshing]);

  useEffect(() => () => cancel.current(), []);

  // Mid-refresh the new figures are only half in: keep showing the last settled ones.
  if (refreshing && previous.current) return previous.current;
  return { tax: tax + owed.tax, saved: saved - owed.saved };
}

function SeeYourTax({ state }: { state: TryItState }) {
  const ready = state.phase === "ready" ? state : null;
  const shown = useFlyingFigures(ready?.tax ?? 0, ready?.savedSoFar ?? 0, ready !== null, ready?.refreshing ?? false);
  if (state.phase === "idle" || state.phase === "error") return <StepPlaceholder state={state} />;
  if (state.phase === "uploading") return <p className={styles.placeholder}>Waiting for your statement…</p>;
  if (state.phase === "working") return <Loader lineCount={state.upload.lineCount} />;
  return (
    <div className={styles.result} aria-live="polite" aria-busy={state.refreshing}>
      <p className={styles.figureLabel}>Tax to pay if you filed today</p>
      <p className={styles.figure} data-testid="try-tax">
        {dollars(shown.tax)}
      </p>
      {shown.saved > 0 ? (
        <p className={styles.saved}>
          <Icon name="business.save_saved" fallback="🎉" /> Saved so far {dollars(shown.saved)}{" "}
          <span className="muted">(it was {dollars(state.conservative)})</span>
        </p>
      ) : (
        <p className="muted">Counts every deposit as income and claims nothing.</p>
      )}
      {state.notices.map((n) => (
        <p key={n.code} className="muted">
          {n.message}
        </p>
      ))}
      <GstLine gst={state.gst} businessId={state.businessId} />
    </div>
  );
}

// --- Save tax ---------------------------------------------------------------------------------

function SaveTaxStep({ tryIt }: { tryIt: TryIt }) {
  const { state } = tryIt;
  if (state.phase === "idle" || state.phase === "error") return <StepPlaceholder state={state} />;
  if (state.phase !== "ready") return <p className={styles.placeholder}>Coming up…</p>;
  return (
    <div className={styles.cards} aria-busy={state.refreshing}>
      {state.cards.length === 0 ? (
        <p className="muted">
          <Icon name="business.save_done" fallback="🥳" /> There's nothing left here that would bring your tax down.
        </p>
      ) : (
        <>
          {state.cards.map((c) => (
            <MiniCard key={c.id} card={c} ready={state} />
          ))}
        </>
      )}
      <Link to={`/businesses/${state.businessId}/save-tax`} onClick={tryIt.enterApp} className={styles.seeAll}>
        <Icon name="business.save" fallback="✂️" /> See all
        {state.moreCards > 0 ? ` (${state.moreCards} more)` : ""}
      </Link>
    </div>
  );
}

/** A Save tax card in place: the real card body, framed with what it could save. */
function MiniCard({ card, ready }: { card: SaveTaxCard; ready: Ready }) {
  return (
    <section className={styles.miniCard} aria-label="Save tax card">
      {card.kind !== "reconcile" && (
        <p className={styles.miniSaving}>
          <Icon name="business.save_saving" fallback="💸" />{" "}
          {card.best_case ? `Could save up to ${dollars(card.saving)}` : `Saves ${dollars(card.saving)}`}
        </p>
      )}
      <CardBody
        card={card}
        clientId={ready.businessId}
        banks={ready.business.bank_accounts}
        gstRegistered={ready.business.gst_registered_from !== null}
        canEdit
      />
    </section>
  );
}

// --- File tax ---------------------------------------------------------------------------------

function FileTaxStep({ tryIt }: { tryIt: TryIt }) {
  const { state } = tryIt;
  if (state.phase === "idle" || state.phase === "error") return <StepPlaceholder state={state} />;
  if (state.phase !== "ready") return <p className={styles.placeholder}>Coming up…</p>;
  return (
    <div className={styles.result}>
      {state.example !== null && <p className="muted">This is an example, so it can't be filed. Try your own statement.</p>}
      <Link to={`/businesses/${state.businessId}`} onClick={tryIt.enterApp} className={styles.reviewLink}>
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
