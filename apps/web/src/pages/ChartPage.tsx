import type { Account } from "@acct/types/Account";
import type { AccountType } from "@acct/types/AccountType";
import type { ClientDetail } from "@acct/types/ClientDetail";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import { can, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { keys, useChart, useClient } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import styles from "./ChartPage.module.css";

const TYPES: AccountType[] = ["income", "expense", "asset", "liability", "equity"];

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
  return (
    <>
      <p className="crumbs">
        <Link to="/">Clients</Link> / <Link to={`/clients/${clientId}`}>{client.data.name}</Link> /
      </p>
      <h1>Chart of accounts</h1>
      <div className={styles.layout}>
        <section>
          <AccountTable client={client.data} accounts={chart.data} editable={editable} />
          {editable && <AddAccountForm clientId={clientId} />}
        </section>
        <section>
          <RoundingPriority client={client.data} accounts={chart.data} editable={editable} />
        </section>
      </div>
    </>
  );
}

function AccountTable({ client, accounts, editable }: { client: ClientDetail; accounts: Account[]; editable: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(true);
  const command = useCommand([keys.chart(client.id)]);
  const shown = showInactive ? accounts : accounts.filter((a) => a.active);

  return (
    <>
      <label className={styles.toggle}>
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show
        inactive accounts
      </label>
      <ErrorMessage error={command.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Type</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((a) => (
            <tr key={a.code} className={a.active ? undefined : styles.inactive}>
              <td>{a.code}</td>
              <td>
                {editing === a.code ? (
                  <RenameForm
                    account={a}
                    onDone={(name) => {
                      if (name === null || name === a.name) {
                        setEditing(null);
                        return;
                      }
                      command.mutate(
                        { kind: "rename_account", payload: { client_id: client.id, code: a.code, name } },
                        { onSuccess: () => setEditing(null) },
                      );
                    }}
                  />
                ) : editable ? (
                  <button type="button" className={styles.linkButton} onClick={() => setEditing(a.code)} title="Rename">
                    {a.name}
                  </button>
                ) : (
                  a.name
                )}
                {a.code === client.retained_earnings && <span className={styles.tag}>retained earnings</span>}
              </td>
              <td>{a.account_type}</td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${a.code} active`}
                  checked={a.active}
                  disabled={!editable || command.isPending}
                  onChange={(e) =>
                    command.mutate({
                      kind: "set_account_active",
                      payload: { client_id: client.id, code: a.code, active: e.target.checked },
                    })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function RenameForm({ account, onDone }: { account: Account; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(account.name);
  return (
    <form
      className={styles.inline}
      onSubmit={(e) => {
        e.preventDefault();
        onDone(name.trim());
      }}
    >
      <input
        aria-label={`New name for ${account.code}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone(null)}
        autoFocus
      />
      <button type="submit">Save</button>
      <button type="button" onClick={() => onDone(null)}>
        Cancel
      </button>
    </form>
  );
}

function AddAccountForm({ clientId }: { clientId: string }) {
  const add = useCommand([keys.chart(clientId)]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("expense");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(
      {
        kind: "add_account",
        payload: { client_id: clientId, account: { code: code.trim(), name: name.trim(), account_type: type, active: true } },
      },
      {
        onSuccess: () => {
          setCode("");
          setName("");
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="card form">
      <h2>Add an account</h2>
      <div className="row">
        <label className="field">
          <span>Code</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} required size={8} />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted">An account's code and type can't change once it's added, so check them.</p>
      <ErrorMessage error={add.error} />
      <div>
        <button type="submit" className="primary" disabled={add.isPending}>
          Add account
        </button>
      </div>
    </form>
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
