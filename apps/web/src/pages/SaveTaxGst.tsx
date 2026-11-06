import type { BusinessView } from "@acct/types/BusinessView";
import type { Command } from "@acct/types/Command";
import type { DetectedLine } from "@acct/types/DetectedLine";
import { useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { formatDate } from "../lib/dates";
import { Icon } from "../lib/icons";
import { formatMoney } from "../lib/money";
import { keys } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { Button, Notice } from "../ui";
import styles from "./SaveTax.module.css";

type Frequency = NonNullable<Extract<Command, { kind: "set_gst_registration" }>["payload"]["frequency"]>;

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "two_monthly_odd", label: "Every two months, periods ending Jan, Mar, May…" },
  { value: "two_monthly_even", label: "Every two months, periods ending Feb, Apr, Jun…" },
  { value: "monthly", label: "Every month" },
  { value: "six_monthly", label: "Every six months" },
];

const FREQUENCY_WORDS: Record<string, string> = {
  monthly: "monthly",
  two_monthly_odd: "two-monthly",
  two_monthly_even: "two-monthly",
  six_monthly: "six-monthly",
};

/** "a GST payment to IRD on 22 Oct 2025", from the line that says so. */
export function gstLineWords(line: DetectedLine): string {
  return `${line.amount > 0 ? "a GST refund from IRD" : "a GST payment to IRD"} on ${formatDate(line.date)}`;
}

/** The owner's answer to "Are you GST registered?": `set_gst_registration`, source `owner` (ADR 014, 3). */
function useRegistration(clientId: string) {
  const command = useCommand([keys.business(clientId)]);
  const send = (registered: boolean, frequency: Frequency, onSuccess?: () => void) =>
    command.mutate(
      {
        kind: "set_gst_registration",
        payload: { client_id: clientId, registered, source: "owner", ...(registered ? { frequency } : {}) },
      },
      { onSuccess },
    );
  return { send, busy: command.isPending, error: command.error };
}

function FrequencyField({ value, onChange }: { value: Frequency; onChange: (f: Frequency) => void }) {
  return (
    <label className="field">
      How often do you file GST?
      <select value={value} onChange={(e) => onChange(e.target.value as Frequency)}>
        {FREQUENCIES.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Yes (and how often) or no. "No" comes first when it's the one that saves. */
function Answer({
  clientId,
  initial,
  noFirst,
  onDone,
}: {
  clientId: string;
  initial: Frequency;
  noFirst: boolean;
  onDone?: () => void;
}) {
  const { send, busy, error } = useRegistration(clientId);
  const [frequency, setFrequency] = useState<Frequency>(initial);
  const answer = (registered: boolean) => send(registered, frequency, onDone);
  const no = (
    <Button key="no" variant={noFirst ? "primary" : undefined} onClick={() => answer(false)} busy={busy}>
      No, I'm not registered
    </Button>
  );
  const yes = (
    <Button key="yes" variant={noFirst ? undefined : "primary"} onClick={() => answer(true)} busy={busy}>
      Yes, I'm registered
    </Button>
  );
  return (
    <>
      <FrequencyField value={frequency} onChange={setFrequency} />
      <div className="row">{noFirst ? [no, yes] : [yes, no]}</div>
      <ErrorMessage error={error} />
    </>
  );
}

/** The Save tax card for `Question::GstRegistered`: shown only while registration is assumed. */
export function GstRegisteredQuestion({ clientId, canEdit }: { clientId: string; canEdit: boolean }) {
  return (
    <>
      <h2>
        <Icon name="business.save_question" fallback="❓" /> Are you GST registered?
      </h2>
      <p className="muted">
        Your statements don't say, so we've worked your tax out as if you are: that gives the higher figure. If you're not
        registered, your tax drops. If you are, we'll claim the GST on what you've sorted.
      </p>
      {canEdit && <Answer clientId={clientId} initial="two_monthly_odd" noFirst />}
    </>
  );
}

/**
 * The business's GST registration on the Save tax page, where the home page's "change" link lands:
 * why we think so, a way to change it, and "Are you registered after all?" when a statement
 * uploaded since the owner said no has a GST line from IRD.
 */
export function GstPanel({ business, canEdit }: { business: BusinessView; canEdit: boolean }) {
  const [changing, setChanging] = useState(false);
  const registered = business.gst_registered_from !== null;
  const frequency = (business.gst_frequency ?? "two_monthly_odd") as Frequency;
  const freq = registered && business.gst_frequency ? `, ${FREQUENCY_WORDS[business.gst_frequency] ?? ""}` : "";
  const contradiction = business.gst_contradicted_by;

  let why: string;
  if (!registered) {
    why = "Not GST registered.";
  } else if (business.gst_source === "detected" && business.gst_evidence) {
    why = `GST registered${freq}: we spotted ${gstLineWords(business.gst_evidence)}.`;
  } else if (business.gst_source === "assumed") {
    why = `Assumed GST registered${freq}, until you tell us.`;
  } else if (business.gst_source === "ird") {
    why = `IRD has you as GST registered${freq}.`;
  } else {
    why = `GST registered${freq}.`;
  }

  return (
    <div className={styles.gstPanel}>
      {contradiction && (
        <Notice tone="warn" role="status">
          <p>
            Your statement has {gstLineWords(contradiction)} (${formatMoney(Math.abs(contradiction.amount))}). Are you GST
            registered after all?
          </p>
          {canEdit && <Answer clientId={business.client_id} initial={frequency} noFirst={false} />}
        </Notice>
      )}
      <p className="muted">
        <Icon name="business.tax" fallback="💰" /> {why}{" "}
        {canEdit && business.gst_source !== "ird" && !changing && (
          <Button variant="ghost" size="sm" onClick={() => setChanging(true)}>
            Change
          </Button>
        )}
      </p>
      {changing && (
        <div className={styles.form}>
          <Answer clientId={business.client_id} initial={frequency} noFirst={false} onDone={() => setChanging(false)} />
          <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
