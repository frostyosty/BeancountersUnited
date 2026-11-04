import type { ExampleStatement } from "@acct/types/ExampleStatement";
import { useState } from "react";
import { formatDate } from "../../lib/dates";
import { Icon } from "../../lib/icons";
import { formatMoney } from "../../lib/money";
import { Button, Modal } from "../../ui";
import styles from "./TryIt.module.css";

export interface StatementPreviewProps {
  examples: ExampleStatement[];
  /** The open example's number, or null when closed. */
  open: number | null;
  onClose: () => void;
  onUse: (n: number) => void;
}

export function StatementPreview({ examples, open, onClose, onUse }: StatementPreviewProps) {
  const e = examples.find((x) => x.number === open);
  return e ? <Preview key={e.number} e={e} onClose={onClose} onUse={onUse} /> : null;
}

function Preview({ e, onClose, onUse }: { e: ExampleStatement; onClose: () => void; onUse: (n: number) => void }) {
  const [tab, setTab] = useState<"statement" | "raw">("statement");
  // Running balance, in exact integer cents.
  let balance = e.opening_balance;
  const rows = e.lines.map((l) => {
    balance += l.amount;
    return { ...l, balance };
  });

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      icon={<Icon name="tryit.statement" fallback="🏛" />}
      title={`${e.title}: ${e.business}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onUse(e.number);
              onClose();
            }}
          >
            <Icon name="tryit.use" fallback="✅" /> Use this example
          </Button>
        </>
      }
    >
      <p className={styles.previewNote}>An example, made up for this page: {e.what}.</p>
      <div role="tablist" aria-label="View" className={styles.tabs}>
        <button type="button" role="tab" aria-selected={tab === "statement"} className={styles.tab} onClick={() => setTab("statement")}>
          Statement
        </button>
        <button type="button" role="tab" aria-selected={tab === "raw"} className={styles.tab} onClick={() => setTab("raw")}>
          <Icon name="tryit.raw" fallback="📄" /> Raw file
        </button>
      </div>

      {tab === "statement" ? (
        <div className={styles.paper} role="tabpanel" aria-label="Statement">
          <div className={styles.paperHead}>
            <strong>{e.bank}</strong>
            <span>Account {e.account_number}</span>
          </div>
          <div className={styles.paperSub}>
            {e.business} · {formatDate(e.period_start)} to {formatDate(e.period_end)}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.stmt}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className={styles.num}>Money in</th>
                  <th className={styles.num}>Money out</th>
                  <th className={styles.num}>Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className={styles.openRow}>
                  <td />
                  <td>Opening balance</td>
                  <td />
                  <td />
                  <td className={styles.num}>{formatMoney(e.opening_balance)}</td>
                </tr>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{formatDate(r.date)}</td>
                    <td>{r.description}</td>
                    <td className={styles.num}>{r.amount > 0 ? formatMoney(r.amount) : ""}</td>
                    <td className={styles.num}>{r.amount < 0 ? formatMoney(-r.amount) : ""}</td>
                    <td className={styles.num}>{formatMoney(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td>Closing balance</td>
                  <td />
                  <td />
                  <td className={styles.num}>{formatMoney(e.closing_balance)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : (
        <pre className={styles.raw} role="tabpanel" aria-label="Raw file" tabIndex={0}>
          {e.raw}
        </pre>
      )}
    </Modal>
  );
}
