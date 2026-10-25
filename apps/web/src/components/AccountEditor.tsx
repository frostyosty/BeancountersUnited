import type { Account } from "@acct/types/Account";
import type { AccountCode } from "@acct/types/AccountCode";
import type { AccountType } from "@acct/types/AccountType";
import type { Command } from "@acct/types/Command";
import type { GstCode } from "@acct/types/GstCode";
import type { QueryKey } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { Icon } from "../lib/icons";
import { useCommand } from "../lib/useCommand";
import styles from "./AccountEditor.module.css";
import { ErrorMessage } from "./ErrorMessage";

const TYPES: AccountType[] = ["income", "expense", "asset", "liability", "equity"];

/** Default GST codes, in the order the picker shows them. */
const GST_CODES: { code: GstCode; label: string }[] = [
  { code: "standard", label: "Standard" },
  { code: "zero", label: "Zero-rated" },
  { code: "exempt", label: "Exempt" },
  { code: "none", label: "No GST" },
];

/** Only income and expense accounts have a default GST code. */
const hasGst = (type: AccountType) => type === "income" || type === "expense";

/**
 * The commands that edit one chart: a client's, or a practice master chart. Codes and account
 * types never change once an account is added.
 */
export interface ChartCommands {
  rename: (code: AccountCode, name: string) => Command;
  setGst: (code: AccountCode, defaultGst: GstCode | null) => Command;
  setActive: (code: AccountCode, active: boolean) => Command;
  add: (account: Account) => Command;
  /** What to refresh once a command is accepted. */
  invalidates: QueryKey[];
}

/** A chart's accounts, renamed, given a default GST code or made (in)active in place. */
export function AccountTable({
  accounts,
  editable,
  commands,
  tag,
}: {
  accounts: Account[];
  editable: boolean;
  commands: ChartCommands;
  /** A note shown after an account's name, such as "retained earnings". */
  tag?: (account: Account) => ReactNode;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(true);
  const command = useCommand(commands.invalidates);
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
            <th>Default GST</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((a) => {
            const note = tag?.(a);
            return (
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
                        command.mutate(commands.rename(a.code, name), { onSuccess: () => setEditing(null) });
                      }}
                    />
                  ) : editable ? (
                    <button type="button" className={styles.linkButton} onClick={() => setEditing(a.code)} title="Rename">
                      {a.name}
                    </button>
                  ) : (
                    a.name
                  )}
                  {note && <span className={styles.tag}>{note}</span>}
                </td>
                <td>{a.account_type}</td>
                <td>
                  {hasGst(a.account_type) && (
                    <select
                      aria-label={`${a.code} default GST`}
                      value={a.default_gst ?? ""}
                      disabled={!editable || command.isPending}
                      onChange={(e) =>
                        command.mutate(commands.setGst(a.code, e.target.value === "" ? null : (e.target.value as GstCode)))
                      }
                    >
                      <option value="">Not set</option>
                      {GST_CODES.map((g) => (
                        <option key={g.code} value={g.code}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${a.code} active`}
                    checked={a.active}
                    disabled={!editable || command.isPending}
                    onChange={(e) => command.mutate(commands.setActive(a.code, e.target.checked))}
                  />
                </td>
              </tr>
            );
          })}
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

export function AddAccountForm({ commands }: { commands: ChartCommands }) {
  const add = useCommand(commands.invalidates);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("expense");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(commands.add({ code: code.trim(), name: name.trim(), account_type: type, active: true }), {
      onSuccess: () => {
        setCode("");
        setName("");
      },
    });
  };

  return (
    <form onSubmit={submit} className="card form">
      <h2>
        <Icon name="defaults.add_account" fallback="➕" /> Add an account
      </h2>
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
