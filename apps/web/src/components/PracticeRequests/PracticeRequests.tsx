import type { PracticeRequestView } from "@acct/types/PracticeRequestView";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "../../auth";
import { getJson } from "../../lib/api";
import { formatDate } from "../../lib/dates";
import { Icon } from "../../lib/icons";
import { useCommand } from "../../lib/useCommand";
import { Button, Card, EmptyState, useConfirm } from "../../ui";
import { ErrorMessage } from "../ErrorMessage";
import { CLIENT_BANDS } from "../PracticeRequest";
import styles from "./PracticeRequests.module.css";

const KEY = ["practice-requests"] as const;

const FROM_LABEL: Record<NonNullable<PracticeRequestView["from"]>, string> = {
  who_are_you: "Who are you? (from a trial)",
  accountants_page: "For accountants page",
  signup_page: "Sign-up page",
};

const bandLabel = (band: PracticeRequestView["clients"]) => CLIENT_BANDS.find((b) => b.value === band)?.label ?? band;

/**
 * The practice requests, newest first (M21, ADR 015, 7). For overseers only: it renders nothing, and
 * asks for nothing, for anyone else. Accepting one stays manual for now, so an overseer reads the list,
 * replies, and deletes one when it's spam or the person asks (the sweep deletes the rest after 90 days).
 */
export function PracticeRequests() {
  const me = useCurrentUser();
  if (me.role !== "overseer") {
    return null;
  }
  return <RequestList />;
}

function RequestList() {
  const list = useQuery({ queryKey: KEY, queryFn: () => getJson<PracticeRequestView[]>("/api/practice-requests") });
  const del = useCommand([KEY]);
  const [confirm, confirmDialog] = useConfirm();

  const remove = async (r: PracticeRequestView) => {
    const ok = await confirm({
      title: "Delete this request?",
      children: (
        <p>
          {r.name} ({r.practice_name}) is deleted for good, with their email and phone. Do this when it's spam or they
          asked.
        </p>
      ),
      confirmLabel: "Delete it",
      tone: "danger",
    });
    if (ok) {
      del.mutate({ kind: "delete_practice_request", payload: { request_id: r.id, why: "by_overseer" } });
    }
  };

  return (
    <Card title="Practice requests" icon={<Icon name="overseer.requests" fallback="📥" />}>
      <p className="muted">
        People who asked for a practice account, newest first. Reply by email and set the practice up by hand. Each is
        deleted 90 days after it arrived.
      </p>
      <ErrorMessage error={list.error ?? del.error} />
      {list.data && list.data.length === 0 && (
        <EmptyState icon={<Icon name="overseer.requests" fallback="📥" />} title="No practice requests">
          They show here when someone asks.
        </EmptyState>
      )}
      {list.data && list.data.length > 0 && (
        <ul className={styles.list}>
          {list.data.map((r) => (
            <li key={r.id} className={styles.request}>
              <div className={styles.who}>
                <strong>{r.practice_name}</strong>
                <span>
                  {r.name} · <a href={`mailto:${r.email}`}>{r.email}</a>
                  {r.phone ? ` · ${r.phone}` : ""}
                </span>
                <span className="muted">
                  {bandLabel(r.clients)} clients · {r.from ? FROM_LABEL[r.from] : "not recorded"} · asked{" "}
                  {formatDate(r.created_at.slice(0, 10))} · deleted {formatDate(r.delete_after.slice(0, 10))}
                </span>
              </div>
              <Button variant="danger" size="sm" disabled={del.isPending} onClick={() => void remove(r)}>
                <Icon name="overseer.delete" fallback="🗑️" /> Delete
                <span className={styles.srOnly}> the request from {r.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {confirmDialog}
    </Card>
  );
}
