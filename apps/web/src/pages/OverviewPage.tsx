import { isOwner, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { Icon } from "../lib/icons";
import { useClients } from "../lib/queries";
import { useViewAs } from "../lib/viewAs";
import { ButtonLink, EmptyState } from "../ui";
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
  const { real } = useViewAs();
  if (clients.error) {
    return <ErrorMessage error={clients.error} />;
  }
  if (!clients.data) {
    return <p className="muted">Loading…</p>;
  }
  // An owner sees only their own business, so this is it. Skip any client that isn't a business
  // (those have no statements or owner's screen).
  const mine = clients.data.find((c) => c.is_business);
  if (!mine) {
    return (
      <EmptyState title="No business yet.">
        <p>Set up your business to upload bank statements and see the tax you'd pay.</p>
        {!isOwner(real) && (
          <ButtonLink to="/businesses/new" variant="primary">
            <Icon name="business.save_supply" fallback="🧾" /> Set up a business
          </ButtonLink>
        )}
      </EmptyState>
    );
  }
  return <BusinessPage clientId={mine.id} />;
}
