import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { can, useCurrentUser } from "../auth";
import { ChartPreview } from "../components/ChartPreview";
import { ErrorMessage } from "../components/ErrorMessage";
import { Icon } from "../lib/icons";
import { keys, useClients, usePractice } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { Badge, ButtonLink, EmptyState, PageHeader } from "../ui";
import styles from "./ClientsPage.module.css";

export function ClientsPage() {
  const me = useCurrentUser();
  const clients = useClients();
  return (
    <>
      <PageHeader
        icon={<Icon name="nav.clients" fallback="📒" />}
        title="Clients"
        actions={
          can(me, "staff") && (
            <ButtonLink to="/businesses/new" variant="primary">
              <Icon name="business.new" fallback="🧾" /> Set up a business
            </ButtonLink>
          )
        }
      />
      <ErrorMessage error={clients.error} />
      {clients.data && clients.data.length === 0 && (
        <EmptyState title="No clients yet.">
          <p>Set up a business, or add a client below, and it shows here.</p>
        </EmptyState>
      )}
      {clients.data && clients.data.length > 0 && (
        <table className={`table ${styles.list}`}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Entity type</th>
            </tr>
          </thead>
          <tbody>
            {clients.data.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={c.is_business ? `/businesses/${c.id}` : `/clients/${c.id}`} className={styles.name}>
                    {c.name}
                  </Link>
                </td>
                <td>
                  <Badge>{c.entity_type.replace(/_/g, " ")}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {can(me, "staff") && <NewClientForm />}
    </>
  );
}

function NewClientForm() {
  const me = useCurrentUser();
  const practice = usePractice();
  const create = useCommand([keys.clients]);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState("");
  const [retainedEarnings, setRetainedEarnings] = useState("");

  const charts = practice.data?.master_charts ?? [];
  const chart = charts.find((c) => c.entity_type === entityType) ?? charts[0];
  const equity = (chart?.accounts ?? []).filter((a) => a.account_type === "equity" && a.active);
  const re = equity.some((a) => a.code === retainedEarnings) ? retainedEarnings : (equity[0]?.code ?? "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!chart) {
      return;
    }
    create.mutate(
      {
        kind: "create_client",
        payload: { name: name.trim(), entity_type: chart.entity_type, retained_earnings: re, rounding_priority: [] },
      },
      { onSuccess: (accepted) => void navigate(`/clients/${accepted.entity_id}`) },
    );
  };

  if (practice.isSuccess && charts.length === 0) {
    return (
      <p className="muted">
        <Icon name="defaults.none_yet" fallback="🌱" /> There are no master charts yet, so clients can't be created.{" "}
        {can(me, "practice_admin") ? (
          <Link to="/settings">Install a starter set in Settings</Link>
        ) : (
          "Ask a practice admin to set one up."
        )}
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="card form">
      <h2>New client</h2>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="field">
        <span>Entity type</span>
        <select value={chart?.entity_type ?? ""} onChange={(e) => setEntityType(e.target.value)}>
          {charts.map((c) => (
            <option key={c.id} value={c.entity_type}>
              {c.entity_type} ({c.name})
            </option>
          ))}
        </select>
      </label>
      <ChartPreview chart={chart} />
      <label className="field">
        <span>Retained earnings account</span>
        <select value={re} onChange={(e) => setRetainedEarnings(e.target.value)}>
          {equity.map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        The client's chart starts as a copy of the master chart. Its rounding priority list starts empty; set it on the
        chart page.
      </p>
      <ErrorMessage error={create.error} />
      <div>
        <button type="submit" className="primary" disabled={create.isPending || !chart || !re}>
          Create client
        </button>
      </div>
    </form>
  );
}
