import type { ExampleStatement } from "@acct/types/ExampleStatement";
import { formatDate } from "../../lib/dates";
import { Icon } from "../../lib/icons";
import { formatMoney } from "../../lib/money";
import { Button } from "../../ui";
import { EXAMPLE_DRAG_TYPE } from "./dnd";
import styles from "./TryIt.module.css";

export interface ExampleCardProps {
  example: ExampleStatement;
  onOpen: (n: number) => void;
  onUse: (n: number) => void;
}

/** A small paper statement. Draggable onto the drop zone; click opens the full preview. */
export function ExampleCard({ example: e, onOpen, onUse }: ExampleCardProps) {
  return (
    <div
      className={styles.card}
      data-testid={`example-card-${e.number}`}
      draggable
      onDragStart={(ev) => {
        ev.dataTransfer.setData(EXAMPLE_DRAG_TYPE, String(e.number));
        ev.dataTransfer.setData("text/plain", e.title);
        ev.dataTransfer.effectAllowed = "copy";
      }}
    >
      <button type="button" className={styles.cardBody} onClick={() => onOpen(e.number)} aria-label={`Open ${e.title}: ${e.business}`}>
        <span className={styles.cardTag}>{e.title} · example</span>
        <span className={styles.cardBank}>{e.bank}</span>
        <span className={styles.cardBiz}>{e.business}</span>
        <span className={styles.cardPeriod}>
          {formatDate(e.period_start)} to {formatDate(e.period_end)}
        </span>
        <span className={styles.cardLines}>
          {e.lines.slice(0, 4).map((l, i) => (
            <span key={i} className={styles.cardLine}>
              <span className={styles.cardDesc}>{l.description}</span>
              <span className={l.amount < 0 ? styles.out : styles.in}>{formatMoney(l.amount)}</span>
            </span>
          ))}
        </span>
      </button>
      <Button size="sm" variant="ghost" onClick={() => onUse(e.number)} aria-label={`Use ${e.title}`}>
        <Icon name="tryit.use" fallback="✅" /> Use this example
      </Button>
    </div>
  );
}
