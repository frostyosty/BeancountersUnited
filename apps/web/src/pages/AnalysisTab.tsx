import type { ExpenseAnalysisView } from "@acct/types/ExpenseAnalysisView";
import type { Movement } from "@acct/types/Movement";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson } from "../lib/api";
import { Emoji, Icon } from "../lib/icons";
import { formatMoney } from "../lib/money";
import { formatRate } from "../lib/rates";
import styles from "./AnalysisTab.module.css";
import { useYearContext } from "./YearLayout";

/** Under `["year", id]`, so anything that posts a journal refreshes it. */
const analysisKey = (yearId: string) => ["year", yearId, "analysis"] as const;

/**
 * Expenses by category, this year against last. The categories are the statements' report lines,
 * and every figure (including the percentages, in basis points) comes from the server.
 */
export function AnalysisTab() {
  const { year } = useYearContext();
  const analysis = useQuery({
    queryKey: analysisKey(year.id),
    queryFn: () => getJson<ExpenseAnalysisView>(`/api/years/${year.id}/analysis`),
  });
  if (analysis.error) {
    return <ErrorMessage error={analysis.error} />;
  }
  if (!analysis.data) {
    return <p className="muted">Loading…</p>;
  }
  return <ExpenseAnalysis view={analysis.data} />;
}

function ExpenseAnalysis({ view }: { view: ExpenseAnalysisView }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <h2>
        <Icon name="year.analysis" fallback="📊" /> Expenses by category
      </h2>
      {view.comparatives === "unfinalised" && (
        <p className={styles.notice}>
          <Emoji>⚠️</Emoji> Last year isn't finalised yet, so its figures may still change.
        </p>
      )}
      {view.comparatives === "none" && <p className="muted">There's no earlier year to compare with.</p>}
      {view.categories.length === 0 ? (
        <p className="muted">
          <Emoji>🌱</Emoji> No expenses in either year yet.
        </p>
      ) : (
        <table className={`table ${styles.analysis}`}>
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">This year</th>
              <th className="num">Last year</th>
              <th className="num">Change</th>
              <th className="num">Change %</th>
            </tr>
          </thead>
          <tbody>
            {view.categories.map((c) => {
              const expanded = open === c.line;
              return (
                <Fragment key={c.line}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className={styles.drill}
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : c.line)}
                      >
                        {c.label}
                      </button>
                    </td>
                    <Figures m={c.movement} />
                  </tr>
                  {expanded &&
                    c.accounts.map((a) => (
                      <tr key={a.code ?? a.name} className={styles.account}>
                        <td>{a.code ? `${a.code} ${a.name}` : a.name}</td>
                        <Figures m={a.movement} />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th>Total expenses</th>
              <Figures m={view.total} />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

function Figures({ m }: { m: Movement }) {
  return (
    <>
      <td className="num">{formatMoney(m.current)}</td>
      <td className="num">{formatMoney(m.prior)}</td>
      <td className="num">{signed(m.change)}</td>
      <td className="num">{formatChangeBp(m.change_bp)}</td>
    </>
  );
}

function signed(cents: number): string {
  return cents > 0 ? `+${formatMoney(cents)}` : formatMoney(cents);
}

/** A change in basis points as `+12.5%`, `-3%` or `0%`; a dash when last year was nil. */
function formatChangeBp(bp: number | null): string {
  if (bp === null) {
    return "–";
  }
  const sign = bp > 0 ? "+" : bp < 0 ? "-" : "";
  return `${sign}${formatRate(Math.abs(bp))}`;
}
