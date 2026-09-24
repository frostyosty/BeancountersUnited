import type { Health } from "@acct/types/Health";
import type { Me } from "@acct/types/Me";
import { type FormEvent, useEffect, useState } from "react";
import { fetchHealth, fetchMe, login, logout } from "./lib/api";

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: Health; me: Me | null }
  | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    Promise.all([fetchHealth(), fetchMe()])
      .then(([health, me]) => setState({ kind: "ok", health, me }))
      .catch((err: unknown) => setState({ kind: "error", message: String(err) }));
  }, []);

  const setMe = (me: Me | null) => setState((s) => (s.kind === "ok" ? { ...s, me } : s));

  return (
    <main>
      <h1>acct</h1>
      {state.kind === "loading" && <p>Checking server…</p>}
      {state.kind === "ok" && (
        <>
          <p>
            Server {state.health.status}, version {state.health.version}
          </p>
          {state.me ? (
            <p>
              Signed in as {state.me.display_name} ({state.me.role}).{" "}
              <button type="button" onClick={() => void logout().then(() => setMe(null))}>
                Sign out
              </button>
            </p>
          ) : (
            <LoginForm onLogin={setMe} />
          )}
        </>
      )}
      {state.kind === "error" && <p role="alert">Server unreachable: {state.message}</p>}
    </main>
  );
}

function LoginForm({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    login({ username, password })
      .then(onLogin)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit}>
      <p>
        <label>
          Username{" "}
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
      </p>
      <p>
        <label>
          Password{" "}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
      </p>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>
        Sign in
      </button>
    </form>
  );
}
