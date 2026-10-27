import type { MasterChartView } from "@acct/types/MasterChartView";
import { Icon } from "../lib/icons";
import styles from "./ChartPreview.module.css";

type Account = MasterChartView["accounts"][number];

const GROUP_LABELS: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

export interface CodeGroup {
  from: string;
  to: string;
  type: string;
  count: number;
}

/** Codes compare as numbers when they look like them (`99` before `100`), otherwise as text. */
function compareCodes(a: string, b: string): number {
  const x = Number.parseFloat(a);
  const y = Number.parseFloat(b);
  return Number.isNaN(x) || Number.isNaN(y) || x === y ? a.localeCompare(b) : x - y;
}

/** The chart's code ranges: each run of same-type accounts, in code order, such as 200 to 249 income. */
export function codeGroups(accounts: Account[]): CodeGroup[] {
  const groups: CodeGroup[] = [];
  for (const a of [...accounts].sort((p, q) => compareCodes(p.code, q.code))) {
    const last = groups.at(-1);
    if (last && last.type === a.account_type) {
      last.to = a.code;
      last.count += 1;
    } else {
      groups.push({ from: a.code, to: a.code, type: a.account_type, count: 1 });
    }
  }
  return groups;
}

/** The accounts of a chart, with the code ranges that group them alongside. */
export function ChartPreview({ chart }: { chart: Pick<MasterChartView, "name" | "accounts"> | undefined }) {
  if (!chart) {
    return (
      <p className="muted">
        <Icon name="defaults.none_yet" fallback="🌱" /> An empty chart has no accounts yet. Add them on its page.
      </p>
    );
  }
  const sorted = [...chart.accounts].sort((a, b) => compareCodes(a.code, b.code));
  return (
    <div className={styles.preview} aria-label={`Preview of ${chart.name}`}>
      <div className={styles.accounts}>
        <table className="table">
          <tbody>
            {sorted.map((a) => (
              <tr key={a.code} className={a.active ? undefined : styles.inactive}>
                <td>{a.code}</td>
                <td>{a.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.groups}>
        <strong>
          <Icon name="defaults.ranges" fallback="🧭" /> How the codes group
        </strong>
        <ul>
          {codeGroups(chart.accounts).map((g) => (
            <li key={`${g.from}-${g.type}`}>
              <span className={styles.range}>{g.from === g.to ? g.from : `${g.from}–${g.to}`}</span>{" "}
              {GROUP_LABELS[g.type] ?? g.type}{" "}
              <span className="muted">
                ({g.count} {g.count === 1 ? "account" : "accounts"})
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
