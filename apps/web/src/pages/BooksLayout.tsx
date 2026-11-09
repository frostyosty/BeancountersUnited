import { useEffect, useMemo, useState } from "react";
import { Navigate, Outlet, useParams } from "react-router";
import { isOwner, useCurrentUser } from "../auth";
import { Changes } from "../components/HistoryPanel";
import { ErrorMessage } from "../components/ErrorMessage";
import { ViewSwitch } from "../components/ViewSwitch";
import { rememberAccountantViewOpened } from "../lib/books";
import { formatDate, periodEndedLabel } from "../lib/dates";
import { Icon } from "../lib/icons";
import { type PdfMode, ReadOnlyContext } from "../lib/readOnly";
import { useChart, useClient } from "../lib/queries";
import { ButtonLink, EmptyState, Notice, PageHeader, Tab, Tabs } from "../ui";
import type { YearContext } from "./YearLayout";

/**
 * The accountant view of a business's books (M21, ADR 015, 1): the accountant's own year screens,
 * for the business's latest year, read-only. It is for owners and guests, who get a switch to it on
 * their business screen. The tabs are the practice's own components; they read `useReadOnly()` and
 * leave their write controls out.
 */
export function BooksLayout() {
  const { clientId = "" } = useParams();
  const me = useCurrentUser();
  const client = useClient(clientId);
  const chart = useChart(clientId);
  const [picked, setPicked] = useState<string | null>(null);

  const guestId = me.guest ? me.id : null;
  // So Save your work can ask "Who are you?" (ADR 015, 6).
  useEffect(() => {
    if (guestId) {
      rememberAccountantViewOpened(guestId);
    }
  }, [guestId]);

  // A guest has no account to download a PDF from yet; an example can never be saved.
  const isExample = !!me.guest && me.guest.example?.business_id === clientId;
  const pdf: PdfMode = !me.guest ? "download" : isExample ? "example" : "save_first";
  const readOnly = useMemo(() => ({ readOnly: true, pdf }), [pdf]);

  const error = client.error ?? chart.error;
  if (error) {
    return <ErrorMessage error={error} />;
  }
  if (!client.data || !chart.data) {
    return <p className="muted">Loading…</p>;
  }
  const c = client.data;
  const years = c.years;
  // The business's latest year is the one the statements were uploaded into.
  const year = years.find((y) => y.id === picked) ?? years.at(-1);
  const back = `/businesses/${clientId}`;

  return (
    <ReadOnlyContext.Provider value={readOnly}>
      <PageHeader
        icon={<Icon name="accountant_view.accountant" fallback="📒" />}
        title={c.name}
        subtitle={year ? `${formatDate(year.start)} to ${formatDate(year.end)}` : undefined}
        actions={
          <>
            {isOwner(me) && <ViewSwitch businessId={clientId} current="accountant" />}
            <ButtonLink to={back} variant="secondary" size="sm">
              <Icon name="accountant_view.back" fallback="↩️" /> Back to your tax
            </ButtonLink>
          </>
        }
      />
      <Notice tone="info" role="note">
        This is what your accountant sees. They work on these same books, so nothing gets typed in twice.
      </Notice>

      {!year ? (
        <EmptyState icon={<Icon name="accountant_view.empty" fallback="🌱" />} title="No books yet">
          Upload a bank statement and they fill in.
        </EmptyState>
      ) : (
        <>
          {years.length > 1 && (
            <p>
              <label>
                Year{" "}
                <select value={year.id} onChange={(e) => setPicked(e.target.value)}>
                  {[...years].reverse().map((y) => (
                    <option key={y.id} value={y.id}>
                      {periodEndedLabel(y.start, y.end)}
                    </option>
                  ))}
                </select>
              </label>
            </p>
          )}
          <Tabs label="Books">
            <Tab to="statements">
              <Icon name="year.statements" fallback="🧾" /> Statements
            </Tab>
            <Tab to="tb">
              <Icon name="year.tb" fallback="⚖️" /> Trial balance
            </Tab>
            <Tab to="journals">
              <Icon name="ui.empty" fallback="📒" /> Journals
            </Tab>
            <Tab to="gl">
              <Icon name="year.gl" fallback="📖" /> General ledger
            </Tab>
            <Tab to="assets">
              <Icon name="year.assets" fallback="🚜" /> Assets
            </Tab>
          </Tabs>
          <Outlet context={{ year, client: c, chart: chart.data } satisfies YearContext} />
        </>
      )}
    </ReadOnlyContext.Provider>
  );
}

/** `/books` on its own opens the statements. */
export function BooksIndex() {
  return <Navigate to="statements" replace />;
}

/** Changes for this business, in the page as well as the side panel. */
export function BooksChangesTab() {
  const { clientId = "" } = useParams();
  return <Changes business={clientId} people={[]} />;
}
