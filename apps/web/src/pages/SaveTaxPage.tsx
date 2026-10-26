import type { BankAccountView } from "@acct/types/BankAccountView";
import type { LineCoding } from "@acct/types/LineCoding";
import type { SaveTaxCard } from "@acct/types/SaveTaxCard";
import type { SaveTaxQueue } from "@acct/types/SaveTaxQueue";
import type { Via } from "@acct/types/Via";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { can, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson } from "../lib/api";
import { Icon } from "../lib/icons";
import { formatMoney } from "../lib/money";
import { keys, useBusiness, useChart } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { PageHeader } from "../ui";
import { AiSuggestionsPanel } from "./SaveTaxAi";
import { CardBody } from "./SaveTaxCards";
import { describeCoding } from "./SaveTaxCategorise";
import styles from "./SaveTax.module.css";

/** Under the business's key, so every command that invalidates the business refetches the queue. */
const saveTaxKey = (clientId: string) => [...keys.business(clientId), "save-tax"] as const;

export function useSaveTax(clientId: string) {
  return useQuery({ queryKey: saveTaxKey(clientId), queryFn: () => getJson<SaveTaxQueue>(`/api/businesses/${clientId}/save-tax`) });
}

/**
 * Save tax (PLAN.md M11): one card at a time, biggest saving first, with the running "saved so
 * far" at the top. Each answer is a command; the queue is refetched after it, so the server
 * re-sorts and drops cards that no longer save anything.
 */
export function SaveTaxPage() {
  const { clientId = "" } = useParams();
  const me = useCurrentUser();
  const business = useBusiness(clientId);
  const queue = useSaveTax(clientId);
  const [skipped, setSkipped] = useState<string[]>([]);

  if (queue.error || business.error) {
    return <ErrorMessage error={queue.error ?? business.error} />;
  }
  if (!queue.data || !business.data) {
    return <p className="muted">Working out where you could save…</p>;
  }
  const q = queue.data;
  const canEdit = can(me, "staff");
  const waiting = q.cards.filter((c) => !skipped.includes(c.id));
  const current = waiting[0];
  const skippedHere = q.cards.length - waiting.length;

  return (
    <>
      <PageHeader
        crumbs={[{ to: `/businesses/${clientId}`, label: business.data.name }]}
        icon={<Icon name="business.save" fallback="✂️" />}
        title="Save tax"
      />

      <div className={styles.scoreboard} role="status">
        <div>
          <span className="muted">
            <Icon name="business.save_saved" fallback="🎉" /> Saved so far
          </span>
          <strong className={styles.saved}>${formatMoney(q.saved_so_far)}</strong>
        </div>
        <div>
          <span className="muted">
            <Icon name="business.tax" fallback="💰" /> Tax to pay if submitted now
          </span>
          <strong>${formatMoney(q.total)}</strong>
        </div>
      </div>

      {canEdit && <AiSuggestionsPanel clientId={clientId} />}

      {canEdit && <AcceptAll cards={waiting} clientId={clientId} banks={business.data.bank_accounts} />}

      {!canEdit && <p className="muted">You can look, but viewers can't answer questions or sort transactions.</p>}

      {current ? (
        <>
          <p className="muted">
            {waiting.length === 1 ? "Last one!" : `${waiting.length} to go, biggest saving first.`}
          </p>
          <CardFrame
            key={current.id}
            card={current}
            clientId={clientId}
            banks={business.data.bank_accounts}
            gstRegistered={business.data.gst_registered_from !== null}
            canEdit={canEdit}
            onSkip={() => setSkipped((s) => [...s, current.id])}
          />
        </>
      ) : (
        <section className={styles.card}>
          <h2>
            <Icon name="business.save_done" fallback="🥳" /> {skippedHere > 0 ? "That's all for now" : "All done"}
          </h2>
          <p>
            {skippedHere > 0
              ? `You skipped ${skippedHere === 1 ? "one" : skippedHere}. Come back to ${skippedHere === 1 ? "it" : "them"} whenever you're ready.`
              : "There's nothing left that would bring your tax down."}
          </p>
          <div className="row">
            {skippedHere > 0 && (
              <button type="button" onClick={() => setSkipped([])}>
                <Icon name="business.save_skip" fallback="⏭️" /> Show the ones I skipped
              </button>
            )}
            <Link to={`/businesses/${clientId}`}>Back to {business.data.name}</Link>
          </div>
        </section>
      )}
    </>
  );
}

/** The card's frame: what it could save, its body, and Skip. */
function CardFrame({
  card,
  clientId,
  banks,
  gstRegistered,
  canEdit,
  onSkip,
}: {
  card: SaveTaxCard;
  clientId: string;
  banks: BankAccountView[];
  gstRegistered: boolean;
  canEdit: boolean;
  onSkip: () => void;
}) {
  return (
    <section className={styles.card} aria-label="Save tax card">
      <p className={styles.saving}>
        <Icon name="business.save_saving" fallback="💸" />{" "}
        {card.best_case ? `Could save up to $${formatMoney(card.saving)}` : `Saves $${formatMoney(card.saving)}`}
      </p>
      <CardBody card={card} clientId={clientId} banks={banks} gstRegistered={gstRegistered} canEdit={canEdit} />
      <div className={styles.skip}>
        <button type="button" onClick={onSkip}>
          <Icon name="business.save_skip" fallback="⏭️" /> Skip for now
        </button>
      </div>
    </section>
  );
}

/**
 * "Accept all suggestions": every categorise card with a suggestion, coded in one batch command.
 * The list shows what each line becomes before the owner agrees.
 */
function AcceptAll({ cards, clientId, banks }: { cards: SaveTaxCard[]; clientId: string; banks: BankAccountView[] }) {
  const chart = useChart(clientId);
  const command = useCommand([keys.business(clientId)]);
  const suggested = cards.filter((c) => c.kind === "categorise" && c.suggestion && c.lines.length === 1);
  if (suggested.length === 0) {
    return null;
  }
  const accept = async () => {
    try {
      for (const batch of acceptBatches(suggested)) {
        await command.mutateAsync(batch);
      }
    } catch {
      // Shown below from command.error; batches already accepted stay accepted.
    }
  };
  return (
    <div className={styles.acceptAll}>
      <p>
        <Icon name="business.save_suggest" fallback="💡" /> We have a suggestion for {suggested.length === 1 ? "1 transaction" : `${suggested.length} transactions`},
        from your rules, how you sorted the same descriptions before, your accountant's list of common businesses and, if
        you've turned it on, AI.
      </p>
      <details>
        <summary>See the suggestions</summary>
        <ul>
          {suggested.map((c) => (
            <li key={c.id}>
              {c.lines[0]!.description}, ${formatMoney(Math.abs(c.lines[0]!.amount))}: {describeCoding(c.suggestion!.coding, chart.data, banks)}
            </li>
          ))}
        </ul>
      </details>
      <ErrorMessage error={command.error} />
      <button type="button" className="primary" onClick={() => void accept()} disabled={command.isPending}>
        <Icon name="business.save_accept_all" fallback="✨" /> Accept all suggestions
      </button>
    </div>
  );
}

type Batch = { kind: "code_bank_lines"; payload: { lines: LineCoding[] }; via?: Via };

/**
 * The commands for "Accept all suggestions": one per AI model, each with `via` listing only its
 * AI suggestions, as the server checks every listed id against that model. Rule and history
 * lines ride along in the first command; the server checks only the ids `via` lists.
 */
export function acceptBatches(cards: SaveTaxCard[]): Batch[] {
  const plain: LineCoding[] = [];
  const byModel = new Map<string, { lines: LineCoding[]; ids: string[] }>();
  for (const c of cards) {
    const s = c.suggestion!;
    const entry: LineCoding = { bank_line_id: c.lines[0]!.bank_line_id, coding: s.coding };
    if (s.source === "ai" && s.id && s.model) {
      const group = byModel.get(s.model) ?? { lines: [], ids: [] };
      group.lines.push(entry);
      group.ids.push(s.id);
      byModel.set(s.model, group);
    } else {
      plain.push(entry);
    }
  }
  const batches: Batch[] = [...byModel].map(([model, g]) => ({
    kind: "code_bank_lines",
    payload: { lines: g.lines },
    via: { kind: "suggestion", model, suggestion_ids: g.ids },
  }));
  if (plain.length > 0) {
    if (batches[0]) {
      batches[0].payload.lines.push(...plain);
    } else {
      batches.push({ kind: "code_bank_lines", payload: { lines: plain } });
    }
  }
  return batches;
}
