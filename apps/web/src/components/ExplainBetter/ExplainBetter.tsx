import type { Explanation } from "@acct/types/Explanation";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ApiRequestError, requestExplanation } from "../../lib/api";
import { Icon } from "../../lib/icons";
import { Button, useToast } from "../../ui";
import { ErrorMessage } from "../ErrorMessage";
import styles from "./ExplainBetter.module.css";

/**
 * "Explain better" on a Save tax card: asks the server for a longer explanation written for this
 * owner's situation. The server finds the card itself and redacts what it sends, so only the card's
 * id goes up. When the day's allowance is used up it says so in a toast and stays disabled; when
 * the server has no AI service it shows nothing.
 */
export function ExplainBetter({ clientId, cardId }: { clientId: string; cardId: string }) {
  const toast = useToast();
  const [spent, setSpent] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const ask = useMutation<Explanation, Error>({
    mutationFn: () => requestExplanation(clientId, cardId),
    onError: (e) => {
      if (!(e instanceof ApiRequestError)) {
        return;
      }
      if (e.code === "ai_daily_limit") {
        setSpent(true);
        toast("Daily usage limit reached. Explanations are back tomorrow.", { tone: "warn" });
      } else if (e.code === "ai_unavailable" || e.code === "ai_suggestions_off") {
        setUnavailable(true);
      }
    },
  });
  if (unavailable) {
    return null;
  }
  const failed = ask.error instanceof ApiRequestError && ask.error.code === "ai_daily_limit" ? null : ask.error;
  return (
    <div className={styles.explain}>
      {ask.data ? (
        <p className={styles.text} role="status">
          <Icon name="business.save_explain" fallback="💬" /> {ask.data.text}
          <br />
          <span className="muted">Written by AI. Check it against your own records.</span>
        </p>
      ) : (
        <Button size="sm" onClick={() => ask.mutate()} busy={ask.isPending} disabled={spent}>
          <Icon name="business.save_explain" fallback="💬" /> {spent ? "Back tomorrow" : ask.isPending ? "Asking…" : "Explain better"}
        </Button>
      )}
      <ErrorMessage error={failed} />
    </div>
  );
}
