import type { Health } from "@acct/types/Health";
import { useEffect, useState } from "react";
import { fetchHealth } from "./lib/api";

type State = { kind: "loading" } | { kind: "ok"; health: Health } | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    fetchHealth()
      .then((health) => setState({ kind: "ok", health }))
      .catch((err: unknown) => setState({ kind: "error", message: String(err) }));
  }, []);

  return (
    <main>
      <h1>acct</h1>
      {state.kind === "loading" && <p>Checking server…</p>}
      {state.kind === "ok" && (
        <p>
          Server {state.health.status}, version {state.health.version}
        </p>
      )}
      {state.kind === "error" && <p role="alert">Server unreachable: {state.message}</p>}
    </main>
  );
}
