import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { can, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { keys, useClients, usePractice } from "../lib/queries";
import { useCommand } from "../lib/useCommand";

export function ClientsPage() {
  const me = useCurrentUser();
  const clients = useClients();
  return (
    <>
      <h1>Clients</h1>
      <ErrorMessage error={clients.error} />
      {clients.data && clients.data.length === 0 && <p className="muted">No clients yet.</p>}
      {clients.data && clients.data.length > 0 && (
        <table className="table">
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
                  <Link to={`/clients/${c.id}`}>{c.name}</Link>
                </td>
                <td>{c.entity_type}</td>
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
    return <p className="muted">There are no master charts yet, so clients can't be created.</p>;
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
