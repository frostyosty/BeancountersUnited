import type { Role } from "@acct/types/Role";
import type { UserView } from "@acct/types/UserView";
import { type FormEvent, useState } from "react";
import { useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { keys, usePractice, useUsers } from "../lib/queries";
import { useCommand } from "../lib/useCommand";

/** Practice settings: master users only (the server checks too). */
export function SettingsPage() {
  const me = useCurrentUser();
  if (me.role !== "master") {
    return <p>Only master users can change practice settings.</p>;
  }
  return (
    <>
      <h1>Practice settings</h1>
      <Defaults />
      <Users />
    </>
  );
}

function Defaults() {
  const practice = usePractice();
  if (practice.error) {
    return <ErrorMessage error={practice.error} />;
  }
  if (!practice.data) {
    return null;
  }
  const p = practice.data;
  return (
    <>
      <p>
        Practice: <strong>{p.name}</strong>
      </p>
      <h2>Defaults</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Entity type</th>
            <th>Master chart</th>
            <th>Templates</th>
            <th>Mappings</th>
          </tr>
        </thead>
        <tbody>
          {p.master_charts.map((c) => (
            <tr key={c.id}>
              <td>{c.entity_type}</td>
              <td>
                {c.name} ({c.accounts.length} accounts)
              </td>
              <td>
                {p.templates
                  .filter((t) => t.entity_type === c.entity_type)
                  .map((t) => `${t.name} v${t.latest_version}`)
                  .join(", ")}
              </td>
              <td>
                {p.mappings
                  .filter((m) => m.entity_type === c.entity_type)
                  .map((m) => `${m.name} v${m.latest_version}`)
                  .join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Editing master charts, templates and mappings comes later; changes never reach existing clients.</p>
    </>
  );
}

function Users() {
  const me = useCurrentUser();
  const users = useUsers();
  const command = useCommand([keys.users]);
  const [resetting, setResetting] = useState<string | null>(null);

  return (
    <>
      <h2>Users</h2>
      <ErrorMessage error={users.error ?? command.error} />
      {users.data && (
        <table className="table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Name</th>
              <th>Role</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.display_name}</td>
                <td>{u.role}</td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${u.username} active`}
                    checked={u.active}
                    disabled={u.id === me.id || command.isPending}
                    onChange={(e) => command.mutate({ kind: "set_user_active", payload: { user_id: u.id, active: e.target.checked } })}
                  />
                </td>
                <td>
                  {resetting === u.id ? (
                    <ResetPassword user={u} onDone={() => setResetting(null)} />
                  ) : (
                    <button type="button" onClick={() => setResetting(u.id)}>
                      Reset password…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <NewUserForm />
    </>
  );
}

function ResetPassword({ user, onDone }: { user: UserView; onDone: () => void }) {
  const reset = useCommand();
  const [password, setPassword] = useState("");
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        reset.mutate({ kind: "reset_password", payload: { user_id: user.id, new_password: password } }, { onSuccess: onDone });
      }}
    >
      <input
        type="password"
        aria-label={`New password for ${user.username}`}
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      <button type="submit" className="primary" disabled={reset.isPending}>
        Set password
      </button>
      <button type="button" onClick={onDone}>
        Cancel
      </button>
      <ErrorMessage error={reset.error} />
    </form>
  );
}

function NewUserForm() {
  const create = useCommand([keys.users]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("staff");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { kind: "create_user", payload: { username: username.trim(), display_name: displayName.trim(), password, role } },
      {
        onSuccess: () => {
          setUsername("");
          setDisplayName("");
          setPassword("");
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="card form">
      <h2>New user</h2>
      <div className="row">
        <label className="field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
        </label>
        <label className="field">
          <span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
      </div>
      <div className="row">
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="staff">staff</option>
            <option value="viewer">viewer</option>
            <option value="master">master</option>
          </select>
        </label>
      </div>
      <ErrorMessage error={create.error} />
      <div>
        <button type="submit" className="primary" disabled={create.isPending}>
          Create user
        </button>
      </div>
    </form>
  );
}
