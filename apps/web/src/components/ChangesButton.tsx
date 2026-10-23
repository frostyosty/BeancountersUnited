import { type FigureFilter, useHistoryContext } from "../lib/history";
import { Icon } from "../lib/icons";
import styles from "./HistoryPanel.module.css";

/** A small button beside a figure: lists the changes that moved it in the history panel (M13). */
export function ChangesButton({ figure }: { figure: FigureFilter }) {
  const { showChanges } = useHistoryContext();
  return (
    <button
      type="button"
      className={styles.changesButton}
      onClick={() => showChanges(figure)}
      aria-label={`What changed ${figure.label}`}
      title={`What changed ${figure.label}`}
    >
      <Icon name="history.figure" fallback="🔎" /> Changes
    </button>
  );
}
