import { isOwner, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { useClients } from "../lib/queries";
import { EmptyState } from "../ui";
import { BusinessPage } from "./BusinessPage";
import { ClientsPage } from "./ClientsPage";

/** `/`: the practice's client list, or, for a business owner, their business's Overview. */
export function HomeRoute() {
  return isOwner(useCurrentUser()) ? <OverviewPage /> : <ClientsPage />;
}

/**
 * A business owner's home: the three areas (upload, tax to pay, submit) of their one business.
 * They never see a list of clients.
 */
export function OverviewPage() {
  const clients = useClients();
  if (clients.error) {
    return <ErrorMessage error={clients.error} />;
  }
  if (!clients.data) {
    return <p className="muted">Loading…</p>;
  }
  const mine = clients.data[0];
  if (!mine) {
    return (
      <EmptyState title="No business yet.">
        <p>Your business will show here once it's set up.</p>
      </EmptyState>
    );
  }
  return <BusinessPage clientId={mine.id} />;
}
