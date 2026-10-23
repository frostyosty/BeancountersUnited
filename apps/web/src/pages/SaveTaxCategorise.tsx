import type { Account } from "@acct/types/Account";
import type { BankAccountView } from "@acct/types/BankAccountView";
import type { Coding } from "@acct/types/Coding";
import type { GstCode } from "@acct/types/GstCode";
import type { SaveTaxCard } from "@acct/types/SaveTaxCard";
import { type FormEvent, useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { Emoji, Icon } from "../lib/icons";
import { formatMoney } from "../lib/money";
import { keys, useChart, useClientAssetClasses } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import styles from "./SaveTax.module.css";

/** Over this, GST is claimed only once the owner holds the supplier's tax invoice (PLAN.md M11). */
export const SUPPLY_INFO_THRESHOLD = 20000;

/**
 * Accounts the owner never picks as a category: money in waiting to be sorted (the server's fixed
 * holding account, `MONEY_IN` in crates/server/src/business.rs).
 */
const HIDDEN = new Set(["140"]);

type InChoice = "income" | "transfer" | "loan" | "owner_funds" | "gst_refund" | "paye_wages" | "personal_sale";
type OutChoice = "expense" | "part_private" | "asset_purchase" | "personal" | "transfer" | "ird_gst" | "ird_income_tax";

const IN_CHOICES: [InChoice, string, string][] = [
  ["income", "💵", "Money the business earned"],
  ["transfer", "🔁", "Moved from another of my accounts"],
  ["owner_funds", "🙋", "Money I put in myself"],
  ["loan", "🏦", "A loan"],
  ["gst_refund", "🏛️", "A GST refund from IRD"],
  ["paye_wages", "💼", "Wages from a job (tax already taken off)"],
  ["personal_sale", "🏷️", "I sold something personal"],
];

const OUT_CHOICES: [OutChoice, string, string][] = [
  ["expense", "🧾", "A business cost"],
  ["part_private", "➗", "Partly business, partly personal"],
  ["asset_purchase", "🛠️", "Something for the business that lasts years (tools, a vehicle, a computer)"],
  ["personal", "🛒", "Personal spending"],
  ["transfer", "🔁", "Moved to another of my accounts"],
  ["ird_gst", "🏛️", "GST paid to IRD"],
  ["ird_income_tax", "🏛️", "Income tax paid to IRD"],
];

/** The choice list, without emoji, for describing a coding in a sentence. */
const PLAIN: Record<string, string> = {
  "in:loan": "A loan",
  "in:owner_funds": "Money you put in yourself",
  "in:gst_refund": "A GST refund from IRD",
  "in:paye_wages": "Wages from a job, tax already taken off",
  "in:personal_sale": "Something personal you sold",
  "out:personal": "Personal spending",
  "out:ird_gst": "GST paid to IRD",
  "out:ird_income_tax": "Income tax paid to IRD",
};

export const GST_CHOICES: [GstCode, string][] = [
  ["standard", "Includes GST"],
  ["zero", "GST at 0% (zero-rated)"],
  ["exempt", "No GST: exempt (like bank fees or interest)"],
  ["none", "No GST: not a sale (like wages or donations)"],
];

/** The income year (to 31 March) that an ISO date falls in. */
export function incomeYearOf(iso: string): number {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return month >= 4 ? year + 1 : year;
}

/**
 * Parses a percentage such as `30` or `12.5` into basis points, with integer arithmetic only
 * (hard rule 4). Returns null unless it's between 0 and 100 with at most two decimals.
 */
export function parsePercentBp(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/%$/, "").trim());
  if (!m) {
    return null;
  }
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= 10000 ? bp : null;
}

/** `12.5` for 1250 basis points. */
export function formatPercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  const part = bp % 100;
  return part === 0 ? String(whole) : `${whole}.${String(part).padStart(2, "0").replace(/0$/, "")}`;
}

function nameOf(code: string, chart: Account[] | undefined, banks: BankAccountView[]): string {
  return banks.find((b) => b.code === code)?.name ?? chart?.find((a) => a.code === code)?.name ?? "another account";
}

/** A coding in plain words, for the owner. Never shows an account code. */
export function describeCoding(c: Coding, chart: Account[] | undefined, banks: BankAccountView[]): string {
  const plain = PLAIN[`${c.direction}:${c.kind}`];
  if (plain) {
    return plain;
  }
  if (c.direction === "in") {
    switch (c.kind) {
      case "income":
        return `Income: ${nameOf(c.account, chart, banks)}`;
      case "transfer":
        return `Moved from ${nameOf(c.from, chart, banks)}`;
      default:
        return "Not income";
    }
  }
  switch (c.kind) {
    case "expense":
      return nameOf(c.account, chart, banks);
    case "part_private":
      return `${nameOf(c.account, chart, banks)}, ${formatPercent(c.business_bp)}% business`;
    case "asset_purchase":
      return `Bought for the business to keep: ${nameOf(c.account, chart, banks)}`;
    case "transfer":
      return `Moved to ${nameOf(c.to, chart, banks)}`;
    default:
      return "Spending";
  }
}

interface FormState {
  choice: string;
  account: string;
  gst: GstCode;
  /** The personal share, as typed. */
  privatePct: string;
  bank: string;
  assetClass: string;
  haveInvoice: boolean;
  always: boolean;
  ruleText: string;
}

function initialState(card: SaveTaxCard, chart: Account[] | undefined): FormState {
  const line = card.lines[0]!;
  const s: FormState = {
    choice: "",
    account: "",
    gst: "standard",
    privatePct: "",
    bank: "",
    assetClass: "",
    haveInvoice: false,
    always: false,
    ruleText: line.description,
  };
  const c = card.suggestion?.coding;
  if (!c) {
    return s;
  }
  s.choice = c.kind;
  if ("account" in c) {
    s.account = c.account;
  }
  if ("gst" in c) {
    s.gst = c.gst;
  } else if (s.account) {
    s.gst = chart?.find((a) => a.code === s.account)?.default_gst ?? "standard";
  }
  if (c.direction === "out" && c.kind === "part_private") {
    s.privatePct = formatPercent(10000 - c.business_bp);
  }
  if (c.direction === "in" && c.kind === "transfer") {
    s.bank = c.from;
  }
  if (c.direction === "out" && c.kind === "transfer") {
    s.bank = c.to;
  }
  return s;
}

/** Builds the coding from the form, or says what's missing. */
function buildCoding(direction: "in" | "out", s: FormState, gstRegistered: boolean): Coding | string {
  const gst: GstCode = gstRegistered ? s.gst : "none";
  if (direction === "in") {
    switch (s.choice as InChoice) {
      case "income":
        // Income can't be outside GST; for an owner who isn't registered the code is ignored.
        return s.account ? { direction, kind: "income", account: s.account, gst: s.gst === "none" ? "standard" : s.gst } : "Choose what kind of income.";
      case "transfer":
        return s.bank ? { direction, kind: "transfer", from: s.bank } : "Choose which account it came from.";
      case "loan":
      case "owner_funds":
      case "gst_refund":
      case "paye_wages":
      case "personal_sale":
        return { direction, kind: s.choice as Exclude<InChoice, "income" | "transfer"> };
      default:
        return "Choose what this money was.";
    }
  }
  switch (s.choice as OutChoice) {
    case "expense":
      return s.account ? { direction, kind: "expense", account: s.account, gst } : "Choose a category.";
    case "part_private": {
      if (!s.account) {
        return "Choose a category.";
      }
      const privateBp = parsePercentBp(s.privatePct);
      if (privateBp === null || privateBp === 0 || privateBp === 10000) {
        return "Say how much was personal, as a percentage between 0 and 100.";
      }
      return { direction, kind: "part_private", account: s.account, gst, business_bp: 10000 - privateBp };
    }
    case "asset_purchase":
      return s.account ? { direction, kind: "asset_purchase", account: s.account, gst } : "Choose what kind of thing you bought.";
    case "transfer":
      return s.bank ? { direction, kind: "transfer", to: s.bank } : "Choose which account it went to.";
    case "personal":
    case "ird_gst":
    case "ird_income_tax":
      return { direction, kind: s.choice as "personal" | "ird_gst" | "ird_income_tax" };
    default:
      return "Choose what this spending was.";
  }
}

/**
 * The form on a categorise card: what the line was, in plain words. Categories are accounts
 * underneath, but the owner only ever sees their names.
 */
export function CategoriseForm({
  card,
  clientId,
  banks,
  gstRegistered,
  onDone,
}: {
  card: SaveTaxCard;
  clientId: string;
  banks: BankAccountView[];
  gstRegistered: boolean;
  onDone?: () => void;
}) {
  const chart = useChart(clientId);
  const command = useCommand([keys.business(clientId)]);
  const [s, setS] = useState<FormState>(() => initialState(card, chart.data));
  const [problem, setProblem] = useState<string | null>(null);
  const line = card.lines[0]!;
  const direction = line.amount >= 0 ? "in" : "out";
  const set = (patch: Partial<FormState>) => {
    setProblem(null);
    setS((old) => ({ ...old, ...patch }));
  };

  const active = (chart.data ?? []).filter((a) => a.active && !HIDDEN.has(a.code));
  const categories = active.filter((a) => a.account_type === (direction === "in" ? "income" : "expense"));
  const otherBanks = banks.filter((b) => b.id !== line.bank_account_id);
  const choices = direction === "in" ? IN_CHOICES : OUT_CHOICES;
  const spending = direction === "out" && ["expense", "part_private", "asset_purchase"].includes(s.choice);
  const showInvoice = gstRegistered && spending && s.gst === "standard" && -line.amount > SUPPLY_INFO_THRESHOLD;
  const canRule = s.choice !== "asset_purchase";

  const pickAccount = (code: string) => {
    const account = chart.data?.find((a) => a.code === code);
    set({ account: code, gst: account?.default_gst ?? s.gst });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const coding = buildCoding(direction, s, gstRegistered);
    if (typeof coding === "string") {
      setProblem(coding);
      return;
    }
    try {
      await command.mutateAsync({
        kind: "code_bank_line",
        payload: {
          bank_line_id: line.bank_line_id,
          coding,
          ...(showInvoice && s.haveInvoice ? { supply_info_confirmed: true } : {}),
          ...(s.choice === "asset_purchase" && s.assetClass ? { asset_class_id: s.assetClass } : {}),
        },
      });
      if (s.always && canRule && s.ruleText.trim()) {
        await command.mutateAsync({
          kind: "add_rule",
          payload: { client_id: clientId, description_contains: s.ruleText.trim(), coding },
        });
      }
      onDone?.();
    } catch {
      // Shown below from command.error.
    }
  };

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)}>
      <fieldset className={styles.choices}>
        <legend>{direction === "in" ? "What was this money?" : "What was this spending?"}</legend>
        {choices.map(([value, emoji, label]) => (
          <label key={value} className={styles.choice}>
            <input type="radio" name={`choice-${card.id}`} value={value} checked={s.choice === value} onChange={() => set({ choice: value })} />{" "}
            <Emoji>{emoji}</Emoji> {label}
          </label>
        ))}
      </fieldset>

      {((direction === "in" && s.choice === "income") || (direction === "out" && (s.choice === "expense" || s.choice === "part_private"))) && (
        <label className="field">
          Category
          <select value={s.account} onChange={(e) => pickAccount(e.target.value)}>
            <option value="">Choose…</option>
            {categories.map((a) => (
              <option key={a.code} value={a.code}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {s.choice === "asset_purchase" && <AssetPicker clientId={clientId} value={s.assetClass} onPick={(assetClass, account) => set({ assetClass, account })} />}

      {s.choice === "transfer" && (
        <label className="field">
          {direction === "in" ? "Which account did it come from?" : "Which account did it go to?"}
          <select value={s.bank} onChange={(e) => set({ bank: e.target.value })}>
            <option value="">Choose…</option>
            {otherBanks.map((b) => (
              <option key={b.id} value={b.code}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {s.choice === "part_private" && (
        <label className="field">
          How much of it was personal? (%)
          <input value={s.privatePct} onChange={(e) => set({ privatePct: e.target.value })} inputMode="decimal" placeholder="e.g. 30" />
        </label>
      )}

      {gstRegistered && spending && (
        <label className="field">
          GST
          <select value={s.gst} onChange={(e) => set({ gst: e.target.value as GstCode })}>
            {GST_CHOICES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}

      {showInvoice && (
        <label className={styles.check}>
          <input type="checkbox" checked={s.haveInvoice} onChange={(e) => set({ haveInvoice: e.target.checked })} /> I have the supplier's tax
          invoice. Over ${formatMoney(SUPPLY_INFO_THRESHOLD)}, you can only claim the GST once you have it.
        </label>
      )}

      {canRule && s.choice && (
        <div className={styles.rule}>
          <label className={styles.check}>
            <input type="checkbox" checked={s.always} onChange={(e) => set({ always: e.target.checked })} /> Always do this for "{line.description}"
          </label>
          {s.always && (
            <label className="field">
              <span className="muted">
                <Icon name="business.save_rule" fallback="📌" /> We'll do the same for any {direction === "in" ? "money in" : "spending"} whose description contains:
              </span>
              <input value={s.ruleText} onChange={(e) => set({ ruleText: e.target.value })} aria-label="Description contains" />
            </label>
          )}
        </div>
      )}

      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <ErrorMessage error={command.error} />
      <div className="row">
        <button type="submit" className="primary" disabled={command.isPending}>
          <Icon name="business.save_ok" fallback="✅" /> Save
        </button>
      </div>
    </form>
  );
}

/** Choose the kind of thing bought: an asset class, which names the account it's kept in. */
function AssetPicker({ clientId, value, onPick }: { clientId: string; value: string; onPick: (classId: string, account: string) => void }) {
  const classes = useClientAssetClasses(clientId);
  return (
    <label className="field">
      What kind of thing?
      <select
        value={value}
        onChange={(e) => {
          const c = classes.data?.find((x) => x.class.id === e.target.value);
          onPick(e.target.value, c?.resolved.accounts.cost ?? "");
        }}
      >
        <option value="">Choose…</option>
        {(classes.data ?? []).map((c) => (
          <option key={c.class.id} value={c.class.id}>
            {c.class.name}
          </option>
        ))}
      </select>
      <ErrorMessage error={classes.error} />
    </label>
  );
}
