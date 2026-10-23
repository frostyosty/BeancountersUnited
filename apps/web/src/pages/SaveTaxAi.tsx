import type { AiSuggestionsView } from "@acct/types/AiSuggestionsView";
import type { AiSuggestRun } from "@acct/types/AiSuggestRun";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage";
import { getJson, requestAiSuggestions } from "../lib/api";
import { Icon } from "../lib/icons";
import { keys } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import styles from "./SaveTax.module.css";

/** Under the business's key, so every command that invalidates the business refetches it. */
const aiKey = (clientId: string) => [...keys.business(clientId), "ai-suggestions"] as const;

/**
 * Days the provider keeps a request (Anthropic: 30, confirmed 2026-10-24). Changing it changes the
 * wording, so bump `CONSENT_WORDING` in crates/server/src/ai.rs too, and everyone is asked again.
 */
const RETENTION_DAYS = 30;

/** ADR 009's consent wording (version 2026-10-24). Keep in step with `CONSENT_WORDING`. */
export function ConsentWording({ provider }: { provider: string }) {
  const kept = `within ${RETENTION_DAYS} days`;
  return (
    <>
      <p>
        We can ask an AI service ({provider}) to suggest a category for each transaction, so you can accept them in one go. It sees
        each transaction's description and rounded amount, and our list of categories. It never sees your name, your business's
        name, your bank account numbers or your IRD number, and we strip those out of descriptions too. A description can still
        name someone you paid.
      </p>
      <p>
        The service runs overseas. It doesn't use your data to train its models, and deletes it {kept}. Nothing changes until you
        accept a suggestion. You can turn this off at any time.
      </p>
    </>
  );
}

function names(text: string): string[] {
  return text
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
}

/**
 * AI suggestions on the Save tax screen (ADR 009): the consent to turn them on, then a button to
 * ask for suggestions and one to turn them off. Shows nothing when the server has no AI service.
 * Until M12's owner role, staff turn it on for the owner, once the owner has agreed.
 */
export function AiSuggestionsPanel({ clientId }: { clientId: string }) {
  const view = useQuery({
    queryKey: aiKey(clientId),
    queryFn: () => getJson<AiSuggestionsView>(`/api/businesses/${clientId}/ai-suggestions`),
  });
  const v = view.data;
  if (!v || !v.available) {
    return null;
  }
  return v.enabled && !v.needs_consent ? <AiOn clientId={clientId} view={v} /> : <AiConsent clientId={clientId} view={v} />;
}

function AiConsent({ clientId, view }: { clientId: string; view: AiSuggestionsView }) {
  const command = useCommand([keys.business(clientId)]);
  const [agreed, setAgreed] = useState(false);
  const [activity, setActivity] = useState(view.activity ?? "");
  const [privateNames, setPrivateNames] = useState(view.private_names.join(", "));
  const provider = view.provider ?? "an AI service";

  const turnOn = () =>
    command.mutate({
      kind: "set_ai_suggestions",
      payload: {
        client_id: clientId,
        enabled: true,
        consent_version: view.consent_version ?? undefined,
        activity: activity.trim(),
        private_names: names(privateNames),
      },
    });

  return (
    <section className={styles.acceptAll} aria-label="AI suggestions">
      <h2>
        <Icon name="business.save_ai" fallback="🤖" /> Suggest categories for me
      </h2>
      {view.needs_consent && (
        <p>
          <Icon name="business.notice" fallback="ℹ️" /> What we say about this has changed, or the AI service has, so the owner
          needs to agree again before we ask for more suggestions.
        </p>
      )}
      <ConsentWording provider={provider} />
      <details>
        <summary>Keep more names private (optional)</summary>
        <div className={styles.form}>
          <label>
            Other names to strip from descriptions, such as the owner's and anyone else on the account, separated by commas
            <input value={privateNames} onChange={(e) => setPrivateNames(e.target.value)} placeholder="Q Marsh" />
          </label>
          <label>
            What the business does, in a few words (helps the suggestions)
            <input value={activity} onChange={(e) => setActivity(e.target.value)} maxLength={60} placeholder="candle maker" />
          </label>
        </div>
      </details>
      <label className={styles.check}>
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> The owner has read this and agrees
      </label>
      <div className="row">
        <button type="button" onClick={turnOn} disabled={!agreed || command.isPending}>
          <Icon name="business.ok" fallback="✅" /> Turn on suggestions
        </button>
      </div>
      {command.error && <ErrorMessage error={command.error} />}
    </section>
  );
}

function AiOn({ clientId, view }: { clientId: string; view: AiSuggestionsView }) {
  const qc = useQueryClient();
  const turnOff = useCommand([keys.business(clientId)]);
  const ask = useMutation<AiSuggestRun, Error>({
    mutationFn: () => requestAiSuggestions(clientId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.business(clientId) }),
  });
  const run = ask.data;

  return (
    <section className={styles.acceptAll} aria-label="AI suggestions">
      <p>
        <Icon name="business.save_ai" fallback="🤖" /> AI suggestions are on{view.provider ? `, from ${view.provider}` : ""}.{" "}
        {view.suggestions.length > 0 &&
          `${view.suggestions.length === 1 ? "1 suggestion is" : `${view.suggestions.length} suggestions are`} waiting on the cards below.`}
      </p>
      <div className="row">
        <button type="button" onClick={() => ask.mutate()} disabled={ask.isPending}>
          <Icon name="business.save_ai_ask" fallback="✨" /> {ask.isPending ? "Asking…" : "Suggest categories now"}
        </button>
        <button
          type="button"
          onClick={() => turnOff.mutate({ kind: "set_ai_suggestions", payload: { client_id: clientId, enabled: false } })}
          disabled={turnOff.isPending}
        >
          <Icon name="business.save_ai_off" fallback="🚫" /> Turn suggestions off
        </button>
      </div>
      {run && (
        <p role="status">
          {run.asked === 0
            ? "There was nothing new to ask about."
            : `Asked about ${run.asked === 1 ? "1 transaction" : `${run.asked} transactions`}, and got ${
                run.suggestions.length === 1 ? "1 suggestion" : `${run.suggestions.length} suggestions`
              }.`}
          {run.failed_batches > 0 && " Some couldn't be reached. Try again in a minute."}
        </p>
      )}
      {(ask.error ?? turnOff.error) && <ErrorMessage error={ask.error ?? turnOff.error} />}
    </section>
  );
}
