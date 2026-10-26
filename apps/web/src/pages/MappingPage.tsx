import type { MappingDetail } from "@acct/types/MappingDetail";
import type { MappingRange } from "@acct/types/MappingRange";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { can, useCurrentUser } from "../auth";
import { describeDetail, ErrorMessage } from "../components/ErrorMessage";
import { checkMapping } from "../lib/api";
import { entityLabel } from "../lib/entityTypes";
import { Icon } from "../lib/icons";
import { keys, useMapping } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { PageHeader } from "../ui";
import styles from "./MappingPage.module.css";

/** A mapping: which ranges of account codes go to which template line. */
export function MappingPage() {
  const { mappingId = "" } = useParams();
  const me = useCurrentUser();
  const detail = useMapping(mappingId);
  if (!can(me, "practice_admin")) {
    return <p>Only practice admins can change practice settings.</p>;
  }
  if (detail.error) {
    return <ErrorMessage error={detail.error} />;
  }
  if (!detail.data) {
    return <p className="muted">Loading…</p>;
  }
  return <Editor key={detail.data.version} detail={detail.data} />;
}

/** `value`, once it's stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function Editor({ detail }: { detail: MappingDetail }) {
  const [draft, setDraft] = useState<MappingRange[] | null>(null);
  const save = useCommand([keys.layouts, keys.practice]);
  const ranges = draft ?? detail.body.ranges;
  const labels = new Map(detail.lines.map((l) => [l.key, `${l.statement}: ${l.label}`]));
  const statements = [...new Set(detail.lines.map((l) => l.statement))];

  const settled = useSettled(ranges);
  const check = useQuery({
    queryKey: ["layouts", "check", detail.template_id, JSON.stringify(settled)],
    queryFn: () => checkMapping({ template_id: detail.template_id, body: { ranges: settled } }),
  });
  const unmapped = check.data?.accounts.filter((a) => a.line === null) ?? [];

  const edit = (i: number, patch: Partial<MappingRange>) => setDraft(ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const lineSelect = (value: string, label: string, onChange: (line: string) => void) => (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {!labels.has(value) && <option value={value}>{value === "" ? "Choose a line…" : `${value} (not in the template)`}</option>}
      {statements.map((s) => (
        <optgroup key={s} label={s}>
          {detail.lines
            .filter((l) => l.statement === s)
            .map((l) => (
              <option key={l.key} value={l.key}>
                {l.label}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );

  return (
    <>
      <PageHeader
        crumbs={[{ to: "/settings", label: "Settings" }]}
        icon={<Icon name="layouts.mapping" fallback="🔗" />}
        title={detail.name}
      />
      <p className="muted">
        Mapping for {entityLabel(detail.entity_type)} clients onto the template{" "}
        <Link to={`/settings/templates/${detail.template_id}`}>{detail.template_name}</Link>, version {detail.version}.
        Saving writes version {detail.version + 1}; each year keeps the version it uses until it's moved onto a newer one.
        A range includes both ends and their sub-accounts, so 200–299 covers 299.05.
      </p>
      <div className={styles.layout}>
        <section>
          <table className="table">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Line</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ranges.map((r, i) => (
                <tr key={i}>
                  <td>
                    <input aria-label={`Range ${i + 1} from`} size={8} value={r.from} onChange={(e) => edit(i, { from: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label={`Range ${i + 1} to`} size={8} value={r.to} onChange={(e) => edit(i, { to: e.target.value })} />
                  </td>
                  <td>{lineSelect(r.line, `Range ${i + 1} line`, (line) => edit(i, { line }))}</td>
                  <td>
                    <button
                      type="button"
                      aria-label={`Remove range ${r.from}–${r.to}`}
                      onClick={() => setDraft(ranges.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <AddRange
            lineSelect={(value, onChange) => lineSelect(value, "New range line", onChange)}
            onAdd={(r) => setDraft([...ranges, r])}
          />
          <ErrorMessage error={save.error} />
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={!draft || save.isPending}
              onClick={() =>
                save.mutate(
                  { kind: "revise_mapping", payload: { mapping_id: detail.id, body: { ranges } } },
                  { onSuccess: () => setDraft(null) },
                )
              }
            >
              <Icon name="layouts.save" fallback="💾" /> Save version {detail.version + 1}
            </button>
            <button type="button" disabled={!draft} onClick={() => setDraft(null)}>
              Discard changes
            </button>
          </div>
        </section>
        <section className="card" aria-label="Coverage">
          <h2>Coverage</h2>
          {check.error && <ErrorMessage error={check.error} />}
          {check.data && (
            <>
              {check.data.problems.length > 0 && (
                <ul className="error" aria-label="Problems">
                  {check.data.problems.map((p, i) => (
                    <li key={i}>{describeDetail(p)}</li>
                  ))}
                </ul>
              )}
              <p>
                {unmapped.length === 0 ? (
                  <>
                    <Icon name="layouts.covered" fallback="✅" /> Every master chart account maps to a line.
                  </>
                ) : (
                  <>
                    <Icon name="layouts.unmapped" fallback="⚠️" /> {unmapped.length} master chart{" "}
                    {unmapped.length === 1 ? "account maps" : "accounts map"} to no line. A balance on one stops the
                    statements building.
                  </>
                )}
              </p>
              <table className="table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Line</th>
                  </tr>
                </thead>
                <tbody>
                  {check.data.accounts.map((a) => (
                    <tr key={a.code} className={a.active ? undefined : styles.inactive}>
                      <td>
                        {a.code} {a.name}
                      </td>
                      <td>{a.line === null ? <strong className={styles.unmapped}>Not mapped</strong> : (labels.get(a.line) ?? a.line)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>
    </>
  );
}

function AddRange({
  lineSelect,
  onAdd,
}: {
  lineSelect: (value: string, onChange: (line: string) => void) => ReactNode;
  onAdd: (r: MappingRange) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [line, setLine] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onAdd({ from: from.trim(), to: (to.trim() || from.trim()), line });
    setFrom("");
    setTo("");
  };
  return (
    <form className="row" onSubmit={submit}>
      <input aria-label="New range from" placeholder="From" size={8} value={from} onChange={(e) => setFrom(e.target.value)} required />
      <input aria-label="New range to" placeholder="To" size={8} value={to} onChange={(e) => setTo(e.target.value)} />
      {lineSelect(line, setLine)}
      <button type="submit" disabled={!line}>
        Add range
      </button>
    </form>
  );
}
