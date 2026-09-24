import type { AssetSchedule } from "@acct/types/AssetSchedule";
import type { Period } from "@acct/types/Period";
import type { ReportDoc } from "@acct/types/ReportDoc";
import type { ReportRow } from "@acct/types/ReportRow";
import type { ReportWarning } from "@acct/types/ReportWarning";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson } from "../lib/api";
import { formatDate } from "../lib/dates";
import { formatStatementCents, formatStatementDollars } from "../lib/money";
import { keys } from "../lib/queries";
import styles from "./StatementsTab.module.css";
import { useYearContext } from "./YearLayout";

/**
 * An HTML render of the year's ReportDoc. It only renders: every figure, including rounding, comes
 * from the ReportDoc, which core builds. Presentation follows `docs/domain.md`, Statement amounts.
 */
export function StatementsTab() {
  const { year } = useYearContext();
  const report = useQuery({
    queryKey: keys.report(year.id),
    queryFn: () => getJson<ReportDoc>(`/api/years/${year.id}/report`),
  });
  if (report.error) {
    return <ErrorMessage error={report.error} />;
  }
  if (!report.data) {
    return <p className="muted">Building statements…</p>;
  }
  return <Statements doc={report.data} />;
}

export function Statements({ doc }: { doc: ReportDoc }) {
  const { chart } = useYearContext();
  const names = new Map(chart.map((a) => [a.code, a.name]));
  const [open, setOpen] = useState<string | null>(null);
  const hasPrior = doc.prior_period !== null;
  const unfinalised = doc.comparatives === "unfinalised";
  const [currentHead, priorHead] = headings(doc.current_period, doc.prior_period);
  const labels = new Map(doc.statements.flatMap((s) => s.rows.map((r) => [r.key, r.label] as const)));

  return (
    <div className={styles.doc}>
      {unfinalised && (
        <p className={styles.notice} role="status">
          The prior year isn't finalised, so the comparatives may still change.
        </p>
      )}
      {doc.warnings.length > 0 && (
        <ul className={styles.warnings} aria-label="Warnings">
          {doc.warnings.map((w, i) => (
            <li key={i}>{describeWarning(w, labels)}</li>
          ))}
        </ul>
      )}
      {doc.statements.map((s) => (
        <section key={s.key} className={styles.statement}>
          <h2>{s.title}</h2>
          <p className={styles.period}>For the year ended {formatDate(doc.current_period.end)}</p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th />
                <th className="num">{currentHead}</th>
                {hasPrior && (
                  <th className="num">
                    {priorHead}
                    {unfinalised && <sup>*</sup>}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r, i) => {
                const id = `${s.key}/${i}`;
                const drillable = (r.style === "line" || r.style === "link") && r.accounts.length > 0;
                return (
                  <Fragment key={id}>
                    <tr className={styles[r.style]}>
                      <td style={{ paddingLeft: `${0.25 + r.depth * 1.25}rem` }}>
                        {drillable ? (
                          <button
                            type="button"
                            className={styles.drill}
                            aria-expanded={open === id}
                            onClick={() => setOpen(open === id ? null : id)}
                          >
                            {r.label}
                          </button>
                        ) : (
                          r.label
                        )}
                      </td>
                      <td className="num">{r.style === "heading" ? "" : formatStatementDollars(r.current)}</td>
                      {hasPrior && <td className="num">{r.style === "heading" ? "" : formatStatementDollars(r.prior)}</td>}
                    </tr>
                    {open === id && <DrillDown row={r} names={names} hasPrior={hasPrior} />}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {unfinalised && hasPrior && <p className={styles.footnote}>* Unfinalised.</p>}
        </section>
      ))}
      {doc.asset_schedule && (
        <AssetScheduleView schedule={doc.asset_schedule} currentHead={currentHead} priorHead={hasPrior ? priorHead : null} />
      )}
    </div>
  );
}

/** The fixed asset schedule: one block per class, then the total. Amounts come from the ReportDoc. */
function AssetScheduleView({
  schedule,
  currentHead,
  priorHead,
}: {
  schedule: AssetSchedule;
  currentHead: string;
  priorHead: string | null;
}) {
  return (
    <section className={styles.statement} aria-label={schedule.title}>
      <h2>{schedule.title}</h2>
      <table className={styles.table}>
        <thead>
          <tr>
            <th />
            <th className="num">{currentHead}</th>
            {priorHead !== null && <th className="num">{priorHead}</th>}
          </tr>
        </thead>
        {schedule.blocks.map((b) => (
          <tbody key={b.class ?? "total"}>
            <tr className={styles.heading}>
              <td colSpan={priorHead !== null ? 3 : 2}>{b.title}</td>
            </tr>
            {b.rows.map((r) => (
              <tr key={r.key} className={r.style === "total" ? styles.group_total : undefined}>
                <td style={{ paddingLeft: "1.5rem" }}>{r.label}</td>
                <td className="num">{formatStatementDollars(r.current)}</td>
                {priorHead !== null && <td className="num">{formatStatementDollars(r.prior)}</td>}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </section>
  );
}

/** The accounts behind a line, in cents, plus a rounding entry so they add up to the line. */
function DrillDown({ row, names, hasPrior }: { row: ReportRow; names: Map<string, string>; hasPrior: boolean }) {
  const sum = (col: "current" | "prior") => row.accounts.reduce((s, a) => s + a[col], 0);
  const roundCurrent = (row.current ?? 0) * 100 - sum("current");
  const roundPrior = (row.prior ?? 0) * 100 - sum("prior");
  return (
    <tr className={styles.drillRow}>
      <td colSpan={hasPrior ? 3 : 2}>
        <table className={styles.accounts} aria-label={`Accounts behind ${row.label}`}>
          <tbody>
            {row.accounts.map((a) => (
              <tr key={a.code}>
                <td>{a.code}</td>
                <td>{names.get(a.code) ?? ""}</td>
                <td className="num">{formatStatementCents(a.current)}</td>
                {hasPrior && <td className="num">{formatStatementCents(a.prior)}</td>}
              </tr>
            ))}
            {(roundCurrent !== 0 || (hasPrior && roundPrior !== 0)) && (
              <tr>
                <td />
                <td>Rounding</td>
                <td className="num">{formatStatementCents(roundCurrent)}</td>
                {hasPrior && <td className="num">{formatStatementCents(roundPrior)}</td>}
              </tr>
            )}
          </tbody>
        </table>
      </td>
    </tr>
  );
}

/** "2026 $" and "2025 $", or full end dates if both periods end in the same calendar year. */
export function headings(current: Period, prior: Period | null): [string, string] {
  const year = (p: Period) => p.end.slice(0, 4);
  if (prior && year(prior) === year(current)) {
    return [`${formatDate(current.end)} $`, `${formatDate(prior.end)} $`];
  }
  return [`${year(current)} $`, prior ? `${year(prior)} $` : ""];
}

function describeWarning(w: ReportWarning, labels: Map<string, string>): string {
  const label = (key: string) => labels.get(key) ?? key;
  const column = (c: string) => (c === "current" ? "this year" : "the prior year");
  switch (w.code) {
    case "rounding_fallback":
      return `Nothing on the rounding priority list maps into ${label(w.row)}, so ${label(w.line)} took the rounding for ${column(w.column)}. Add an account to the list to choose the line.`;
    case "cannot_round":
      return `${label(w.row)} couldn't be rounded to foot for ${column(w.column)} (off by ${w.difference}).`;
    case "check_failed":
      return `${label(w.left)} (${w.left_amount}) should equal ${label(w.right)} (${w.right_amount}) for ${column(w.column)}, but doesn't.`;
  }
}
