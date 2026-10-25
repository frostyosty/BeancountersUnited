import { Link, useParams } from "react-router";
import { can, useCurrentUser } from "../auth";
import { AccountTable, AddAccountForm, type ChartCommands } from "../components/AccountEditor";
import { ErrorMessage } from "../components/ErrorMessage";
import { entityLabel } from "../lib/entityTypes";
import { Icon } from "../lib/icons";
import { keys, usePractice } from "../lib/queries";

/** The commands that edit one entity type's master chart. */
function masterCommands(entity_type: string): ChartCommands {
  return {
    rename: (code, name) => ({ kind: "rename_master_account", payload: { entity_type, code, name } }),
    setGst: (code, default_gst) => ({ kind: "set_master_account_gst", payload: { entity_type, code, default_gst } }),
    setActive: (code, active) => ({ kind: "set_master_account_active", payload: { entity_type, code, active } }),
    add: (account) => ({ kind: "add_master_account", payload: { entity_type, account } }),
    invalidates: [keys.practice],
  };
}

/** A practice master chart: the chart each new client of its entity type starts with a copy of. */
export function MasterChartPage() {
  const { entityType = "" } = useParams();
  const me = useCurrentUser();
  const practice = usePractice();
  if (!can(me, "practice_admin")) {
    return <p>Only practice admins can change practice settings.</p>;
  }
  if (practice.error) {
    return <ErrorMessage error={practice.error} />;
  }
  if (!practice.data) {
    return <p className="muted">Loading…</p>;
  }
  const chart = practice.data.master_charts.find((c) => c.entity_type === entityType);
  const crumbs = (
    <p className="crumbs">
      <Link to="/settings">Practice settings</Link> /
    </p>
  );
  if (!chart) {
    return (
      <>
        {crumbs}
        <p>There's no {entityLabel(entityType)} master chart.</p>
      </>
    );
  }
  const commands = masterCommands(chart.entity_type);
  return (
    <>
      {crumbs}
      <h1>
        <Icon name="defaults.chart" fallback="🗂️" /> {chart.name} master chart
      </h1>
      <p className="muted">
        Each new {entityLabel(chart.entity_type)} client starts with a copy of this chart. Changing it never alters a
        client already set up: change theirs on the client's own chart page.
      </p>
      <AccountTable accounts={chart.accounts} editable commands={commands} />
      <AddAccountForm commands={commands} />
    </>
  );
}
