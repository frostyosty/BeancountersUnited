import type { FinaliseCheck } from "@acct/types/FinaliseCheck";
import type { FinaliseIssue } from "@acct/types/FinaliseIssue";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { can, isOwner, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson } from "../lib/api";
import { periodEndedLabel } from "../lib/dates";
import { Icon } from "../lib/icons";
import { keys } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import styles from "./FinaliseTab.module.css";
import { useYearContext } from "./YearLayout";

/** Under the year's prefix, so any command that changes the year refreshes the checks too. */
const checkKey = (yearId: string) => ["year", yearId, "finalise-check"] as const;

/**
 * Finalising a year (M15): the pre-checks as they stand, and the button that signs the year off.
 * The server runs the checks (the same ones the finalise command runs) and checks again on submit;
 * this only shows them.
 */
export function FinaliseTab() {
  const { year } = useYearContext();
  const check = useQuery({
    queryKey: checkKey(year.id),
    queryFn: () => getJson<FinaliseCheck>(`/api/years/${year.id}/finalise-check`),
  });
  if (check.error) {
    return <ErrorMessage error={check.error} />;
  }
  if (!check.data) {
    return <p className="muted">Running the checks…</p>;
  }
  return check.data.finalised ? <Finalised check={check.data} /> : <PreChecks check={check.data} />;
}

type Item = { key: string; label: string; state: "passed" | "failed" | "skipped"; detail: string[]; fix?: { to: string; text: string } };

/** The five pre-checks in order, each passed, failed or not applying, with a way to fix a failure. */
export function checkItems(check: FinaliseCheck, links: { prior: string | null; client: string }): Item[] {
  const failed = (code: FinaliseIssue["code"]) => check.issues.filter((i) => i.code === code);
  const item = (key: string, label: string, issues: FinaliseIssue[], passed: string, fix: Item["fix"]): Item =>
    issues.length > 0
      ? { key, label, state: "failed", detail: issues.map((i) => i.message), fix }
      : { key, label, state: "passed", detail: [passed] };
  const prior: Item = check.has_prior_year
    ? item("prior", "The prior year is finalised", failed("prior_not_finalised"), "The prior year is finalised.", links.prior ? { to: links.prior, text: "Finalise the prior year" } : undefined)
    : { key: "prior", label: "The prior year is finalised", state: "skipped", detail: ["This is the first year, so there's no prior year to wait for."] };
  return [
    prior,
    item("tb", "The trial balance balances", failed("unbalanced_tb"), "Debits equal credits.", { to: "../tb", text: "Open the trial balance" }),
    item("mapping", "Every account with a balance maps to a report line", failed("unmapped"), "Every account with a balance this year or last maps to a line.", { to: "../statements", text: "Check the statements" }),
    item("depreciation", "Depreciation is up to date", failed("depreciation_stale"), "The depreciation journal matches the asset register.", { to: "../assets", text: "Run depreciation" }),
    item("bank", "Every bank line is sorted", failed("uncategorised_lines"), "Every bank line in the year is sorted.", { to: links.client, text: "Sort the bank lines" }),
  ];
}

function PreChecks({ check }: { check: FinaliseCheck }) {
  const { year, client } = useYearContext();
  const me = useCurrentUser();
  const [accept, setAccept] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const finalise = useCommand([keys.years, keys.client(client.id)]);

  const earlier = client.years.filter((y) => y.start < year.start);
  const prior = earlier.length > 0 ? earlier[earlier.length - 1]! : null;
  const items = checkItems(check, {
    prior: prior ? `/years/${prior.id}/finalise` : null,
    client: `/businesses/${client.id}/save-tax`,
  });
  const blocking = check.issues.filter((i) => i.code !== "uncategorised_lines");
  const unsorted = check.uncategorised_lines > 0;
  const ready = blocking.length === 0 && (!unsorted || accept);
  const isAdmin = can(me, "practice_admin") && !isOwner(me);

  return (
    <div className={styles.page}>
      <h2>
        <Icon name="year.finalise" fallback="🔏" /> Ready to finalise?
      </h2>
      <p className="muted">
        Finalising signs the year off: the statements are kept exactly as they are now, and nothing can change this year's
        numbers until a practice admin reopens it.
      </p>
      <ul className={styles.checks} aria-label="Pre-checks">
        {items.map((i) => (
          <li key={i.key} className={styles[i.state]}>
            <span className={styles.mark}>
              {i.state === "passed" && <Icon name="year.finalise_passed" fallback="✅" />}
              {i.state === "failed" && <Icon name="year.finalise_failed" fallback="⚠️" />}
              {i.state === "skipped" && <Icon name="year.finalise_skipped" fallback="➖" />}
            </span>
            <div>
              <strong>{i.label}</strong>
              <span className={styles.state}> ({i.state === "skipped" ? "doesn't apply" : i.state})</span>
              {i.detail.map((d, n) => (
                <p key={n} className={styles.detail}>
                  {d}
                </p>
              ))}
              {i.state === "failed" && i.fix && (
                <Link to={i.fix.to} relative="path" className={styles.fix}>
                  {i.fix.text}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>

      {!isAdmin ? (
        <p className="muted">Only a practice admin can finalise a year.</p>
      ) : (
        <>
          {unsorted && blocking.length === 0 && (
            <label className={styles.accept}>
              <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
              Finalise anyway, accepting the {check.uncategorised_lines} unsorted bank{" "}
              {check.uncategorised_lines === 1 ? "line" : "lines"} as they are. This is recorded in the history.
            </label>
          )}
          {!confirming ? (
            <button type="button" className="primary" disabled={!ready} onClick={() => setConfirming(true)}>
              <Icon name="year.finalise" fallback="🔏" /> Finalise year…
            </button>
          ) : (
            <div className={styles.confirm} role="alertdialog" aria-label="Confirm finalising">
              <p>
                Finalise the {periodEndedLabel(year.start, year.end).toLowerCase()} for {client.name}? Its statements will
                be kept as signed, and its numbers locked.
              </p>
              <div className="row">
                <button
                  type="button"
                  className="primary"
                  disabled={finalise.isPending}
                  onClick={() =>
                    finalise.mutate(
                      { kind: "finalise_year", payload: { client_year_id: year.id, accept_uncategorised: unsorted && accept } },
                      { onSettled: () => setConfirming(false) },
                    )
                  }
                >
                  Yes, finalise
                </button>
                <button type="button" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <ErrorMessage error={finalise.error} />
        </>
      )}
    </div>
  );
}

/** When it was finalised, in the viewer's time zone. */
const when = new Intl.DateTimeFormat("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** A finalised year: who signed it off and when, the hash of what they signed, and reopening. */
function Finalised({ check }: { check: FinaliseCheck }) {
  const { year, client } = useYearContext();
  const me = useCurrentUser();
  const f = check.finalised!;
  const [reason, setReason] = useState("");
  const [reopening, setReopening] = useState(false);
  const reopen = useCommand([keys.years, keys.client(client.id)]);
  const isAdmin = can(me, "practice_admin") && !isOwner(me);

  return (
    <div className={styles.page}>
      <h2>
        <Icon name="year.finalise_done" fallback="🔒" /> Finalised
      </h2>
      <p role="status">
        Finalised by <strong>{f.who}</strong> on <time dateTime={f.at}>{when.format(new Date(f.at))}</time>.
      </p>
      <dl className={styles.facts}>
        <dt>Snapshot hash (SHA-256)</dt>
        <dd>
          <code className={styles.hash}>{f.sha256}</code>
        </dd>
      </dl>
      <p className="muted">
        The signed statements are kept exactly as they were finalised, and the PDF carries this hash in its footer. Nothing can
        change this year's numbers until it's reopened.
      </p>

      {isAdmin &&
        (!reopening ? (
          <button type="button" onClick={() => setReopening(true)}>
            <Icon name="year.finalise_reopen" fallback="🔓" /> Reopen year…
          </button>
        ) : (
          <form
            className="card form"
            onSubmit={(e) => {
              e.preventDefault();
              reopen.mutate(
                { kind: "reopen_year", payload: { client_year_id: year.id, reason: reason.trim() } },
                { onSuccess: () => setReopening(false) },
              );
            }}
          >
            <h3>Reopen this year</h3>
            <p className="muted">The signed snapshot stays on record. Finalising again keeps a new one alongside it.</p>
            <label className="field">
              <span>Why is it being reopened?</span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required />
            </label>
            <ErrorMessage error={reopen.error} />
            <div className="row">
              <button type="submit" className="primary" disabled={reason.trim() === "" || reopen.isPending}>
                Reopen year
              </button>
              <button type="button" onClick={() => setReopening(false)}>
                Cancel
              </button>
            </div>
          </form>
        ))}
      {!isAdmin && <p className="muted">Only a practice admin can reopen a year.</p>}
    </div>
  );
}
