import type { AccountProof } from "@acct/types/AccountProof";
import type { AccountReconciliation } from "@acct/types/AccountReconciliation";
import type { ReconcileStatus } from "@acct/types/ReconcileStatus";
import type { UnmatchedReason } from "@acct/types/UnmatchedReason";
import type { YearReconciliation } from "@acct/types/YearReconciliation";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BankVsBooksForAccount, findingText } from "../components/BankVsBooks";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson } from "../lib/api";
import { formatDate } from "../lib/dates";
import { Emoji, Icon } from "../lib/icons";
import { lineDescription } from "../lib/lines";
import { formatMoney } from "../lib/money";
import { Button } from "../ui";
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
  const [proofOpen, setProofOpen] = useState(false);
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
        <>
          <Button variant="secondary" size="sm" onClick={() => setProofOpen(true)}>
            <Icon name="proof.open" fallback="⚖️" /> Bank vs books
          </Button>
          <BankVsBooksForAccount
            open={proofOpen}
            onClose={() => setProofOpen(false)}
            bankAccountId={a.bank_account_id}
            date={a.date}
          />
          {a.difference !== null && a.difference !== 0 && <FindingsSummary bankAccountId={a.bank_account_id} date={a.date} onOpen={() => setProofOpen(true)} />}
        </>
      )}
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
                {lineDescription(l.description)}
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

/**
 * What the reconciliation findings (M18) make of a difference, in a line each: the same proof Bank
 * vs books opens with, so its fixes are one click away.
 */
function FindingsSummary({ bankAccountId, date, onOpen }: { bankAccountId: string; date: string; onOpen: () => void }) {
  const proof = useQuery({
    queryKey: ["bank-account", bankAccountId, "proof", date],
    queryFn: () => getJson<AccountProof>(`/api/bank-accounts/${encodeURIComponent(bankAccountId)}/proof?date=${date}`),
  });
  const x = proof.data?.findings;
  if (!x || x.diagnosis.difference === 0) {
    return null;
  }
  const d = x.diagnosis;
  return (
    <div className={styles.findings} aria-label="What might explain it">
      <h3>
        <Icon name="proof.findings" fallback="🔎" /> What might explain it
      </h3>
      {d.explained_by.length > 0 ? (
        <ul>
          {d.explained_by.map((f, i) => (
            <li key={i}>{findingText(f, x).headline}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">We couldn't work out why.</p>
      )}
      {d.remainder !== 0 && d.explained_by.length > 0 && (
        <p className="muted">That leaves ${formatMoney(Math.abs(d.remainder))} unexplained.</p>
      )}
      {d.other_findings.some((f) => f.explains !== 0) && (
        <p className="muted">{d.other_findings.filter((f) => f.explains !== 0).length} other things we noticed are in Bank vs books.</p>
      )}
      <Button variant="secondary" size="sm" onClick={onOpen}>
        <Icon name="proof.fix" fallback="🛠️" /> See the details and fix it
      </Button>
    </div>
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
