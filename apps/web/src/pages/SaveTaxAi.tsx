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

function names(text: string): string[] {
  return text
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
}

/**
 * AI suggestions on the Save tax screen: on by default, with no consent screen (ADR 011). A button
 * asks for suggestions, and the owner can turn them off. Shows nothing when the server has no AI
 * service.
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
  return v.enabled ? <AiOn clientId={clientId} view={v} /> : <AiOff clientId={clientId} />;
}

function AiOff({ clientId }: { clientId: string }) {
  const command = useCommand([keys.business(clientId)]);
  return (
    <section className={styles.acceptAll} aria-label="AI suggestions">
      <p>
        <Icon name="business.save_ai" fallback="🤖" /> AI suggestions are off for this business.
      </p>
      <div className="row">
        <button
          type="button"
          onClick={() => command.mutate({ kind: "set_ai_suggestions", payload: { client_id: clientId, enabled: true } })}
          disabled={command.isPending}
        >
          <Icon name="business.ok" fallback="✅" /> Turn suggestions on
        </button>
      </div>
      {command.error && <ErrorMessage error={command.error} />}
    </section>
  );
}

/** Names to strip and the business's activity phrase, both optional. */
function AiSettingsForm({ clientId, view }: { clientId: string; view: AiSuggestionsView }) {
  const command = useCommand([keys.business(clientId)]);
  const [activity, setActivity] = useState(view.activity ?? "");
  const [privateNames, setPrivateNames] = useState(view.private_names.join(", "));
  const save = () =>
    command.mutate({
      kind: "set_ai_suggestions",
      payload: { client_id: clientId, enabled: true, activity: activity.trim(), private_names: names(privateNames) },
    });
  return (
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
        <div className="row">
          <button type="button" onClick={save} disabled={command.isPending}>
            <Icon name="business.ok" fallback="✅" /> Save
          </button>
        </div>
        {command.isSuccess && <p role="status">Saved.</p>}
        {command.error && <ErrorMessage error={command.error} />}
      </div>
    </details>
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
      <AiSettingsForm clientId={clientId} view={view} />
    </section>
  );
}
