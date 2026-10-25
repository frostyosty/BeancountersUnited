import type { LayoutVersions } from "@acct/types/LayoutVersions";
import type { RowSummary } from "@acct/types/RowSummary";
import type { YearSummary } from "@acct/types/YearSummary";
import { useState } from "react";
import { can, useCurrentUser } from "../auth";
import { describeDetail, ErrorMessage } from "../components/ErrorMessage";
import { Icon } from "../lib/icons";
import { formatStatementDollars } from "../lib/money";
import { keys, useYearLayout } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import styles from "./LayoutMove.module.css";

const describeVersions = (v: LayoutVersions) =>
  `${v.template_name} v${v.template_version}, mapping ${v.mapping_name} v${v.mapping_version}`;

/**
 * Offers to move an open year onto newer template and mapping versions (or another mapping for
 * its entity type). Nothing changes until the preview's been seen and the move is confirmed.
 */
export function LayoutMove({ year }: { year: YearSummary }) {
  const me = useCurrentUser();
  const [mappingId, setMappingId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const layout = useYearLayout(year.id, mappingId);
  const move = useCommand([keys.years]);
  const data = layout.data;
  if (!data || year.status !== "open") {
    return null;
  }
  if (data.up_to_date && data.choices.length <= 1) {
    return null;
  }
  const editable = can(me, "staff");
  return (
    <section className={styles.panel} aria-label="Statement layout">
      <p>
        <Icon name="layouts.move" fallback="📐" /> This year uses {describeVersions(data.current)}.{" "}
        {data.up_to_date ? (
          "That's the latest."
        ) : (
          <>
            <strong>Newer: {describeVersions(data.proposed)}.</strong> The statements don't change until the year is moved.
          </>
        )}
      </p>
      <div className="row">
        {data.choices.length > 1 && (
          <label>
            Mapping{" "}
            <select
              aria-label="Mapping to move onto"
              value={mappingId ?? data.proposed.mapping_id}
              onChange={(e) => setMappingId(e.target.value)}
            >
              {data.choices.map((c) => (
                <option key={c.mapping_id} value={c.mapping_id}>
                  {c.mapping_name} (onto {c.template_name})
                </option>
              ))}
            </select>
          </label>
        )}
        {!data.up_to_date && (
          <button type="button" onClick={() => setPreviewing(!previewing)}>
            {previewing ? "Hide the preview" : "Preview the change"}
          </button>
        )}
      </div>
      {previewing && !data.up_to_date && (
        <>
          {data.problems.length > 0 ? (
            <div role="alert" className="error">
              <p>The statements can't be built that way yet, so the year can't move:</p>
              <ul>
                {data.problems.map((p, i) => (
                  <li key={i}>{describeDetail(p)}</li>
                ))}
              </ul>
            </div>
          ) : data.changes.length === 0 ? (
            <p className="muted">The statements would look the same.</p>
          ) : (
            <table className={`table ${styles.changes}`}>
              <thead>
                <tr>
                  <th>Statement</th>
                  <th>Now</th>
                  <th>After the move</th>
                </tr>
              </thead>
              <tbody>
                {data.changes.map((c, i) => (
                  <tr key={i}>
                    <td>{c.statement}</td>
                    <td>
                      <Summary row={c.before} />
                    </td>
                    <td>
                      <Summary row={c.after} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!data.current_builds && <p className="muted">The statements don't build the way they are now, so every row is new.</p>}
          <ErrorMessage error={move.error} />
          {editable && (
            <button
              type="button"
              className="primary"
              disabled={data.problems.length > 0 || move.isPending}
              onClick={() =>
                move.mutate(
                  {
                    kind: "move_year_layout",
                    payload: { client_year_id: year.id, ...(mappingId ? { mapping_id: mappingId } : {}) },
                  },
                  { onSuccess: () => setPreviewing(false) },
                )
              }
            >
              Move this year
            </button>
          )}
        </>
      )}
    </section>
  );
}

function Summary({ row }: { row: RowSummary | null }) {
  if (!row) {
    return <span className="muted">Not shown</span>;
  }
  return (
    <>
      <span>{row.label}</span>
      {row.current !== null && <span className={styles.amount}>{formatStatementDollars(row.current)}</span>}
      {row.accounts.length > 0 && <span className={`muted ${styles.accounts}`}>{row.accounts.join(", ")}</span>}
    </>
  );
}
