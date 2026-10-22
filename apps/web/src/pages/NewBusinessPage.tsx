import type { GstSetup } from "@acct/types/GstSetup";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ErrorMessage } from "../components/ErrorMessage";
import { Icon } from "../lib/icons";
import { keys } from "../lib/queries";
import { useCommand } from "../lib/useCommand";

type Frequency = GstSetup["frequency"];

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "two_monthly_odd", label: "Every two months (periods ending Jan, Mar, May, …)" },
  { value: "two_monthly_even", label: "Every two months (periods ending Feb, Apr, Jun, …)" },
  { value: "monthly", label: "Monthly" },
  { value: "six_monthly", label: "Every six months (ending Sep and Mar)" },
];

/**
 * Sets up a business (PLAN.md M10): a sole trader with a 31 March balance date. GST is on the
 * payments basis only for now; the server turns the others down with the reason.
 */
export function NewBusinessPage() {
  const create = useCommand([keys.clients]);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [registered, setRegistered] = useState(false);
  const [gstFrom, setGstFrom] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("two_monthly_odd");

  const ready = name.trim() !== "" && start !== "" && (!registered || gstFrom !== "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) {
      return;
    }
    create.mutate(
      {
        kind: "set_up_business",
        payload: {
          name: name.trim(),
          start_date: start,
          ...(registered ? { gst: { registered_from: gstFrom, frequency, basis: "payments" } } : {}),
        },
      },
      { onSuccess: (a) => void navigate(`/businesses/${a.entity_id ?? ""}`) },
    );
  };

  return (
    <>
      <p className="crumbs">
        <Link to="/">Clients</Link> /
      </p>
      <h1>
        <Icon name="business.new" fallback="🧾" /> Set up a business
      </h1>
      <p className="muted">A sole trader, with a 31 March year end.</p>
      <form onSubmit={submit} className="form">
        <label>
          Business name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
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
            <p className="muted">
              We use the payments basis. Bank statements don't show invoices you haven't been paid for yet, so we can't
              do the invoice or hybrid basis yet.
            </p>
          </>
        )}
        <button type="submit" disabled={!ready || create.isPending}>
          Set up
        </button>
        <ErrorMessage error={create.error} />
      </form>
    </>
  );
}
