import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  MONTH_NAMES,
  WEEKDAYS,
  addDays,
  addMonths,
  clampDate,
  daysInMonth,
  formatDate,
  formatLongDate,
  isoOf,
  monthGrid,
  partsOf,
  startOfWeek,
  todayIso,
  withYear,
} from "../../lib/dates";
import { Icon } from "../../lib/icons";
import { Button } from "../Button";
import { cx } from "../cx";
import { Modal } from "../Modal";
import styles from "./DatePicker.module.css";

export interface DatePickerProps {
  open: boolean;
  /** What the date is for, such as "Disposal date". */
  title: string;
  /** The date shown first: an ISO date, or "" to start on today. */
  value: string;
  min?: string;
  max?: string;
  onPick: (iso: string) => void;
  onClose: () => void;
}

type View = "days" | "months" | "years";

const YEARS_PER_PAGE = 12;

/** The calendar behind <DateField>: a large modal with a day grid, plus month and year grids for jumping. */
export function DatePicker(props: DatePickerProps) {
  return props.open ? <OpenPicker {...props} /> : null;
}

function OpenPicker({ title, value, min, max, onPick, onClose }: DatePickerProps) {
  const today = todayIso(new Date());
  const [cursor, setCursor] = useState(() => clampDate(value || today, min, max));
  const [view, setView] = useState<View>("days");
  const grid = useRef<HTMLDivElement>(null);
  const { year, month } = partsOf(cursor);

  // Focus the highlighted day (or month, or year) on opening and on each change of view. The timeout lets
  // the dialog do its own focusing first.
  useEffect(() => {
    const t = setTimeout(() => grid.current?.querySelector<HTMLButtonElement>("[tabindex='0']")?.focus(), 0);
    return () => clearTimeout(t);
  }, [view]);

  const outOfRange = (iso: string) => (min !== undefined && iso < min) || (max !== undefined && iso > max);
  const monthOutOfRange = (y: number, m: number) =>
    (min !== undefined && isoOf(y, m, daysInMonth(y, m)) < min) || (max !== undefined && isoOf(y, m, 1) > max);
  const yearOutOfRange = (y: number) =>
    (min !== undefined && isoOf(y, 12, 31) < min) || (max !== undefined && isoOf(y, 1, 1) > max);

  function moveTo(iso: string, focus: boolean) {
    const next = clampDate(iso, min, max);
    setCursor(next);
    if (focus) {
      setTimeout(() => grid.current?.querySelector<HTMLButtonElement>(`[data-date='${next}']`)?.focus(), 0);
    }
  }

  function onDayKey(e: KeyboardEvent) {
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      Home: () => startOfWeek(cursor),
      End: () => addDays(startOfWeek(cursor), 6),
      PageUp: () => addMonths(cursor, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(cursor, e.shiftKey ? 12 : 1),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    moveTo(move(), true);
  }

  function step(by: -1 | 1) {
    if (view === "days") moveTo(addMonths(cursor, by), false);
    else moveTo(withYear(cursor, year + by * (view === "months" ? 1 : YEARS_PER_PAGE)), false);
  }

  const firstYear = Math.floor(year / YEARS_PER_PAGE) * YEARS_PER_PAGE;
  const weeks = monthGrid(year, month);
  const shortcuts = [
    { label: "Today", iso: today },
    ...(min ? [{ label: `First day · ${formatDate(min)}`, iso: min }] : []),
    ...(max ? [{ label: `Last day · ${formatDate(max)}`, iso: max }] : []),
  ].filter((s) => !outOfRange(s.iso));
  const stepNames = {
    days: ["Previous month", "Next month"],
    months: ["Previous year", "Next year"],
    years: ["Earlier years", "Later years"],
  }[view];

  return (
    <Modal
      open
      size="md"
      onClose={onClose}
      title={title}
      icon={<Icon name="ui.calendar" fallback="📅" />}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <p className={styles.chosen} aria-live="polite">
        {formatLongDate(cursor)}
      </p>
      <p className={styles.help}>
        {view === "days" && "Tap a day to choose it. Tap the month or the year to jump further."}
        {view === "months" && "Choose a month."}
        {view === "years" && "Choose a year, then a month."}
      </p>

      <div className={styles.nav}>
        <Button className={styles.step} aria-label={stepNames[0]} onClick={() => step(-1)}>
          ‹
        </Button>
        <div className={styles.jumps}>
          <button
            type="button"
            className={cx(styles.jump, view === "months" && styles.jumpOn)}
            aria-pressed={view === "months"}
            aria-label={`Month: ${MONTH_NAMES[month - 1]}. Choose another`}
            onClick={() => setView(view === "months" ? "days" : "months")}
          >
            {MONTH_NAMES[month - 1]} <span aria-hidden="true">▾</span>
          </button>
          <button
            type="button"
            className={cx(styles.jump, view === "years" && styles.jumpOn)}
            aria-pressed={view === "years"}
            aria-label={`Year: ${year}. Choose another`}
            onClick={() => setView(view === "years" ? "days" : "years")}
          >
            {view === "years" ? `${firstYear}–${firstYear + YEARS_PER_PAGE - 1}` : year} <span aria-hidden="true">▾</span>
          </button>
        </div>
        <Button className={styles.step} aria-label={stepNames[1]} onClick={() => step(1)}>
          ›
        </Button>
      </div>

      <div ref={grid}>
        {view === "days" && (
          <div role="grid" aria-label={`${MONTH_NAMES[month - 1]} ${year}`} className={styles.days} onKeyDown={onDayKey}>
            <div role="row" className={styles.week}>
              {WEEKDAYS.map((d) => (
                <span key={d} role="columnheader" className={styles.weekday}>
                  {d}
                </span>
              ))}
            </div>
            {[0, 1, 2, 3, 4, 5].map((w) => (
              <div role="row" key={weeks[w * 7]} className={styles.week}>
                {weeks.slice(w * 7, w * 7 + 7).map((iso) => (
                  <span role="gridcell" key={iso} aria-selected={iso === value}>
                    <button
                      type="button"
                      data-date={iso}
                      tabIndex={iso === cursor ? 0 : -1}
                      disabled={outOfRange(iso)}
                      aria-label={formatLongDate(iso)}
                      aria-current={iso === today ? "date" : undefined}
                      className={cx(
                        styles.day,
                        partsOf(iso).month !== month && styles.otherMonth,
                        iso === today && styles.today,
                        iso === value && styles.selected,
                        iso === cursor && styles.cursor,
                      )}
                      onClick={() => onPick(iso)}
                    >
                      {partsOf(iso).day}
                    </button>
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}

        {view === "months" && (
          <div className={styles.choices}>
            {MONTH_NAMES.map((name, i) => (
              <button
                key={name}
                type="button"
                tabIndex={i + 1 === month ? 0 : -1}
                disabled={monthOutOfRange(year, i + 1)}
                className={cx(styles.choice, i + 1 === month && styles.selected)}
                onClick={() => {
                  moveTo(addMonths(cursor, i + 1 - month), false);
                  setView("days");
                }}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        {view === "years" && (
          <div className={styles.choices}>
            {Array.from({ length: YEARS_PER_PAGE }, (_, i) => firstYear + i).map((y) => (
              <button
                key={y}
                type="button"
                tabIndex={y === year ? 0 : -1}
                disabled={yearOutOfRange(y)}
                className={cx(styles.choice, y === partsOf(today).year && styles.today, y === year && styles.selected)}
                onClick={() => {
                  moveTo(withYear(cursor, y), false);
                  setView("months");
                }}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </div>

      {shortcuts.length > 0 && (
        <div className={styles.shortcuts}>
          {shortcuts.map((s) => (
            <Button key={s.label} size="sm" onClick={() => onPick(s.iso)}>
              {s.label}
            </Button>
          ))}
        </div>
      )}
    </Modal>
  );
}
