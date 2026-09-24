import type { JournalError } from "@acct/types/JournalError";
import type { JournalView } from "@acct/types/JournalView";
import { type FormEvent, useState } from "react";
import { can, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { ApiRequestError } from "../lib/api";
import { formatDate } from "../lib/dates";
import { blankRow, describeJournalError, evaluate, type GridRow, normaliseCode } from "../lib/journalGrid";
import { formatMoney } from "../lib/money";
import { keys, useJournals } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import styles from "./JournalsTab.module.css";
import { useYearContext } from "./YearLayout";

export function JournalsTab() {
  const { year, client } = useYearContext();
  const me = useCurrentUser();
  const editable = can(me, "staff") && year.status === "open";
  return (
    <>
      {editable && year.books_source !== "bank_coding" && <JournalEntry key={year.id} />}
      {year.books_source === "bank_coding" && (
        <p className="muted">This year's books come from bank coding.</p>
      )}
      <h2>Journals</h2>
      <JournalList editable={editable} clientId={client.id} />
    </>
  );
}

function JournalEntry() {
  const { year, chart } = useYearContext();
  const post = useCommand([keys.years, keys.client(year.client_id)]);
  const [date, setDate] = useState(year.end);
  const [narration, setNarration] = useState("");
  const [rows, setRows] = useState<GridRow[]>(() => [blankRow(), blankRow(), blankRow(), blankRow()]);
  const names = new Map(chart.map((a) => [a.code, a.name]));
  const e = evaluate(rows, chart);

  // Server problems, mapped back to grid rows where they're about one line.
  const serverErrors =
    post.error instanceof ApiRequestError && post.error.code === "invalid_journal" && Array.isArray(post.error.details)
      ? (post.error.details as JournalError[]).map((d) => describeJournalError(d, e.rowOf))
      : [];

  const canPost = e.rowErrors.size === 0 && e.lines.length >= 2 && e.difference === 0 && date !== "";

  const setCell = (i: number, field: keyof GridRow, value: string) => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, [field]: value } : r));
      // Keep a spare blank row at the bottom.
      const last = next.at(-1)!;
      return last.account || last.debit || last.credit ? [...next, blankRow()] : next;
    });
  };

  const balanceOn = (i: number) => {
    // Puts the amount that would balance the journal on row `i`.
    const others = evaluate(
      rows.map((r, j) => (j === i ? { ...r, debit: "", credit: "" } : r)),
      chart,
    ).difference;
    const text = formatMoney(Math.abs(others));
    setRows((rs) =>
      rs.map((r, j) => (j === i ? { ...r, debit: others < 0 ? text : "", credit: others > 0 ? text : "" } : r)),
    );
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    post.mutate(
      { kind: "post_journal", payload: { client_year_id: year.id, date, narration: narration.trim(), lines: e.lines } },
      {
        onSuccess: () => {
          setNarration("");
          setRows([blankRow(), blankRow(), blankRow(), blankRow()]);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className={`card ${styles.entry}`} aria-label="New journal">
      <h2>New journal</h2>
      <div className="row">
        <label className="field">
          <span>Date</span>
          <input type="date" value={date} min={year.start} max={year.end} onChange={(ev) => setDate(ev.target.value)} required />
        </label>
        <label className={`field ${styles.grow}`}>
          <span>Narration</span>
          <input value={narration} onChange={(ev) => setNarration(ev.target.value)} />
        </label>
      </div>
      <datalist id="chart-accounts">
        {chart
          .filter((a) => a.active)
          .map((a) => (
            <option key={a.code} value={a.code}>
              {a.name}
            </option>
          ))}
      </datalist>
      <table className={`table ${styles.grid}`}>
        <thead>
          <tr>
            <th>Account</th>
            <th />
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const error = e.rowErrors.get(i) ?? serverErrors.find((s) => s.row === i)?.message;
            return (
              <tr key={i} className={error ? styles.bad : undefined}>
                <td>
                  <input
                    aria-label={`Line ${i + 1} account`}
                    list="chart-accounts"
                    value={r.account}
                    onChange={(ev) => setCell(i, "account", ev.target.value)}
                    size={8}
                  />
                </td>
                <td className={styles.name}>
                  {names.get(normaliseCode(r.account)) ?? ""}
                  {error && <div className="error">{error}</div>}
                </td>
                <td>
                  <input
                    aria-label={`Line ${i + 1} debit`}
                    className="num"
                    inputMode="decimal"
                    value={r.debit}
                    onChange={(ev) => setCell(i, "debit", ev.target.value)}
                    size={12}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Line ${i + 1} credit`}
                    className="num"
                    inputMode="decimal"
                    value={r.credit}
                    onChange={(ev) => setCell(i, "credit", ev.target.value)}
                    size={12}
                  />
                </td>
                <td>
                  {r.account && e.difference !== 0 && (
                    <button type="button" className={styles.small} onClick={() => balanceOn(i)} title="Put the balancing amount on this line">
                      Balance
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={2}>Totals</th>
            <th className="num" data-testid="total-debit">
              {formatMoney(e.totalDebit)}
            </th>
            <th className="num" data-testid="total-credit">
              {formatMoney(e.totalCredit)}
            </th>
            <th />
          </tr>
          <tr>
            <th colSpan={2}>Out of balance</th>
            <th colSpan={2} className={`num ${e.difference === 0 ? styles.balanced : styles.unbalanced}`} data-testid="difference">
              {e.difference === 0 ? "Balanced" : `${formatMoney(Math.abs(e.difference))} ${e.difference > 0 ? "Dr" : "Cr"}`}
            </th>
            <th />
          </tr>
        </tfoot>
      </table>
      {serverErrors
        .filter((s) => s.row === null)
        .map((s) => (
          <p key={s.message} role="alert" className="error">
            {s.message}
          </p>
        ))}
      {serverErrors.length === 0 && <ErrorMessage error={post.error} />}
      <div>
        <button type="submit" className="primary" disabled={!canPost || post.isPending}>
          Post journal
        </button>
      </div>
    </form>
  );
}

function JournalList({ editable, clientId }: { editable: boolean; clientId: string }) {
  const { year, chart } = useYearContext();
  const journals = useJournals(year.id);
  const [open, setOpen] = useState<string | null>(null);
  const names = new Map(chart.map((a) => [a.code, a.name]));

  if (journals.error) {
    return <ErrorMessage error={journals.error} />;
  }
  if (!journals.data) {
    return <p className="muted">Loading…</p>;
  }
  if (journals.data.length === 0) {
    return <p className="muted">No journals yet.</p>;
  }
  const sorted = [...journals.data].sort((a, b) => a.date.localeCompare(b.date) || a.posted_seq - b.posted_seq);
  return (
    <table className={`table ${styles.list}`}>
      <thead>
        <tr>
          <th>Date</th>
          <th>Narration</th>
          <th>Kind</th>
          <th className="num">Amount</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {sorted.map((j) => (
          <JournalRow
            key={j.id}
            journal={j}
            names={names}
            expanded={open === j.id}
            onToggle={() => setOpen(open === j.id ? null : j.id)}
            editable={editable}
            clientId={clientId}
          />
        ))}
      </tbody>
    </table>
  );
}

function JournalRow({
  journal: j,
  names,
  expanded,
  onToggle,
  editable,
  clientId,
}: {
  journal: JournalView;
  names: Map<string, string>;
  expanded: boolean;
  onToggle: () => void;
  editable: boolean;
  clientId: string;
}) {
  const debits = j.lines.reduce((sum, l) => sum + (l.amount > 0 ? l.amount : 0), 0);
  return (
    <>
      <tr className={j.reversed_by ? styles.reversed : undefined}>
        <td>{formatDate(j.date)}</td>
        <td>
          <button type="button" className={styles.linkButton} onClick={onToggle} aria-expanded={expanded}>
            {j.narration || <span className="muted">(no narration)</span>}
          </button>
          {j.reversed_by && <span className={styles.tag}>reversed</span>}
          {j.reverses_journal_id && <span className={styles.tag}>reversal</span>}
        </td>
        <td>{j.kind === "tb_import" ? "TB import" : "manual"}</td>
        <td className="num">{formatMoney(debits)}</td>
        <td>{editable && j.kind === "manual" && !j.reversed_by && <ReverseButton journal={j} clientId={clientId} />}</td>
      </tr>
      {expanded && (
        <tr className={styles.detail}>
          <td />
          <td colSpan={4}>
            <table className={styles.lines}>
              <tbody>
                {j.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.account}</td>
                    <td>{names.get(l.account) ?? ""}</td>
                    <td className="num">{l.amount > 0 ? formatMoney(l.amount) : ""}</td>
                    <td className="num">{l.amount < 0 ? formatMoney(-l.amount) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

function ReverseButton({ journal, clientId }: { journal: JournalView; clientId: string }) {
  const reverse = useCommand([keys.years, keys.client(clientId)]);
  const [confirming, setConfirming] = useState(false);
  const [date, setDate] = useState(journal.date);
  if (!confirming) {
    return (
      <button type="button" className={styles.small} onClick={() => setConfirming(true)}>
        Reverse…
      </button>
    );
  }
  return (
    <span className={styles.confirm}>
      <input type="date" aria-label="Reversal date" value={date} onChange={(e) => setDate(e.target.value)} />
      <button
        type="button"
        className="primary"
        disabled={reverse.isPending}
        onClick={() => reverse.mutate({ kind: "reverse_journal", payload: { journal_id: journal.id, date } })}
      >
        Post reversal
      </button>
      <button type="button" onClick={() => setConfirming(false)}>
        Cancel
      </button>
      <ErrorMessage error={reverse.error} />
    </span>
  );
}
