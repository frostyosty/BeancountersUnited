import { type FormEvent, useState } from "react";
import { useSignIn } from "../auth";
import { Icon } from "../lib/icons";
import styles from "./LoginPage.module.css";

/** The sign-in card. HomePage places it in the hero. */
export function LoginPage({ id }: { id?: string }) {
  const signIn = useSignIn();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    signIn(username, password)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form id={id} onSubmit={submit} className={styles.form}>
      <h2 className={styles.title}>
        <Icon name="home.signin" fallback="👋" /> Welcome back
      </h2>
      <p className="muted">Sign in to see your books.</p>
      <label className="field">
        <span>Username</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      </label>
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy}>
        Sign in
      </button>
    </form>
  );
}
