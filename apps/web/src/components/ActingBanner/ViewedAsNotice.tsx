import type { HistoryEntry } from "@acct/types/HistoryEntry";
import { useState } from "react";
import { useCurrentUser } from "../../auth";
import { useHistory } from "../../lib/history";
import { Icon } from "../../lib/icons";
import { useViewAs } from "../../lib/viewAs";
import { Button, Notice } from "../../ui";
import styles from "./ActingBanner.module.css";

const KEY = "viewed-as-notice-dismissed";

function dismissed(): number | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

function remember(seq: number) {
  try {
    window.localStorage.setItem(KEY, String(seq));
  } catch {
    // A courtesy only: Changes stays the record.
  }
}

/** The last time someone viewed as `meId`: the start row, and the end row that followed it, if any. */
export function lastSession(entries: HistoryEntry[], meId: string): { start: HistoryEntry; end: HistoryEntry | null } | null {
  const mine = entries.filter((e) => e.acting_as?.user_id === meId);
  const start = mine
    .filter((e) => e.kind === "start_impersonation")
    .reduce<HistoryEntry | null>((best, e) => (!best || e.seq > best.seq ? e : best), null);
  if (!start) {
    return null;
  }
  const end = mine
    .filter((e) => e.kind === "end_impersonation" && e.seq > start.seq)
    .reduce<HistoryEntry | null>((best, e) => (!best || e.seq < best.seq ? e : best), null);
  return { start, end };
}

/** "Olive started viewing as Sam Staff: the reason" gives "the reason". */
function reasonOf(start: HistoryEntry): string {
  const name = start.acting_as?.name;
  const marker = name ? `${name}: ` : ": ";
  const at = start.description.indexOf(marker);
  return at < 0 ? "" : start.description.slice(at + marker.length).trim();
}

/**
 * Tells a person the next time they open the app that an overseer viewed their account as them
 * (ADR 013, decision 6). Built from their own Changes; dismissing it is remembered in this browser.
 */
export function ViewedAsNotice() {
  const { acting } = useViewAs();
  const me = useCurrentUser();
  const [gone, setGone] = useState(0);
  const skip = acting !== null || me.role === "overseer";
  const history = useHistory({ business: null, user: null, figure: null, limit: 200 });
  if (skip || !history.data) {
    return null;
  }
  const session = lastSession(history.data.entries, me.id);
  if (!session || dismissed() === session.start.seq || gone === session.start.seq) {
    return null;
  }
  const { start, end } = session;
  const date = new Date(start.at).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
  const minutes = end ? Math.max(1, Math.round((Date.parse(end.at) - Date.parse(start.at)) / 60_000)) : null;
  const reason = reasonOf(start);
  return (
    <div className={styles.notice}>
      <Notice tone="info" role="status" icon={<Icon name="acting.notice" fallback="👀" />}>
        {start.who} from support viewed your account as you on {date}
        {minutes !== null && ` for ${minutes} ${minutes === 1 ? "minute" : "minutes"}`}
        {reason && `: ${reason}`}. See Changes.{" "}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            remember(start.seq);
            setGone(start.seq);
          }}
        >
          Dismiss
        </Button>
      </Notice>
    </div>
  );
}
