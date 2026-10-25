import type { AccountReconciliation } from "@acct/types/AccountReconciliation";
import type { ReconcileStatus } from "@acct/types/ReconcileStatus";
import type { UnmatchedReason } from "@acct/types/UnmatchedReason";
import type { YearReconciliation } from "@acct/types/YearReconciliation";
import { useQuery } from "@tanstack/react-query";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson } from "../lib/api";
import { formatDate } from "../lib/dates";
import { Emoji, Icon } from "../lib/icons";
import { formatMoney } from "../lib/money";
import styles from "./ReconcileTab.module.css";
import { useYearContext } from "./YearLayout";

/**
 * Bank reconciliation: each bank account's and card's statement balance against the ledger, with
 * whatever doesn't match. The server works out every figure; this only shows them.
 */
export function ReconcileTab() {
  const { year } = useYearContext();
  const rec = useQuery({
    // Under the year's prefix, so commands that post journals refresh it with the rest.
    queryKey: ["year", year.id, "reconciliation"],
    queryFn: () => getJson<YearReconciliation>(`/api/years/${year.id}/reconciliation`),
  });
  if (rec.error) {
    return <ErrorMessage error={rec.error} />;
  }
  if (!rec.data) {
    return <p className="muted">Reconciling…</p>;
  }
  if (rec.data.accounts.length === 0) {
    return (
      <p className="muted">
        <Emoji>🏦</Emoji> No bank accounts or cards. This client's books don't come from bank statements.
      </p>
    );
  }
  return (
    <div className={styles.list}>
      {rec.data.accounts.map((a) => (
        <AccountCard key={a.bank_account_id} account={a} />
      ))}
    </div>
  );
}

const statusText: Record<ReconcileStatus, string> = {
  agrees: "Agrees with the statement",
  explained: "Differs, and the items below explain it",
  differs: "Doesn't agree",
  no_balance: "Can't check: the statement gives no balance",
  no_statement: "No statement ends in this year",
};

const statusEmoji: Record<ReconcileStatus, string> = {
  agrees: "✅",
  explained: "🔎",
  differs: "⚠️",
  no_balance: "❔",
  no_statement: "❔",
};

const reasonText: Record<UnmatchedReason, string> = {
  duplicate: "Marked as a duplicate (not a reconciling item)",
  no_journal: "No journal",
  journal_differs: "Its journal posts a different amount",
};

function AccountCard({ account: a }: { account: AccountReconciliation }) {
  const title = `${a.code} ${a.name}`;
  return (
    <section className={styles.card} aria-label={title}>
      <h2>
        <Icon name="year.reconcile" fallback="🏦" /> {title}
        {a.kind === "credit_card" && <span className="muted"> (card)</span>}
      </h2>
      {a.account_number && <p className="muted">{a.account_number}</p>}
      <p className={`${styles.status} ${styles[a.status]}`} role="status">
        <Emoji>{statusEmoji[a.status]}</Emoji> {statusText[a.status]}
      </p>
      {a.date && (
        <table className={styles.table} aria-label={`Balances for ${title}`}>
          <tbody>
            <tr>
              <th>
                Statement at {formatDate(a.date)}
                {a.statement_file && <span className="muted"> ({a.statement_file})</span>}
              </th>
              <td className="num">{a.statement_balance === null ? "not given" : formatMoney(a.statement_balance)}</td>
            </tr>
            <tr>
              <th>Ledger at {formatDate(a.date)}</th>
              <td className="num">{a.ledger_balance === null ? "" : formatMoney(a.ledger_balance)}</td>
            </tr>
            {a.difference !== null && (
              <tr>
                <th>Difference (ledger less statement)</th>
                <td className="num">{formatMoney(a.difference)}</td>
              </tr>
            )}
            {a.unexplained !== null && a.unexplained !== 0 && (
              <tr className={styles.unexplained}>
                <th>Not explained by the items below</th>
                <td className="num">{formatMoney(a.unexplained)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {a.lines_without_journal.length > 0 && (
        <Items title="Statement lines without a journal">
          {a.lines_without_journal.map((l) => (
            <tr key={l.bank_line_id}>
              <td>{formatDate(l.date)}</td>
              <td>
                {l.description}
                <div className="muted">{reasonText[l.reason]}</div>
              </td>
              <td className="num">{formatMoney(l.amount)}</td>
            </tr>
          ))}
        </Items>
      )}
      {a.journals_without_line.length > 0 && (
        <Items title="Journals without a statement line">
          {a.journals_without_line.map((j) => (
            <tr key={j.journal_id}>
              <td>{formatDate(j.date)}</td>
              <td>{j.narration}</td>
              <td className="num">{formatMoney(j.amount)}</td>
            </tr>
          ))}
        </Items>
      )}
      {a.gap_journals.length > 0 && (
        <Items title="Gap journals (days no statement covers)">
          {a.gap_journals.map((g) => (
            <tr key={g.journal_id}>
              <td>{formatDate(g.end)}</td>
              <td>
                {formatDate(g.start)} to {formatDate(g.end)}
              </td>
              <td className="num">{formatMoney(g.amount)}</td>
            </tr>
          ))}
        </Items>
      )}
      {a.gaps
        .filter((g) => g.change === null)
        .map((g) => (
          <p key={g.start} className="muted">
            <Emoji>⚠️</Emoji> No statement covers {formatDate(g.start)} to {formatDate(g.end)}, and the balance
            isn't known at both ends, so nothing is posted for it.
          </p>
        ))}
    </section>
  );
}

function Items({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h3>{title}</h3>
      <table className={styles.table} aria-label={title}>
        <tbody>{children}</tbody>
      </table>
    </>
  );
}
