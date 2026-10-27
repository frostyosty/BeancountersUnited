import type { AssetAccounts } from "@acct/types/AssetAccounts";
import type { SettingsDraft } from "./depreciation";
import { DEFAULT_DRAFT } from "./depreciation";

type Account = { code: string; name: string; account_type: string; active: boolean };

/** A ready-made asset class to start from. Everything in it can be changed before adding. */
export interface AssetPreset {
  key: string;
  name: string;
  icon: string;
  blurb: string;
  draft: SettingsDraft;
  /** Words that pick out this kind of asset's cost account in a chart, such as "vehicle". */
  match: RegExp;
}

const dv = (rate: string): SettingsDraft => ({ ...DEFAULT_DRAFT, method: "dv", rate });
const sl = (rate: string): SettingsDraft => ({ ...DEFAULT_DRAFT, method: "sl", slBasis: "rate", rate });

/** Starting points only: accounting depreciation is the practice's call, so each rate is editable. */
export const ASSET_PRESETS: AssetPreset[] = [
  { key: "plant", name: "Plant and equipment", icon: "🏭", blurb: "DV 15%", draft: dv("15"), match: /plant|equipment|machin/i },
  { key: "motor_vehicles", name: "Motor vehicles", icon: "🚗", blurb: "DV 21%", draft: dv("21"), match: /vehicle|motor/i },
  { key: "computers", name: "Computers and office equipment", icon: "💻", blurb: "DV 40%", draft: dv("40"), match: /comput|office/i },
  { key: "furniture", name: "Furniture and fittings", icon: "🪑", blurb: "DV 13%", draft: dv("13"), match: /furnit|fitting/i },
  { key: "tools", name: "Tools", icon: "🔧", blurb: "DV 20%", draft: dv("20"), match: /tool/i },
  { key: "buildings", name: "Buildings", icon: "🏢", blurb: "SL 2%", draft: sl("2"), match: /building|property/i },
  { key: "land", name: "Land", icon: "🌳", blurb: "Not depreciated", draft: { ...DEFAULT_DRAFT, method: "none" }, match: /land/i },
];

/** Best-effort accounts from a chart's names; whatever can't be matched is left for the user to choose. */
export function guessAccounts(preset: AssetPreset, chart: Account[]): AssetAccounts {
  const active = chart.filter((a) => a.active);
  const assets = active.filter((a) => a.account_type === "asset" && preset.match.test(a.name));
  const find = (list: Account[], re: RegExp) => list.find((a) => re.test(a.name))?.code ?? "";
  const expenses = active.filter((a) => a.account_type === "expense");
  const gains = active.filter((a) => a.account_type === "income" || a.account_type === "expense");
  return {
    cost: find(assets, /^(?!.*(accum|depn|deprec))/i),
    accumulated: find(assets, /accum|depn|deprec/i),
    expense: find(expenses, /deprec/i),
    gain_loss: find(gains, /dispos|gain|loss/i),
  };
}
