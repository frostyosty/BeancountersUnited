import type { Account } from "@acct/types/Account";
import type { ApplyDefaultsChange } from "@acct/types/ApplyDefaultsChange";
import type { AssetYearView } from "@acct/types/AssetYearView";
import type { ClientClassView } from "@acct/types/ClientClassView";
import type { Command } from "@acct/types/Command";
import type { DepreciationSettings } from "@acct/types/DepreciationSettings";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useCurrentUser } from "../auth";
import { AssetAccountFields, DepreciationFields } from "../components/DepreciationFields";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson } from "../lib/api";
import { formatDate } from "../lib/dates";
import { DEFAULT_DRAFT, describeConventions, describeMethod, type SettingsDraft, toDraft, toSettings } from "../lib/depreciation";
import { formatMoney, parseMoney } from "../lib/money";
import { keys, useClientAssetClasses, useYearAssets } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { useYearContext } from "./YearLayout";

/** Everything an asset command can change: every year's figures and the class views. */
const INVALIDATES = [keys.years, keys.assetClasses];

/**
 * The asset register as at this year: each asset's movements, whether the posted depreciation is
 * current, what the run would post, and the register against the ledger. Every figure comes from
 * the server.
 */
export function AssetsTab() {
  const { year, client, chart } = useYearContext();
  const me = useCurrentUser();
  const view = useYearAssets(year.id);
  const classes = useClientAssetClasses(client.id);
  const run = useCommand(INVALIDATES);
  const canEdit = me.role !== "viewer";
  const open = year.status === "open";

  if (view.error ?? classes.error) {
    return <ErrorMessage error={view.error ?? classes.error} />;
  }
  if (!view.data || !classes.data) {
    return <p className="muted">Loading the register…</p>;
  }
  const v = view.data;
  const className = new Map(classes.data.map((c) => [c.class.id, c.class.name]));
  const names = new Map(chart.map((a) => [a.code, a.name]));

  return (
    <>
      <p role="status">
        {v.status === "current" && "The posted depreciation and disposal journals match the register."}
        {v.status === "stale" && "The register has changed since depreciation was last posted for this year."}
        {v.status === "finalised" && "This year is finalised; its asset journals don't change."}{" "}
        {canEdit && open && (
          <button
            type="button"
            className={v.status === "stale" ? "primary" : undefined}
            disabled={run.isPending}
            onClick={() => run.mutate({ kind: "run_depreciation", payload: { client_year_id: year.id } })}
          >
            Run depreciation
          </button>
        )}
      </p>
      {v.stale_earlier_years.length > 0 && (
        <p className="muted">Earlier open years are stale too; running depreciation here reposts them as well.</p>
      )}
      <ErrorMessage error={run.error} />

      <h2>Register</h2>
      {v.assets.length === 0 ? (
        <p className="muted">No assets yet.</p>
      ) : (
        <Register assets={v.assets} className={className} canEdit={canEdit && open} chart={chart} classes={classes.data} />
      )}

      <h2>Journals for this year</h2>
      {v.journals.length === 0 ? (
        <p className="muted">Nothing to post.</p>
      ) : (
        v.journals.map((j, i) => (
          <table className="table" key={i} aria-label={j.narration}>
            <caption>
              {formatDate(j.date)} · {j.narration}
            </caption>
            <tbody>
              {j.lines.map((l) => (
                <tr key={l.account}>
                  <td>{l.account}</td>
                  <td>{names.get(l.account) ?? ""}</td>
                  <td className="num">{l.amount > 0 ? formatMoney(l.amount) : ""}</td>
                  <td className="num">{l.amount < 0 ? formatMoney(-l.amount) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))
      )}

      <h2>Reconciliation at {formatDate(year.end)}</h2>
      <table className="table" aria-label="Reconciliation">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Register</th>
            <th className="num">Ledger</th>
            <th className="num">Difference</th>
          </tr>
        </thead>
        <tbody>
          {v.reconciliation.map((r) => (
            <tr key={r.account}>
              <td>
                {r.account} {names.get(r.account) ?? ""}
              </td>
              <td className="num">{formatMoney(r.register)}</td>
              <td className="num">{formatMoney(r.ledger)}</td>
              <td className={`num ${r.ledger !== r.register ? "error" : ""}`}>{formatMoney(r.ledger - r.register)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {canEdit && <NewAsset classes={classes.data} />}
      <ClassDefaults classes={classes.data} canEdit={canEdit} chart={chart} />
    </>
  );
}

function Register({
  assets,
  className,
  canEdit,
  chart,
  classes,
}: {
  assets: AssetYearView[];
  className: Map<string, string>;
  canEdit: boolean;
  chart: Account[];
  classes: ClientClassView[];
}) {
  const [editing, setEditing] = useState<{ id: string; mode: "edit" | "dispose" } | null>(null);
  const command = useCommand(INVALIDATES);
  return (
    <>
      <ErrorMessage error={command.error} />
      <table className="table" aria-label="Register">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Class</th>
            <th>Acquired</th>
            <th>Method</th>
            <th className="num">Cost</th>
            <th className="num">Opening book value</th>
            <th className="num">Depreciation</th>
            <th className="num">Closing book value</th>
            <th>Disposal</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {assets.map(({ asset: a, movements: m }) => {
            const openingBv = m.opening_cost - m.opening_accumulated;
            return (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>{className.get(a.class_id) ?? ""}</td>
                <td>{formatDate(a.acquired)}</td>
                <td title={describeConventions(a.settings)}>
                  {describeMethod(a.settings)} <span className="muted">({a.rate_source})</span>
                </td>
                <td className="num">{formatMoney(a.cost)}</td>
                <td className="num">{formatMoney(openingBv)}</td>
                <td className="num">{formatMoney(m.depreciation)}</td>
                <td className="num">{formatMoney(m.closing_cost - m.closing_accumulated)}</td>
                <td>
                  {a.disposal &&
                    `${formatDate(a.disposal.date)} for ${formatMoney(a.disposal.proceeds)}${
                      m.gain !== null ? `, ${m.gain >= 0 ? "gain" : "loss"} ${formatMoney(Math.abs(m.gain))}` : ""
                    }`}
                </td>
                {canEdit && (
                  <td>
                    <div className="row">
                      <button type="button" onClick={() => setEditing({ id: a.id, mode: "edit" })}>
                        Edit…
                      </button>
                      {a.disposal ? (
                        <button
                          type="button"
                          onClick={() => command.mutate({ kind: "reinstate_asset", payload: { asset_id: a.id } })}
                        >
                          Reinstate
                        </button>
                      ) : (
                        <button type="button" onClick={() => setEditing({ id: a.id, mode: "dispose" })}>
                          Dispose…
                        </button>
                      )}
                      {!a.fixed && (
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Delete ${a.name} from the register?`)) {
                              command.mutate({ kind: "delete_asset", payload: { asset_id: a.id } });
                            }
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {assets
        .filter((a) => a.asset.id === editing?.id)
        .map(({ asset }) =>
          editing?.mode === "dispose" ? (
            <DisposeForm key={asset.id} assetId={asset.id} name={asset.name} chart={chart} onDone={() => setEditing(null)} />
          ) : (
            <AssetForm
              key={asset.id}
              classes={classes}
              existing={asset}
              onDone={() => setEditing(null)}
            />
          ),
        )}
    </>
  );
}

function NewAsset({ classes }: { classes: ClientClassView[] }) {
  const [shown, setShown] = useState(false);
  if (!shown) {
    return (
      <p>
        <button type="button" onClick={() => setShown(true)}>
          Add an asset…
        </button>
      </p>
    );
  }
  return <AssetForm classes={classes} onDone={() => setShown(false)} />;
}

/** Adds an asset, or edits `existing`. Without "custom settings" the class's defaults apply. */
function AssetForm({
  classes,
  existing,
  onDone,
}: {
  classes: ClientClassView[];
  existing?: AssetYearView["asset"];
  onDone: () => void;
}) {
  const { client } = useYearContext();
  const save = useCommand(INVALIDATES);
  const [classId, setClassId] = useState(existing?.class_id ?? classes[0]?.class.id ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [cost, setCost] = useState(existing ? formatMoney(existing.cost) : "");
  const [residual, setResidual] = useState(existing ? formatMoney(existing.residual) : "0.00");
  const [acquired, setAcquired] = useState(existing?.acquired ?? "");
  const [custom, setCustom] = useState(existing?.rate_source === "custom");
  const resolved = classes.find((c) => c.class.id === classId)?.resolved;
  const [draft, setDraft] = useState<SettingsDraft>(
    existing ? toDraft(existing.settings) : resolved ? toDraft(resolved.settings) : DEFAULT_DRAFT,
  );
  const [broughtForward, setBroughtForward] = useState(existing?.opening != null);
  const [openingDate, setOpeningDate] = useState(existing?.opening?.date ?? client.years[0]?.start ?? "");
  const [openingAccumulated, setOpeningAccumulated] = useState(
    existing?.opening ? formatMoney(existing.opening.accumulated) : "",
  );
  const [problem, setProblem] = useState<string | null>(null);
  const fixed = existing?.fixed ?? false;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const costCents = parseMoney(cost);
    const residualCents = parseMoney(residual) ?? 0;
    if (costCents === null || costCents <= 0) {
      setProblem("Enter the cost.");
      return;
    }
    let settings: DepreciationSettings | undefined;
    if (custom) {
      const s = toSettings(draft);
      if (typeof s === "string") {
        setProblem(s);
        return;
      }
      settings = s;
    }
    let opening;
    if (broughtForward) {
      const acc = parseMoney(openingAccumulated);
      if (acc === null) {
        setProblem("Enter the accumulated depreciation brought forward.");
        return;
      }
      opening = { date: openingDate, accumulated: acc };
    }
    setProblem(null);
    const fields = { name: name.trim(), cost: costCents, residual: residualCents, acquired, settings, opening };
    const command: Command = existing
      ? { kind: "update_asset", payload: { asset_id: existing.id, ...fields } }
      : { kind: "create_asset", payload: { client_id: client.id, class_id: classId, ...fields } };
    save.mutate(command, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} className="card form">
      <h2>{existing ? `Edit ${existing.name}` : "New asset"}</h2>
      {fixed && <p className="muted">A finalised year holds this asset, so only its name and settings can change.</p>}
      <div className="row">
        {!existing && (
          <label className="field">
            <span>Class</span>
            <select value={classId} onChange={(e) => setClassId(e.target.value)}>
              {classes.map((c) => (
                <option key={c.class.id} value={c.class.id}>
                  {c.class.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Asset name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>Cost</span>
          <input value={cost} onChange={(e) => setCost(e.target.value)} disabled={fixed} inputMode="decimal" required />
        </label>
        <label className="field">
          <span>Residual value</span>
          <input value={residual} onChange={(e) => setResidual(e.target.value)} disabled={fixed} inputMode="decimal" />
        </label>
        <label className="field">
          <span>Acquired</span>
          <input type="date" value={acquired} onChange={(e) => setAcquired(e.target.value)} disabled={fixed} required />
        </label>
      </div>
      <label className="row">
        <input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
        <span>
          Custom settings for this asset
          {!custom && resolved && (
            <span className="muted">
              {" "}
              (class default: {describeMethod(resolved.settings)}, from the {resolved.source})
            </span>
          )}
        </span>
      </label>
      {custom && <DepreciationFields draft={draft} onChange={setDraft} />}
      <label className="row">
        <input type="checkbox" checked={broughtForward} onChange={(e) => setBroughtForward(e.target.checked)} disabled={fixed} />
        <span>Acquired before the first year: bring forward accumulated depreciation</span>
      </label>
      {broughtForward && (
        <div className="row">
          <label className="field">
            <span>At the start of</span>
            <select value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} disabled={fixed}>
              {client.years.map((y) => (
                <option key={y.id} value={y.start}>
                  {formatDate(y.start)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Accumulated depreciation</span>
            <input
              value={openingAccumulated}
              onChange={(e) => setOpeningAccumulated(e.target.value)}
              disabled={fixed}
              inputMode="decimal"
            />
          </label>
        </div>
      )}
      {problem && <p role="alert">{problem}</p>}
      <ErrorMessage error={save.error} />
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>
          {existing ? "Save asset" : "Add asset"}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DisposeForm({ assetId, name, chart, onDone }: { assetId: string; name: string; chart: Account[]; onDone: () => void }) {
  const dispose = useCommand(INVALIDATES);
  const [date, setDate] = useState("");
  const [proceeds, setProceeds] = useState("0.00");
  const [account, setAccount] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cents = parseMoney(proceeds);
    if (cents === null || cents < 0) {
      setProblem("Enter the proceeds (nil if none).");
      return;
    }
    setProblem(null);
    dispose.mutate(
      { kind: "dispose_asset", payload: { asset_id: assetId, disposal: { date, proceeds: cents, proceeds_account: account } } },
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="card form">
      <h2>Dispose of {name}</h2>
      <p className="muted">This posts the disposal journal and reposts the year's depreciation.</p>
      <div className="row">
        <label className="field">
          <span>Disposal date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="field">
          <span>Proceeds</span>
          <input value={proceeds} onChange={(e) => setProceeds(e.target.value)} inputMode="decimal" />
        </label>
        <label className="field">
          <span>Proceeds account</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)} required>
            <option value="">Choose…</option>
            {chart
              .filter((a) => a.active)
              .map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} {a.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {problem && <p role="alert">{problem}</p>}
      <ErrorMessage error={dispose.error} />
      <div className="row">
        <button type="submit" className="primary" disabled={dispose.isPending}>
          Dispose
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The client's defaults per class: the practice's, or the client's own override. */
function ClassDefaults({ classes, canEdit, chart }: { classes: ClientClassView[]; canEdit: boolean; chart: Account[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  return (
    <>
      <h2>Class defaults for this client</h2>
      <p className="muted">
        New assets copy these. Changing them doesn't change existing assets until you apply them.
      </p>
      <table className="table" aria-label="Class defaults">
        <thead>
          <tr>
            <th>Class</th>
            <th>Method</th>
            <th>Conventions</th>
            <th>From</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {classes.map((c) => (
            <tr key={c.class.id}>
              <td>{c.class.name}</td>
              <td>{describeMethod(c.resolved.settings)}</td>
              <td>{describeConventions(c.resolved.settings)}</td>
              <td>{c.override_settings || c.override_accounts ? "client override" : "practice"}</td>
              {canEdit && (
                <td>
                  <div className="row">
                    <button type="button" onClick={() => setEditing(c.class.id)}>
                      Override…
                    </button>
                    <button type="button" onClick={() => setApplying(c.class.id)}>
                      Apply to existing assets…
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {classes
        .filter((c) => c.class.id === editing)
        .map((c) => (
          <OverrideForm key={c.class.id} view={c} chart={chart} onDone={() => setEditing(null)} />
        ))}
      {classes
        .filter((c) => c.class.id === applying)
        .map((c) => (
          <ApplyDefaults key={c.class.id} view={c} onDone={() => setApplying(null)} />
        ))}
    </>
  );
}

function OverrideForm({ view, chart, onDone }: { view: ClientClassView; chart: Account[]; onDone: () => void }) {
  const { client } = useYearContext();
  const save = useCommand(INVALIDATES);
  const [overrideSettings, setOverrideSettings] = useState(view.override_settings !== null);
  const [draft, setDraft] = useState(toDraft(view.resolved.settings));
  const [overrideAccounts, setOverrideAccounts] = useState(view.override_accounts !== null);
  const [accounts, setAccounts] = useState(view.resolved.accounts);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    let settings;
    if (overrideSettings) {
      const s = toSettings(draft);
      if (typeof s === "string") {
        setProblem(s);
        return;
      }
      settings = s;
    }
    setProblem(null);
    save.mutate(
      {
        kind: "set_client_asset_class",
        payload: { client_id: client.id, class_id: view.class.id, settings, accounts: overrideAccounts ? accounts : undefined },
      },
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="card form">
      <h2>{view.class.name} for {client.name}</h2>
      <label className="row">
        <input type="checkbox" checked={overrideSettings} onChange={(e) => setOverrideSettings(e.target.checked)} />
        <span>Override the practice's method and conventions ({describeMethod(view.class.settings)})</span>
      </label>
      {overrideSettings && <DepreciationFields draft={draft} onChange={setDraft} />}
      <label className="row">
        <input type="checkbox" checked={overrideAccounts} onChange={(e) => setOverrideAccounts(e.target.checked)} />
        <span>Override the accounts</span>
      </label>
      {overrideAccounts && <AssetAccountFields accounts={accounts} chart={chart} onChange={setAccounts} />}
      {problem && <p role="alert">{problem}</p>}
      <ErrorMessage error={save.error} />
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>
          Save defaults
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Previews pushing the class's defaults onto existing assets, then applies them on request. */
function ApplyDefaults({ view, onDone }: { view: ClientClassView; onDone: () => void }) {
  const { client } = useYearContext();
  const apply = useCommand(INVALIDATES);
  const query = useQuery({
    queryKey: [...keys.clientAssetClasses(client.id), view.class.id, "apply-preview"],
    queryFn: () => getJson<ApplyDefaultsChange[]>(`/api/clients/${client.id}/asset-classes/${view.class.id}/apply-preview`),
  });
  const preview = query.data ?? null;
  const error = query.error;
  return (
    <div className="card form">
      <h2>Apply {view.class.name} defaults</h2>
      <ErrorMessage error={error ?? apply.error} />
      {preview === null ? (
        <p className="muted">Working out what would change…</p>
      ) : preview.length === 0 ? (
        <p>Every asset in this class already has these defaults.</p>
      ) : (
        <>
          <p className="muted">Only open years change, at the next depreciation run. Custom settings are kept.</p>
          <table className="table" aria-label="Changes">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Method now</th>
                <th>Method after</th>
                <th>Accounts</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((c) => (
                <tr key={c.asset_id}>
                  <td>{c.name}</td>
                  <td>{describeMethod(c.settings_from)}</td>
                  <td>{describeMethod(c.settings_to)}</td>
                  <td>
                    {JSON.stringify(c.accounts_from) === JSON.stringify(c.accounts_to)
                      ? "unchanged"
                      : `${c.accounts_to.cost}, ${c.accounts_to.accumulated}, ${c.accounts_to.expense}, ${c.accounts_to.gain_loss}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="row">
        {preview !== null && preview.length > 0 && (
          <button
            type="button"
            className="primary"
            disabled={apply.isPending}
            onClick={() =>
              apply.mutate(
                { kind: "apply_asset_class_defaults", payload: { client_id: client.id, class_id: view.class.id } },
                { onSuccess: onDone },
              )
            }
          >
            Apply to {preview.length} asset{preview.length === 1 ? "" : "s"}
          </button>
        )}
        <button type="button" onClick={onDone}>
          Close
        </button>
      </div>
    </div>
  );
}
