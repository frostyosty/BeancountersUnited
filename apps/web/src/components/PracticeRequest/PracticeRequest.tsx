import type { PracticeClients } from "@acct/types/PracticeClients";
import type { PracticeRequestFrom } from "@acct/types/PracticeRequestFrom";
import { type FormEvent, useId, useRef, useState } from "react";
import { useGuest } from "../../auth";
import { ApiRequestError, requestPracticeAccount } from "../../lib/api";
import { newId } from "../../lib/id";
import { Icon } from "../../lib/icons";
import { Button, Field, Modal } from "../../ui";
import { ErrorMessage } from "../ErrorMessage";

/** The bands the server accepts, in order, with the words for each. */
export const CLIENT_BANDS: { value: PracticeClients; label: string }[] = [
  { value: "up_to_10", label: "Up to 10" },
  { value: "11_to_50", label: "11 to 50" },
  { value: "51_to_200", label: "51 to 200" },
  { value: "over_200", label: "Over 200" },
];

/**
 * Asking for a practice account (M21, ADR 015, 7). It is a request someone answers, not an account:
 * the server has one practice, so a firm can't sign itself up yet. The request is sent with no user,
 * so it never touches a trial. `trial` says the person is a guest, to reassure them their trial stays.
 */
export function PracticeRequestModal({
  open,
  onClose,
  from,
  trial = false,
}: {
  open: boolean;
  onClose: () => void;
  from: PracticeRequestFrom;
  /** True for a guest, who is told their trial stays as it is. */
  trial?: boolean;
}) {
  const formId = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [practice, setPractice] = useState("");
  const [clients, setClients] = useState<PracticeClients>("up_to_10");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ name: string; email: string } | null>(null);
  // Kept after a reply that never came, so the retry is the same request and not a second one.
  const retryId = useRef<string | null>(null);

  const ready = name.trim() !== "" && email.trim() !== "" && practice.trim() !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const id = retryId.current ?? newId();
    requestPracticeAccount({
      id,
      name: name.trim(),
      email: email.trim(),
      practice_name: practice.trim(),
      clients,
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      from,
    })
      .then(() => {
        retryId.current = null;
        setSent({ name: name.trim(), email: email.trim() });
      })
      .catch((err: unknown) => {
        // A refusal never made a request; only a lost reply keeps the id.
        retryId.current = err instanceof ApiRequestError ? null : id;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => setBusy(false));
  };

  const title = "Sign up your firm";
  const icon = <Icon name="practice_request.practice" fallback="🏭" />;

  if (sent) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Request sent"
        icon={<Icon name="practice_request.sent" fallback="📬" />}
        size="sm"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <p>
          Thanks, {sent.name}. We'll email {sent.email} about setting up your firm.
        </p>
        {trial && (
          <p className="muted">
            Your trial stays as it is: it's kept for 7 days after you last use it, and you can still save it.
          </p>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      icon={icon}
      size="sm"
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy} disabled={!ready}>
            Send request
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="form">
        <p className="muted">
          Tell us a little about your accounting or bookkeeping firm and we'll get in touch to set it up. Please don't
          upload a client's statement here without their OK.
        </p>
        <Field label="Your name">
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} required />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            maxLength={254}
            required
          />
        </Field>
        <Field label="Firm name">
          <input
            value={practice}
            onChange={(e) => setPractice(e.target.value)}
            autoComplete="organization"
            maxLength={120}
            required
          />
        </Field>
        <Field label="Roughly how many clients?">
          <select value={clients} onChange={(e) => setClients(e.target.value as PracticeClients)}>
            {CLIENT_BANDS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Phone (optional)">
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" maxLength={30} />
        </Field>
        <ErrorMessage error={error} />
      </form>
    </Modal>
  );
}

/**
 * "Sign up your firm": a button that opens the request. For /accountants and /signup. It says "firm",
 * not "practice account", which some owners read as somewhere to practise their books.
 */
export function PracticeRequestButton({
  from,
  variant = "secondary",
}: {
  from: PracticeRequestFrom;
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const guest = useGuest();
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <Icon name="practice_request.practice" fallback="🏭" /> Sign up your firm
      </Button>
      <PracticeRequestModal open={open} onClose={() => setOpen(false)} from={from} trial={!!guest} />
    </>
  );
}
