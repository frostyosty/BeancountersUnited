import type { Account } from "@acct/types/Account";
import type { ClientDetail } from "@acct/types/ClientDetail";
import type { YearSummary } from "@acct/types/YearSummary";
import { Outlet, useOutletContext, useParams } from "react-router";
import { ErrorMessage } from "../components/ErrorMessage";
import { Icon } from "../lib/icons";
import { formatDate, periodEndedLabel } from "../lib/dates";
import { useChart, useClient, useYear } from "../lib/queries";
import { Badge, PageHeader, Tab, Tabs } from "../ui";

export type YearContext = { year: YearSummary; client: ClientDetail; chart: Account[] };

export function useYearContext(): YearContext {
  return useOutletContext<YearContext>();
}

/** A client-year's pages: its tabs share the year, the client and the client's chart. */
export function YearLayout() {
  const { yearId = "" } = useParams();
  const year = useYear(yearId);
  const clientId = year.data?.client_id ?? "";
  const client = useClient(clientId);
  const chart = useChart(clientId);

  const error = year.error ?? client.error ?? chart.error;
  if (error) {
    return <ErrorMessage error={error} />;
  }
  if (!year.data || !client.data || !chart.data) {
    return <p className="muted">Loading…</p>;
  }
  const y = year.data;
  const context: YearContext = { year: y, client: client.data, chart: chart.data };
  return (
    <>
      <PageHeader
        crumbs={[
          { to: "/", label: "Clients" },
          { to: `/clients/${clientId}`, label: client.data.name },
        ]}
        title={periodEndedLabel(y.start, y.end)}
        badge={<Badge tone={y.status === "finalised" ? "ok" : "accent"}>{y.status}</Badge>}
        subtitle={
          <>
            {formatDate(y.start)} to {formatDate(y.end)}
            {y.books_source && ` · books from ${y.books_source.replace(/_/g, " ")}`}
          </>
        }
      />
      <Tabs label="Year">
        <Tab to="" end>
          <Icon name="year.journals" fallback="📒" /> Journals
        </Tab>
        <Tab to="tb">
          <Icon name="year.tb" fallback="⚖️" /> Trial balance
        </Tab>
        <Tab to="import">
          <Icon name="year.import" fallback="📥" /> Import TB
        </Tab>
        <Tab to="assets">
          <Icon name="year.assets" fallback="🚜" /> Assets
        </Tab>
        <Tab to="statements">
          <Icon name="year.statements" fallback="🧾" /> Statements
        </Tab>
        <Tab to="notes">
          <Icon name="year.notes" fallback="📝" /> Notes
        </Tab>
        <Tab to="reconcile">
          <Icon name="year.reconcile" fallback="🏦" /> Reconcile
        </Tab>
        <Tab to="gl">
          <Icon name="year.gl" fallback="📖" /> General ledger
        </Tab>
        <Tab to="analysis">
          <Icon name="year.analysis" fallback="📊" /> Analysis
        </Tab>
        <Tab to="finalise">
          <Icon name="year.finalise" fallback="🔏" /> Finalise
        </Tab>
      </Tabs>
      <Outlet context={context} />
    </>
  );
}
