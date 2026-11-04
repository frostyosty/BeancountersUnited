import { formatDate } from "../../lib/dates";
import type { TryItState } from "./useTryIt";
import styles from "./TryIt.module.css";

/** The Upload step's result: file name, bank, period and line count, or the error. */
export function UploadResult({ state }: { state: TryItState }) {
  if (state.phase === "idle") return null;
  if (state.phase === "error") {
    return (
      <p className={styles.stepError} role="alert">
        {state.message}
      </p>
    );
  }
  const u = state.upload;
  const bits = [
    u.bank,
    u.periodStart && u.periodEnd ? `${formatDate(u.periodStart)} to ${formatDate(u.periodEnd)}` : null,
    u.lineCount !== null ? `${u.lineCount} transactions` : null,
  ].filter(Boolean);
  return (
    <p className={styles.stepResult} role="status">
      <strong>{u.fileName}</strong>
      {bits.length > 0 && <> · {bits.join(" · ")}</>}
      {state.phase === "uploading" && <> · reading…</>}
    </p>
  );
}

/** The three later steps this wave: a placeholder until Agent 5 fills them in. */
export function StepPlaceholder({ state }: { state: TryItState }) {
  if (state.phase === "idle" || state.phase === "error") {
    return <p className={styles.placeholder}>Fills in when you add a statement.</p>;
  }
  return <p className={styles.placeholder}>Coming up…</p>;
}
