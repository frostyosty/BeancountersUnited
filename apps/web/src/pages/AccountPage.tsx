import { type FormEvent, useState } from "react";
import { useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { useCommand } from "../lib/useCommand";

/** The signed-in user's own login. */
export function AccountPage() {
  const me = useCurrentUser();
  const change = useCommand();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const mismatch = again !== "" && next !== again;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    change.mutate(
      { kind: "change_own_password", payload: { current_password: current, new_password: next } },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
          setAgain("");
        },
      },
    );
  };

  return (
    <>
      <h1>Your account</h1>
      <p>
        {me.display_name} ({me.username}), {me.role}
      </p>
      <form onSubmit={submit} className="card form">
        <h2>Change your password</h2>
        <label className="field">
          <span>Current password</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </label>
        <label className="field">
          <span>New password</span>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        </label>
        <label className="field">
          <span>New password again</span>
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
        </label>
        {mismatch && <p className="error">The new passwords don't match.</p>}
        <ErrorMessage error={change.error} />
        {change.isSuccess && <p role="status">Password changed.</p>}
        <div>
          <button type="submit" className="primary" disabled={change.isPending || mismatch || next === ""}>
            Change password
          </button>
        </div>
      </form>
    </>
  );
}
