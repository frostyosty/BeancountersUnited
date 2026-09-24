import type { ClientDetail } from "@acct/types/ClientDetail";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import { can, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { formatDate, nextYear, previousYear } from "../lib/dates";
import { keys, useClient, usePractice } from "../lib/queries";
import { useCommand } from "../lib/useCommand";

export function ClientPage() {
  const { clientId = "" } = useParams();
  const me = useCurrentUser();
  const client = useClient(clientId);

  if (client.error) {
    return <ErrorMessage error={client.error} />;
  }
  if (!client.data) {
    return <p className="muted">Loading…</p>;
  }
  const c = client.data;
  return (
    <>
      <p className="crumbs">
        <Link to="/">Clients</Link> /
      </p>
      <h1>{c.name}</h1>
      <dl className="facts">
        <dt>Entity type</dt>
        <dd>{c.entity_type}</dd>
        <dt>Retained earnings</dt>
        <dd>{c.retained_earnings}</dd>
        <dt>Rounding priority</dt>
        <dd>{c.rounding_priority.length ? c.rounding_priority.join(", ") : "none set"}</dd>
      </dl>
      <p>
        <Link to={`/clients/${c.id}/chart`}>Chart of accounts and rounding priority</Link>
      </p>

      <h2>Years</h2>
      {c.years.length === 0 ? (
        <p className="muted">No years yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Year</th>
              <th>Status</th>
              <th>Books from</th>
            </tr>
          </thead>
          <tbody>
            {[...c.years].reverse().map((y) => (
              <tr key={y.id}>
                <td>
                  {formatDate(y.start)} to {formatDate(y.end)}
                </td>
                <td>{y.status}</td>
                <td>{y.books_source === null ? "—" : y.books_source.replace(/_/g, " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {can(me, "staff") && <NewYearForm client={c} />}
    </>
  );
}

type Which = "next" | "previous" | "other";

function NewYearForm({ client }: { client: ClientDetail }) {
  const practice = usePractice();
  const create = useCommand([keys.client(client.id)]);
  const first = client.years[0];
  const last = client.years.at(-1);
  const next = last && nextYear(last.end);
  const previous = first && previousYear(first.start);
  const [which, setWhich] = useState<Which>("next");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [mappingId, setMappingId] = useState("");

  const chosen = which === "next" ? next : which === "previous" ? previous : undefined;
  const dates = chosen ?? { start, end };

  // A first year needs a mapping when the practice has more than one for this entity type;
  // later years carry their neighbour's.
  const mappings = (practice.data?.mappings ?? []).filter((m) => m.entity_type === client.entity_type);
  const chooseMapping = !last && mappings.length > 1;
  const mapping = mappings.some((m) => m.id === mappingId) ? mappingId : (mappings[0]?.id ?? "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      kind: "create_client_year",
      payload: { client_id: client.id, ...dates, ...(chooseMapping ? { mapping_id: mapping } : {}) },
    });
  };

  return (
    <form onSubmit={submit} className="card form">
      <h2>Add a year</h2>
      {next && previous && (
        <label className="field">
          <span>Which year</span>
          <select value={which} onChange={(e) => setWhich(e.target.value as Which)}>
            <option value="next">
              Next: {formatDate(next.start)} to {formatDate(next.end)}
            </option>
            <option value="previous">
              Previous: {formatDate(previous.start)} to {formatDate(previous.end)}
            </option>
            <option value="other">Other dates (a short or long year)</option>
          </select>
        </label>
      )}
      {!chosen && (
        <div className="row">
          <label className="field">
            <span>Start</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>
          <label className="field">
            <span>End</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </label>
        </div>
      )}
      {chooseMapping && (
        <label className="field">
          <span>Mapping</span>
          <select value={mapping} onChange={(e) => setMappingId(e.target.value)}>
            {mappings.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} (version {m.latest_version})
              </option>
            ))}
          </select>
        </label>
      )}
      <ErrorMessage error={create.error} />
      <div>
        <button type="submit" className="primary" disabled={create.isPending}>
          Add year
        </button>
      </div>
    </form>
  );
}
