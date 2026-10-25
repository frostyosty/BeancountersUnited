import type { Account } from "@acct/types/Account";
import type { ClientDetail } from "@acct/types/ClientDetail";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { can, useCurrentUser } from "../auth";
import { AccountTable, AddAccountForm, type ChartCommands } from "../components/AccountEditor";
import { ErrorMessage } from "../components/ErrorMessage";
import { keys, useChart, useClient } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import styles from "./ChartPage.module.css";

/** The commands that edit one client's chart. */
function clientCommands(clientId: string): ChartCommands {
  const client_id = clientId;
  return {
    rename: (code, name) => ({ kind: "rename_account", payload: { client_id, code, name } }),
    setGst: (code, default_gst) => ({ kind: "set_account_gst", payload: { client_id, code, default_gst } }),
    setActive: (code, active) => ({ kind: "set_account_active", payload: { client_id, code, active } }),
    add: (account) => ({ kind: "add_account", payload: { client_id, account } }),
    invalidates: [keys.chart(clientId)],
  };
}

export function ChartPage() {
  const { clientId = "" } = useParams();
  const me = useCurrentUser();
  const client = useClient(clientId);
  const chart = useChart(clientId);
  const editable = can(me, "staff");

  if (client.error || chart.error) {
    return <ErrorMessage error={client.error ?? chart.error} />;
  }
  if (!client.data || !chart.data) {
    return <p className="muted">Loading…</p>;
  }
  const commands = clientCommands(clientId);
  const retained = client.data.retained_earnings;
  return (
    <>
      <p className="crumbs">
        <Link to="/">Clients</Link> / <Link to={`/clients/${clientId}`}>{client.data.name}</Link> /
      </p>
      <h1>Chart of accounts</h1>
      <div className={styles.layout}>
        <section>
          <AccountTable
            accounts={chart.data}
            editable={editable}
            commands={commands}
            tag={(a) => (a.code === retained ? "retained earnings" : null)}
          />
          {editable && <AddAccountForm commands={commands} />}
        </section>
        <section>
          <RoundingPriority client={client.data} accounts={chart.data} editable={editable} />
        </section>
      </div>
    </>
  );
}

function RoundingPriority({ client, accounts, editable }: { client: ClientDetail; accounts: Account[]; editable: boolean }) {
  const save = useCommand([keys.client(client.id)]);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [adding, setAdding] = useState("");
  const list = draft ?? client.rounding_priority;
  const names = new Map(accounts.map((a) => [a.code, a.name]));
  const available = accounts.filter((a) => !list.includes(a.code));

  const move = (i: number, by: number) => {
    const next = [...list];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item!);
    setDraft(next);
  };

  return (
    <div className="card">
      <h2>Rounding priority</h2>
      <p className="muted">
        When a section of the statements needs a rounding adjustment, it goes on the line for the first account here that
        maps into that section and has a balance. If none does, the largest line takes it and the statements warn.
      </p>
      {list.length === 0 ? (
        <p>None set.</p>
      ) : (
        <ol className={styles.priority}>
          {list.map((code, i) => (
            <li key={code}>
              <span>
                {code} {names.get(code) ?? "(not in chart)"}
              </span>
              {editable && (
                <span>
                  <button type="button" aria-label={`Move ${code} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${code} down`}
                    disabled={i === list.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <button type="button" aria-label={`Remove ${code}`} onClick={() => setDraft(list.filter((c) => c !== code))}>
                    ✕
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {editable && (
        <>
          <div className="row">
            <select aria-label="Account to add" value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose an account…</option>
              {available.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!adding}
              onClick={() => {
                setDraft([...list, adding]);
                setAdding("");
              }}
            >
              Add to list
            </button>
          </div>
          <ErrorMessage error={save.error} />
          {draft && (
            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate(
                    { kind: "set_rounding_priority", payload: { client_id: client.id, rounding_priority: draft } },
                    { onSuccess: () => setDraft(null) },
                  )
                }
              >
                Save list
              </button>
              <button type="button" onClick={() => setDraft(null)}>
                Discard changes
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
