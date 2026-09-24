import type { Account } from "@acct/types/Account";
import type { ClientDetail } from "@acct/types/ClientDetail";
import type { YearSummary } from "@acct/types/YearSummary";
import { Link, NavLink, Outlet, useOutletContext, useParams } from "react-router";
import { ErrorMessage } from "../components/ErrorMessage";
import { formatDate } from "../lib/dates";
import { useChart, useClient, useYear } from "../lib/queries";
import styles from "./YearLayout.module.css";

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
      <p className="crumbs">
        <Link to="/">Clients</Link> / <Link to={`/clients/${clientId}`}>{client.data.name}</Link> /
      </p>
      <h1>
        Year ended {formatDate(y.end)}{" "}
        <span className={y.status === "finalised" ? styles.finalised : styles.open}>{y.status}</span>
      </h1>
      <p className="muted">
        {formatDate(y.start)} to {formatDate(y.end)}
        {y.books_source && ` · books from ${y.books_source.replace(/_/g, " ")}`}
      </p>
      <nav className={styles.tabs} aria-label="Year">
        <NavLink to="" end>
          Journals
        </NavLink>
        <NavLink to="tb">Trial balance</NavLink>
        <NavLink to="import">Import TB</NavLink>
        <NavLink to="assets">Assets</NavLink>
        <NavLink to="statements">Statements</NavLink>
      </nav>
      <Outlet context={context} />
    </>
  );
}
