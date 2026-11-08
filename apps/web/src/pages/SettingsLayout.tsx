import { useState } from "react";
import { Navigate, Outlet, useNavigate } from "react-router";
import { can, isOwner, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { PracticeRequests } from "../components/PracticeRequests";
import { TrialCounts } from "../components/TrialCounts";
import { useHistorySharing } from "../lib/historySharing";
import { Icon } from "../lib/icons";
import { keys, useClients, useUsers } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { ROLE_LABEL, useActingCommands, useViewAs } from "../lib/viewAs";
import { Button, ButtonLink, Card, Field, Notice, PageHeader, Tab, Tabs } from "../ui";
import { AccountPage } from "./AccountPage";
import { SettingsPage } from "./SettingsPage";

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
        {real.role === "overseer" && (
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

/** Admin tab: what only an overseer needs. For now, viewing the site as another user (ADR 013). */
export function AdminSettingsTab() {
  const { real, acting } = useViewAs();
  if (real.role !== "overseer") {
    return <Navigate to="/settings/account" replace />;
  }
  return (
    <section>
      <h2>
        <Icon name="settings.view_as" fallback="👁️" /> View as someone
      </h2>
      <p className="muted">
        See exactly what one person sees, to help with a question or a problem. It's read-only unless you allow changes,
        it ends after 30 minutes, and the person can read it in their Changes, with your reason.
      </p>
      {acting ? (
        <Notice tone="info">
          You're viewing as {acting.name}. Use the bar at the top of any page to end it before starting another.
        </Notice>
      ) : (
        <StartViewing realId={real.id} />
      )}
      <PracticeRequests />
    </section>
  );
}

function StartViewing({ realId }: { realId: string }) {
  const users = useUsers();
  const { start } = useActingCommands();
  const navigate = useNavigate();
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const people = (users.data ?? []).filter((u) => u.active && u.role !== "overseer" && u.id !== realId);
  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate({ userId, reason: reason.trim() }, { onSuccess: () => navigate("/") });
      }}
    >
      <Field label="Person">
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose someone…</option>
          {people.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name} · {ROLE_LABEL[u.role]}
            </option>
          ))}
        </select>
      </Field>
      <p className="muted">
        A business owner sees their own business. A business with no owner user can be opened as yourself.
      </p>
      <Field label="Why are you viewing as them?" hint="They can read this in their Changes.">
        <textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div>
        <Button type="submit" variant="primary" busy={start.isPending} disabled={!userId || !reason.trim()}>
          <Icon name="acting.banner" fallback="👁️" /> Start viewing
        </Button>
      </div>
      <ErrorMessage error={start.error ?? users.error} />
    </form>
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
      <TrialCounts />
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
