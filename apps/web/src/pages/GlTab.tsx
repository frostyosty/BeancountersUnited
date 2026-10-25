import type { GlAccountView } from "@acct/types/GlAccountView";
import type { GlListing } from "@acct/types/GlListing";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson } from "../lib/api";
import { formatDate } from "../lib/dates";
import { Emoji, Icon } from "../lib/icons";
import { formatMoney } from "../lib/money";
import styles from "./GlTab.module.css";
import { useYearContext } from "./YearLayout";

/** Under `["year", id]`, so anything that posts a journal refreshes it. */
const glKey = (yearId: string) => ["year", yearId, "gl"] as const;

/**
 * The general ledger: every line posted to each account, with a running balance. A journal and
 * its reversal (a matched pair) are hidden unless asked for; the server works out the running
 * balance over every line, so the balances shown are the same either way.
 */
export function GlTab() {
  const { year } = useYearContext();
  const gl = useQuery({
    queryKey: glKey(year.id),
    queryFn: () => getJson<GlListing>(`/api/years/${year.id}/gl`),
  });
  const [showReversals, setShowReversals] = useState(false);
  const [only, setOnly] = useState("");

  if (gl.error) {
    return <ErrorMessage error={gl.error} />;
  }
  if (!gl.data) {
    return <p className="muted">Loading…</p>;
  }
  const accounts = gl.data.accounts;
  if (accounts.length === 0) {
    return (
      <p className="muted">
        <Emoji>🌱</Emoji> Nothing posted yet.
      </p>
    );
  }
  const hiddenCount = accounts.reduce((n, a) => n + a.entries.filter((e) => e.matched_reversal).length, 0);
  const shown = only === "" ? accounts : accounts.filter((a) => accountKey(a) === only);

  return (
    <div>
      <h2>
        <Icon name="year.gl" fallback="📖" /> General ledger
      </h2>
      <div className={styles.controls}>
        <label>
          Account{" "}
          <select value={only} onChange={(e) => setOnly(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={accountKey(a)} value={accountKey(a)}>
                {accountLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={showReversals} onChange={(e) => setShowReversals(e.target.checked)} /> Show
          matched reversals
        </label>
        {hiddenCount > 0 && !showReversals && (
          <span className="muted">
            {hiddenCount} {hiddenCount === 1 ? "line" : "lines"} from matched reversals hidden
          </span>
        )}
      </div>
      {shown.map((a) => (
        <AccountLedger key={accountKey(a)} account={a} showReversals={showReversals} />
      ))}
    </div>
  );
}

function AccountLedger({ account, showReversals }: { account: GlAccountView; showReversals: boolean }) {
  const entries = account.entries.filter((e) => showReversals || !e.matched_reversal);
  return (
    <section className={styles.account} aria-label={accountLabel(account)}>
      <h3>{accountLabel(account)}</h3>
      <table className={`table ${styles.ledger}`}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Journal</th>
            <th>Description</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr className={styles.edge}>
            <td colSpan={5}>Opening balance</td>
            <td className="num">{drCr(account.opening)}</td>
          </tr>
          {entries.map((e, i) => (
            <tr key={`${e.journal_id}-${i}`} className={e.matched_reversal ? styles.reversal : undefined}>
              <td>{formatDate(e.date)}</td>
              <td>{kindLabel(e.kind)}</td>
              <td>
                {e.narration}
                {e.matched_reversal && <span className={styles.tag}> matched reversal</span>}
              </td>
              <td className="num">{e.amount > 0 ? formatMoney(e.amount) : ""}</td>
              <td className="num">{e.amount < 0 ? formatMoney(-e.amount) : ""}</td>
              <td className="num">{drCr(e.balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={5}>Closing balance</th>
            <th className="num">{drCr(account.closing)}</th>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

/** Owners get no codes, so an account is known by its name there. */
function accountKey(a: GlAccountView): string {
  return a.code ?? a.name;
}

function accountLabel(a: GlAccountView): string {
  return a.code ? `${a.code} ${a.name}` : a.name;
}

function drCr(cents: number): string {
  if (cents === 0) {
    return "–";
  }
  return `${formatMoney(Math.abs(cents))} ${cents > 0 ? "Dr" : "Cr"}`;
}

function kindLabel(kind: string): string {
  const text = kind.replace(/_/g, " ");
  return text === "tb import" ? "TB import" : text.charAt(0).toUpperCase() + text.slice(1);
}
