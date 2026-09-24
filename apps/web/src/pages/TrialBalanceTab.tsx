import type { TbLine } from "@acct/types/TbLine";
import { ErrorMessage } from "../components/ErrorMessage";
import { formatMoney, sumCents } from "../lib/money";
import { useTrialBalance } from "../lib/queries";
import { useYearContext } from "./YearLayout";

/** Opening balances (rolled forward, never posted), movement and closing balances, by account. */
export function TrialBalanceTab() {
  const { year, chart } = useYearContext();
  const tb = useTrialBalance(year.id);
  if (tb.error) {
    return <ErrorMessage error={tb.error} />;
  }
  if (!tb.data) {
    return <p className="muted">Loading…</p>;
  }
  const opening = toMap(tb.data.opening);
  const closing = toMap(tb.data.closing);
  const rows = chart.filter((a) => opening.has(a.code) || closing.has(a.code));
  if (rows.length === 0) {
    return <p className="muted">Nothing posted yet.</p>;
  }
  const debit = (n: number) => (n > 0 ? formatMoney(n) : "");
  const credit = (n: number) => (n < 0 ? formatMoney(-n) : "");
  const closings = rows.map((a) => closing.get(a.code) ?? 0);
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Code</th>
          <th>Account</th>
          <th className="num">Opening</th>
          <th className="num">Movement</th>
          <th className="num">Debit</th>
          <th className="num">Credit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => {
          const o = opening.get(a.code) ?? 0;
          const c = closing.get(a.code) ?? 0;
          return (
            <tr key={a.code}>
              <td>{a.code}</td>
              <td>{a.name}</td>
              <td className="num">{formatMoney(o)}</td>
              <td className="num">{formatMoney(c - o)}</td>
              <td className="num">{debit(c)}</td>
              <td className="num">{credit(c)}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <th colSpan={4}>Totals</th>
          <th className="num">{formatMoney(sumCents(closings.filter((n) => n > 0)))}</th>
          <th className="num">{formatMoney(-sumCents(closings.filter((n) => n < 0)))}</th>
        </tr>
      </tfoot>
    </table>
  );
}

function toMap(lines: TbLine[]): Map<string, number> {
  return new Map(lines.map((l) => [l.account, l.balance]));
}
