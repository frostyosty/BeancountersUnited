import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useSignUp } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { newId } from "../lib/id";
import { Icon } from "../lib/icons";
import { keys } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { FREQUENCIES, type Frequency } from "./NewBusinessPage";

/**
 * A business owner signs up (M12): their account and their business in one form. The server makes
 * both in one command and signs them in, so they land on their business ready to upload.
 */
export function SignUpPage() {
  const signUp = useSignUp();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [start, setStart] = useState("");
  const [registered, setRegistered] = useState(false);
  const [gstFrom, setGstFrom] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("two_monthly_odd");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const ready =
    displayName.trim() !== "" &&
    email.trim() !== "" &&
    password !== "" &&
    businessName.trim() !== "" &&
    start !== "" &&
    (!registered || gstFrom !== "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) {
      return;
    }
    setBusy(true);
    setError(null);
    signUp({
      id: newId(),
      email: email.trim(),
      display_name: displayName.trim(),
      password,
      business_name: businessName.trim(),
      start_date: start,
      ...(registered ? { gst: { registered_from: gstFrom, frequency, basis: "payments" } } : {}),
    })
      .then((businessId) => void navigate(`/businesses/${businessId}`))
      .catch((err: unknown) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setBusy(false));
  };

  return (
    <main className="page">
      <h1>
        <Icon name="signup.title" fallback="🌱" /> Start your books
      </h1>
      <p className="muted">
        For sole traders. Upload your bank statements and see the tax you'd pay, then bring it down.
      </p>
      <form onSubmit={submit} className="form">
        <label>
          Your name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" required />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label>
          Password (at least 10 characters)
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label>
          Business name
          <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required />
        </label>
        <label>
          Started on
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
        </label>
        <label>
          <input type="checkbox" checked={registered} onChange={(e) => setRegistered(e.target.checked)} /> Registered
          for GST
        </label>
        {registered && (
          <>
            <label>
              Registered from
              <input type="date" value={gstFrom} onChange={(e) => setGstFrom(e.target.value)} required />
            </label>
            <label>
              How often you file
              <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
                {FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <button type="submit" className="primary" disabled={!ready || busy}>
          Sign up
        </button>
        <ErrorMessage error={error} />
      </form>
      <p>
        Already signed up? <Link to="/">Sign in</Link>
      </p>
    </main>
  );
}

/** An invite link opened before signing in: sign in as the practice user, then accept. */
export function InviteSignedOutPage() {
  return (
    <main className="page">
      <h1>
        <Icon name="signup.invite" fallback="🤝" /> You've been invited
      </h1>
      <p>
        A business owner has invited you to work on their books. <Link to="/">Sign in</Link> with your practice
        account, then open this link again to accept.
      </p>
    </main>
  );
}

/** A practice user accepts a business owner's invite, which lets them see and work on that business. */
export function AcceptInvitePage() {
  const { token = "" } = useParams();
  const accept = useCommand([keys.clients]);
  const navigate = useNavigate();
  return (
    <>
      <h1>
        <Icon name="signup.invite" fallback="🤝" /> Accept invite
      </h1>
      <p>A business owner has invited you to work on their books. Accepting adds their business to your clients.</p>
      <button
        type="button"
        className="primary"
        disabled={accept.isPending}
        onClick={() =>
          accept.mutate(
            { kind: "accept_invite", payload: { token } },
            { onSuccess: (a) => void navigate(`/businesses/${a.entity_id ?? ""}`) },
          )
        }
      >
        Accept
      </button>
      <ErrorMessage error={accept.error} />
    </>
  );
}
