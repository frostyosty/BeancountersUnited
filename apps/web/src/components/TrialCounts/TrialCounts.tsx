import type { ClaimFrom } from "@acct/types/ClaimFrom";
import type { TrialCounts as Counts } from "@acct/types/TrialCounts";
import type { TrialTally } from "@acct/types/TrialTally";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "../../auth";
import { getJson } from "../../lib/api";
import { formatDate } from "../../lib/dates";
import { Icon } from "../../lib/icons";
import { Card } from "../../ui";
import { ErrorMessage } from "../ErrorMessage";
import styles from "./TrialCounts.module.css";

/** What led to a save, in words. */
const FROM_LABEL: Record<ClaimFrom, string> = {
  banner: "Banner or header button",
  accountant_view: "Accountant view",
  saving: "First saving line",
  submit: "Submit step",
  "locked:invite": "Invite your accountant",
  "locked:ai": "AI suggestions",
  "locked:pdf": "PDF download",
  expiry: "Welcome back line",
};

/** The prompt's name; `null` is a save with no `from` recorded. */
export const fromLabel = (from: ClaimFrom | null): string => (from === null ? "not recorded" : FROM_LABEL[from]);

/** A tally's saves by prompt as one line: "Banner or header button 2, First saving line 1". */
function savesLine(tally: TrialTally): string {
  return tally.saves_by_from.length === 0 ? "None" : tally.saves_by_from.map((s) => `${fromLabel(s.from)} ${s.saves}`).join(", ");
}

/**
 * The trials, counted (M21, ADR 015, 5): started, saved and expired by week, and saves by the prompt that
 * led to them. For overseers only; it renders nothing, and asks for nothing, for anyone else. The
 * server counts them from the log, and this only shows its numbers: nothing is added up here.
 */
export function TrialCounts() {
  const me = useCurrentUser();
  if (me.role !== "overseer") {
    return null;
  }
  return <TrialCountsCard />;
}

function TrialCountsCard() {
  const counts = useQuery({ queryKey: ["overseer", "trials"], queryFn: () => getJson<Counts>("/api/overseer/trials") });
  return (
    <Card title="Trials" icon={<Icon name="overseer.trials" fallback="📊" />}>
      <p className="muted">
        The last 12 weeks, newest first, weeks starting Monday (UTC). Counts only: nothing here shows what a visitor
        uploaded.
      </p>
      <ErrorMessage error={counts.error} />
      {counts.data && <Table counts={counts.data} />}
      {!counts.data && !counts.error && <p className="muted">Counting…</p>}
    </Card>
  );
}

function Table({ counts }: { counts: Counts }) {
  return (
    <div className={styles.scroll}>
      <table className="table">
        <caption className="muted">Trials by week</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">Started</th>
            <th scope="col">Saved</th>
            <th scope="col">Moved into an account</th>
            <th scope="col">Expired: not back</th>
            <th scope="col">Expired: deleted by them</th>
            <th scope="col">Expired: example finished</th>
            <th scope="col">Saves by prompt</th>
          </tr>
        </thead>
        <tbody>
          {counts.weeks.map((w) => (
            <Row key={w.starts} label={formatDate(w.starts.slice(0, 10))} tally={w.counts} />
          ))}
        </tbody>
        <tfoot>
          <Row label="All 12 weeks" tally={counts.total} total />
        </tfoot>
      </table>
    </div>
  );
}

function Row({ label, tally, total = false }: { label: string; tally: TrialTally; total?: boolean }) {
  return (
    <tr className={total ? styles.total : undefined}>
      <th scope="row">{label}</th>
      <td>{tally.started}</td>
      <td>{tally.saved}</td>
      <td>{tally.moved}</td>
      <td>{tally.expired_unused}</td>
      <td>{tally.expired_by_you}</td>
      <td>{tally.expired_example_finished}</td>
      <td>{savesLine(tally)}</td>
    </tr>
  );
}
