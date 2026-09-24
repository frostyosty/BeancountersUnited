import type { Account } from "@acct/types/Account";
import type { AccountType } from "@acct/types/AccountType";
import type { AssetAccounts } from "@acct/types/AssetAccounts";
import type { SettingsDraft } from "../lib/depreciation";

/** Fields for a method and its conventions. `label` prefixes each field's accessible name. */
export function DepreciationFields({
  draft,
  onChange,
  label = "",
}: {
  draft: SettingsDraft;
  onChange: (d: SettingsDraft) => void;
  label?: string;
}) {
  const set = <K extends keyof SettingsDraft>(k: K, v: SettingsDraft[K]) => onChange({ ...draft, [k]: v });
  const usesRate = draft.method === "dv" || (draft.method === "sl" && draft.slBasis === "rate");
  return (
    <div className="row">
      <label className="field">
        <span>{label}Method</span>
        <select value={draft.method} onChange={(e) => set("method", e.target.value as SettingsDraft["method"])}>
          <option value="dv">Diminishing value</option>
          <option value="sl">Straight line</option>
          <option value="none">Not depreciated</option>
        </select>
      </label>
      {draft.method === "sl" && (
        <label className="field">
          <span>{label}Straight line on</span>
          <select value={draft.slBasis} onChange={(e) => set("slBasis", e.target.value as SettingsDraft["slBasis"])}>
            <option value="rate">a rate</option>
            <option value="life">a useful life</option>
          </select>
        </label>
      )}
      {usesRate && (
        <label className="field">
          <span>{label}Rate %</span>
          <input value={draft.rate} onChange={(e) => set("rate", e.target.value)} inputMode="decimal" size={6} />
        </label>
      )}
      {draft.method === "sl" && draft.slBasis === "life" && (
        <label className="field">
          <span>{label}Life (months)</span>
          <input value={draft.lifeMonths} onChange={(e) => set("lifeMonths", e.target.value)} inputMode="numeric" size={5} />
        </label>
      )}
      {draft.method !== "none" && (
        <>
          <label className="field">
            <span>{label}Year of acquisition</span>
            <select value={draft.partYear} onChange={(e) => set("partYear", e.target.value as SettingsDraft["partYear"])}>
              <option value="months_held">Months held</option>
              <option value="daily">Days held</option>
              <option value="full_year">Full year</option>
            </select>
          </label>
          {draft.partYear === "months_held" && (
            <label className="field">
              <span>{label}Count the month of acquisition</span>
              <input
                type="checkbox"
                checked={draft.countAcquisitionMonth}
                onChange={(e) => set("countAcquisitionMonth", e.target.checked)}
              />
            </label>
          )}
          <label className="field">
            <span>{label}Year of disposal</span>
            <select value={draft.disposalYear} onChange={(e) => set("disposalYear", e.target.value as SettingsDraft["disposalYear"])}>
              <option value="to_disposal_date">To the disposal date</option>
              <option value="none">None</option>
            </select>
          </label>
        </>
      )}
    </div>
  );
}

const ROLES: { key: keyof AssetAccounts; label: string; types: AccountType[] }[] = [
  { key: "cost", label: "Cost account", types: ["asset"] },
  { key: "accumulated", label: "Accumulated depreciation account", types: ["asset"] },
  { key: "expense", label: "Depreciation expense account", types: ["expense"] },
  { key: "gain_loss", label: "Gain/loss on disposal account", types: ["income", "expense"] },
];

/** The four accounts an asset class posts to, chosen from `chart`'s active accounts. */
export function AssetAccountFields({
  accounts,
  chart,
  onChange,
}: {
  accounts: AssetAccounts;
  chart: Account[];
  onChange: (a: AssetAccounts) => void;
}) {
  return (
    <div className="row">
      {ROLES.map((r) => (
        <label className="field" key={r.key}>
          <span>{r.label}</span>
          <select value={accounts[r.key]} onChange={(e) => onChange({ ...accounts, [r.key]: e.target.value })}>
            <option value="">Choose…</option>
            {chart
              .filter((a) => a.active && r.types.includes(a.account_type))
              .map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} {a.name}
                </option>
              ))}
          </select>
        </label>
      ))}
    </div>
  );
}

export const NO_ACCOUNTS: AssetAccounts = { cost: "", accumulated: "", expense: "", gain_loss: "" };
