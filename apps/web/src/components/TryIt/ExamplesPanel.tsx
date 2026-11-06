import type { ExampleStatement } from "@acct/types/ExampleStatement";
import { useState } from "react";
import { Icon } from "../../lib/icons";
import { ExampleCard } from "./ExampleCard";
import { StatementPreview } from "./StatementPreview";
import styles from "./TryIt.module.css";

export interface ExamplesProps {
  examples: ExampleStatement[];
}

/** Desktop: the panel beside the flow, with three cards. */
export function ExamplesPanel({ examples }: ExamplesProps) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <aside className={styles.panel} aria-label="Example statements">
      <h3 className={styles.panelTitle}>
        <Icon name="tryit.example" fallback="🧾" /> Drag and drop an example OFX
      </h3>
      <p className={styles.panelNote}>Made-up statements, so you can see it work.</p>
      {examples.map((e) => (
        <ExampleCard key={e.number} example={e} onOpen={setOpen} />
      ))}
      <StatementPreview examples={examples} open={open} onClose={() => setOpen(null)} />
    </aside>
  );
}

/** Phone: three links under the Upload step's text, each opening the same preview. */
export function ExampleLinks({ examples }: ExamplesProps) {
  const [open, setOpen] = useState<number | null>(null);
  if (examples.length === 0) return null;
  return (
    <>
      <p className={styles.links}>
        Try an example:{" "}
        {examples.map((e) => (
          <button key={e.number} type="button" className={styles.linkBtn} onClick={() => setOpen(e.number)}>
            {e.title}
          </button>
        ))}
      </p>
      <StatementPreview examples={examples} open={open} onClose={() => setOpen(null)} />
    </>
  );
}
