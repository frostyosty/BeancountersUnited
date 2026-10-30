import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { formatDate, parseDateInput } from "../../lib/dates";
import { Icon } from "../../lib/icons";
import { cx } from "../cx";
import { DatePicker } from "./DatePicker";
import styles from "./DateField.module.css";

export interface DateFieldProps {
  /** The visible label. Leave it out only where the row already says what the date is, and pass aria-label. */
  label?: string;
  "aria-label"?: string;
  /** An ISO date (`YYYY-MM-DD`), or "" for none. */
  value: string;
  /** Called with an ISO date once the box holds a whole, real date, or "" when it's emptied. */
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  className?: string;
}

/**
 * A date box: type a date the NZ way (31/3/2026, 31 Mar 26…) or open the calendar. Use it for every date
 * the app asks for, instead of <input type="date">, whose picker is small and slow to move between years.
 */
export function DateField({
  label,
  "aria-label": ariaLabel,
  value,
  onChange,
  min,
  max,
  required,
  disabled,
  hint,
  className,
}: DateFieldProps) {
  const id = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value ? formatDate(value) : "");
  const [picking, setPicking] = useState(false);
  // Say what's wrong only once they've left the box, not while they're halfway through typing.
  const [left, setLeft] = useState(false);
  const name = label ?? ariaLabel ?? "date";

  // Follow the value when it changes from outside (a preset, a reset), but not while it matches what's typed.
  useEffect(() => {
    const typed = draft.trim() === "" ? "" : parseDateInput(draft);
    if (typed !== value) setDraft(value ? formatDate(value) : "");
  }, [value]);

  const parsed = draft.trim() === "" ? "" : parseDateInput(draft);
  const problem =
    parsed === null
      ? "Enter a date like 31/03/2026"
      : parsed && min && parsed < min
        ? `Choose ${formatDate(min)} or later`
        : parsed && max && parsed > max
          ? `Choose ${formatDate(max)} or earlier`
          : "";

  useEffect(() => {
    input.current?.setCustomValidity(problem);
  }, [problem]);

  function type(text: string) {
    setDraft(text);
    const iso = text.trim() === "" ? "" : parseDateInput(text);
    if (iso !== null && iso !== value) onChange(iso);
  }

  return (
    <div className={cx("field", styles.field, className)}>
      {label && (
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
      )}
      <div className={styles.control}>
        <input
          ref={input}
          id={id}
          aria-label={label ? undefined : ariaLabel}
          aria-describedby={hint ? hintId : undefined}
          aria-invalid={problem ? true : undefined}
          className={styles.input}
          value={draft}
          placeholder="dd/mm/yyyy"
          autoComplete="off"
          spellCheck={false}
          required={required}
          disabled={disabled}
          onChange={(e) => {
            setLeft(false);
            type(e.target.value);
          }}
          onBlur={() => {
            setLeft(true);
            if (parsed) setDraft(formatDate(parsed));
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && e.altKey) {
              e.preventDefault();
              setPicking(true);
            }
          }}
        />
        <button
          type="button"
          className={styles.open}
          aria-label={`Choose ${name} from a calendar`}
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={() => setPicking(true)}
        >
          <Icon name="ui.calendar" fallback="📅" />
          <span className={styles.openText}>Calendar</span>
        </button>
      </div>
      {problem && left && <small className={styles.problem}>{problem}</small>}
      {hint && (
        <small id={hintId} className={styles.hint}>
          {hint}
        </small>
      )}
      <DatePicker
        open={picking}
        title={label ?? ariaLabel ?? "Choose a date"}
        value={parsed || value}
        min={min}
        max={max}
        onClose={() => {
          setPicking(false);
          input.current?.focus();
        }}
        onPick={(iso) => {
          setPicking(false);
          setDraft(formatDate(iso));
          if (iso !== value) onChange(iso);
          input.current?.focus();
        }}
      />
    </div>
  );
}
