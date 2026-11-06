import { type FormEvent, useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useClaimGuest } from "../../auth";
import { ApiRequestError } from "../../lib/api";
import { Icon } from "../../lib/icons";
import { Button, ButtonLink, Field, Modal, Notice } from "../../ui";
import { ErrorMessage } from "../ErrorMessage";
import styles from "./ClaimForm.module.css";

/**
 * A guest saves their work (M20, ADR 014, 4): an email, a name and a password turn the trial into a
 * real account, keeping every line and answer. A guest with only an example has nothing to save, so
 * they're pointed at sign-up instead.
 */
export function ClaimForm({
  open,
  onClose,
  hasOwnBusiness,
}: {
  open: boolean;
  onClose: () => void;
  /** False when the guest only has an example, which can't be saved. */
  hasOwnBusiness: boolean;
}) {
  const claim = useClaimGuest();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const formId = useId();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = email.trim() !== "" && name.trim() !== "" && password !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    claim({
      email: email.trim(),
      display_name: name.trim(),
      password,
      ...(businessName.trim() ? { business_name: businessName.trim() } : {}),
    })
      .then((businessId) => {
        onClose();
        // Pages outside the signed-in layout (the home page) go to the business. Business pages stay put.
        if (!pathname.startsWith("/businesses/")) {
          void navigate(`/businesses/${businessId}`);
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setBusy(false));
  };

  if (!hasOwnBusiness) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Save your work"
        icon={<Icon name="guest.save" fallback="💾" />}
        size="sm"
        footer={
          <>
            <Button onClick={onClose}>Close</Button>
            <ButtonLink to="/signup" variant="primary" onClick={onClose}>
              Sign up
            </ButtonLink>
          </>
        }
      >
        <p>Examples can't be saved. Drop one of your own statements, or sign up.</p>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save your work"
      icon={<Icon name="guest.save" fallback="💾" />}
      size="sm"
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy} disabled={!ready}>
            Save your work
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="form">
        <p className="muted">Everything you've uploaded and answered stays exactly as it is.</p>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </Field>
        <Field label="Your name">
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label="Business name (optional)" hint="We call it “Your business” until you say.">
          <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
        </Field>
        <ErrorMessage error={error} />
        {error instanceof ApiRequestError && error.code === "email_taken" && (
          <Notice tone="info" role="status">
            <Link to="/#signin" onClick={onClose} className={styles.link}>
              <Icon name="home.signin" fallback="👋" /> Sign in instead
            </Link>{" "}
            and we'll offer to move what you've tried into that account.
          </Notice>
        )}
      </form>
    </Modal>
  );
}
