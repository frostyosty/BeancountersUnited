import type { Role } from "@acct/types/Role";
import { Navigate, Outlet } from "react-router";
import { can, isOwner, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { useHistorySharing } from "../lib/historySharing";
import { Icon } from "../lib/icons";
import { keys, useClients } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { useViewAs } from "../lib/viewAs";
import { ButtonLink, Card, Notice, PageHeader, Tab, Tabs } from "../ui";
import { AccountPage } from "./AccountPage";
import { SettingsPage } from "./SettingsPage";

const ROLE_LABEL: Record<Role, string> = {
  overseer: "Overseer",
  practice_admin: "Practice admin",
  staff: "Staff",
  viewer: "Viewer",
  business_owner: "Business owner",
};

/** Settings: one place, with a tab for each thing the signed-in user can change. */
export function SettingsLayout() {
  const me = useCurrentUser();
  const { real } = useViewAs();
  return (
    <>
      <PageHeader icon={<Icon name="nav.settings" fallback="⚙️" />} title="Settings" />
      <Tabs label="Settings">
        {can(me, "practice_admin") && !isOwner(me) && (
          <Tab to="/settings" end>
            <Icon name="settings.practice" fallback="🏢" /> Practice
          </Tab>
        )}
        {can(real, "practice_admin") && !isOwner(real) && (
          <Tab to="/settings/admin">
            <Icon name="settings.admin" fallback="🛠️" /> Admin
          </Tab>
        )}
        <Tab to="/settings/account">
          <Icon name="nav.account" fallback="👤" /> My account
        </Tab>
        <Tab to="/settings/tools">
          <Icon name="settings.tools" fallback="🧰" /> Tools
        </Tab>
      </Tabs>
      <Outlet />
    </>
  );
}

/** `/settings`: the practice tab, or My account for anyone who has no practice settings. */
export function SettingsHome() {
  const me = useCurrentUser();
  return can(me, "practice_admin") && !isOwner(me) ? <SettingsPage /> : <Navigate to="/settings/account" replace />;
}

/** Admin tab: what only an admin needs. For now, previewing the site as another role. */
export function AdminSettingsTab() {
  const { real, as, options, setAs } = useViewAs();
  if (!can(real, "practice_admin") || isOwner(real)) {
    return <Navigate to="/settings/account" replace />;
  }
  return (
    <section>
      <h2>
        <Icon name="settings.view_as" fallback="👁️" /> View the site as
      </h2>
      <p className="muted">
        See the screens another role gets. This only changes what's shown to you: the server still checks everything
        as you, so you can't do anything you couldn't already.
      </p>
      <label className="field">
        <span>Viewing as</span>
        <select value={as ?? real.role} onChange={(e) => setAs(e.target.value === real.role ? null : (e.target.value as Role))}>
          <option value={real.role}>Myself ({ROLE_LABEL[real.role]})</option>
          {options.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      {as && (
        <Notice tone="info">
          You're viewing as {ROLE_LABEL[as].toLowerCase()}. Use the bar at the top of any page to stop.
        </Notice>
      )}
    </section>
  );
}

/** Tools tab: small extras for anyone signed in, on any plan. */
export function ToolsTab() {
  return (
    <section>
      <h2>
        <Icon name="settings.tools" fallback="🧰" /> Tools
      </h2>
      <p className="muted">Handy extras that come free with your account.</p>
      <Card title="Invoice maker" icon={<Icon name="tools.invoice" fallback="🧾" />}>
        <p>
          Lay out an invoice with your logo, items and payment details, then save it as a PDF to send. Your invoices
          and templates are saved to your account, where only you can see them.
        </p>
        <ButtonLink to="/tools/invoice" variant="primary">
          Open the invoice maker
        </ButtonLink>
      </Card>
    </section>
  );
}

/** My account tab: your login, and for a business owner what your accountants can see. */
export function MyAccountTab() {
  const me = useCurrentUser();
  return (
    <>
      <AccountPage />
      {isOwner(me) && <OwnerSharing />}
    </>
  );
}

/** The owner's say over their accountants seeing the owner's own edits in Changes. */
function OwnerSharing() {
  const clients = useClients();
  const clientId = clients.data?.[0]?.id;
  const sharing = useHistorySharing(clientId);
  const command = useCommand([keys.business(clientId ?? "")]);
  if (!clientId) {
    return null;
  }
  const shared = sharing.data?.share_owner_edits ?? false;
  return (
    <section className="card form">
      <h2>
        <Icon name="settings.sharing" fallback="🤝" /> What your accountant sees
      </h2>
      <p className="muted">
        Your accountant sees what they change in Changes. Your own edits stay private unless you choose to share them.
      </p>
      <label className="field">
        <span>
          <input
            type="checkbox"
            checked={shared}
            disabled={command.isPending || !sharing.data}
            onChange={(e) =>
              command.mutate({
                kind: "set_history_sharing",
                payload: { client_id: clientId, share_owner_edits: e.target.checked },
              })
            }
          />{" "}
          Let my accountant see my edits in Changes
        </span>
      </label>
      <ErrorMessage error={command.error ?? sharing.error} />
    </section>
  );
}
