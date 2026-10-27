import type { HistoryEntry } from "@acct/types/HistoryEntry";
import { useEffect, useState } from "react";
import { matchPath, useLocation } from "react-router";
import { type HistoryFilters, useHistory, useHistoryContext, usePresence } from "../lib/history";
import { Icon } from "../lib/icons";
import { formatMoney } from "../lib/money";
import { useYear } from "../lib/queries";
import { ErrorMessage } from "./ErrorMessage";
import styles from "./HistoryPanel.module.css";

const COLLAPSED_KEY = "history-panel-collapsed";
const PAGE = 50;

function readCollapsed(): boolean {
  try {
    // Hidden until someone opens it.
    return window.localStorage.getItem(COLLAPSED_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // A per-browser convenience only.
  }
}

/** The business the page is showing, if any: from the URL, or a year's client. */
function useCurrentBusiness(): string | null {
  const { pathname } = useLocation();
  const direct =
    matchPath("/businesses/:id/*", pathname)?.params.id ?? matchPath("/clients/:id/*", pathname)?.params.id;
  const yearId = matchPath("/years/:id/*", pathname)?.params.id;
  const year = useYear(yearId ?? "");
  if (direct && direct !== "new") {
    return direct;
  }
  return yearId ? (year.data?.client_id ?? null) : null;
}

const when = new Intl.DateTimeFormat("en-NZ", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Who changed what (PLAN.md M13), on the left of every page: who's signed in now, and a live feed
 * of changes in plain English, each with its before and after values and its effect on the tax.
 * It's all read from the command log; live refresh keeps it current.
 */
export function HistoryPanel() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    writeCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };
  const business = useCurrentBusiness();
  const presence = usePresence(business);

  if (collapsed) {
    return (
      <aside className={`${styles.panel} ${styles.collapsed}`} aria-label="Who changed what">
        <button type="button" onClick={toggle} aria-expanded={false}>
          <Icon name="history.changes" fallback="🕘" /> Show changes
        </button>
      </aside>
    );
  }
  return (
    <aside className={styles.panel} aria-label="Who changed what">
      <div className={styles.top}>
        <h2 id="here-heading">
          <Icon name="history.here" fallback="👥" /> Here now
        </h2>
        <button type="button" className={styles.hide} onClick={toggle} aria-expanded={true}>
          Hide
        </button>
      </div>
      {presence.data && presence.data.length > 0 && (
        <ul className={styles.here} aria-labelledby="here-heading">
          {presence.data.map((p) => (
            <li key={p.user_id}>
              <span className={styles.dot} aria-hidden="true" />
              {p.display_name}
              {p.is_you && <span className="muted"> (you)</span>}
              {p.business_name && <span className="muted"> · on {p.business_name}</span>}
            </li>
          ))}
        </ul>
      )}
      <Changes business={business} people={(presence.data ?? []).map((p) => [p.user_id, p.display_name])} />
    </aside>
  );
}

function Changes({ business, people }: { business: string | null; people: [string, string][] }) {
  const { figure, clearFigure } = useHistoryContext();
  const { pathname } = useLocation();
  const [user, setUser] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [staffOnly, setStaffOnly] = useState(false);
  const [manual, setManual] = useState(false);
  const [ledger, setLedger] = useState(false);
  const [allBusinesses, setAllBusinesses] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  // A figure belongs to the page it was clicked on.
  useEffect(() => clearFigure(), [pathname]);

  const filters: HistoryFilters = {
    business: figure?.figure ? business : allBusinesses ? null : business,
    user,
    staffOnly,
    manual,
    ledger,
    figure,
    limit,
  };
  const active = [user, staffOnly, manual, ledger, allBusinesses].filter(Boolean).length;
  const history = useHistory(filters);
  const entries = history.data?.entries ?? [];

  // Everyone the filter can pick: who's here, and who's in the feed.
  const names = new Map<string, string>(people);
  for (const e of entries) {
    if (e.user_id) names.set(e.user_id, e.who);
  }

  return (
    <section aria-labelledby="changes-heading" className={styles.changes}>
      <h2 id="changes-heading">
        <Icon name="history.changes" fallback="🕘" /> Changes
        <button
          type="button"
          className={styles.filterToggle}
          aria-expanded={open}
          aria-controls="changes-filters"
          aria-label="Filter changes"
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
          {active > 0 && <span className={styles.badge}>{active}</span>}
        </button>
      </h2>
      {figure && (
        <p className={styles.figure} role="status">
          <Icon name="history.figure" fallback="🔎" /> What changed {figure.label}{" "}
          <button type="button" onClick={clearFigure}>
            Show all changes
          </button>
        </p>
      )}
      {open && (
        <div className={styles.filters} id="changes-filters">
          <label>
            Person
            <select value={user ?? ""} onChange={(e) => setUser(e.target.value || null)}>
              <option value="">Everyone</option>
              {[...names].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={staffOnly} onChange={(e) => setStaffOnly(e.target.checked)} />
            Staff only
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
            Manual entries
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={ledger} onChange={(e) => setLedger(e.target.checked)} />
            Ledger
          </label>
          {business && !figure?.figure && (
            <label className={styles.check}>
              <input type="checkbox" checked={allBusinesses} onChange={(e) => setAllBusinesses(e.target.checked)} />
              Every business
            </label>
          )}
        </div>
      )}
      <ErrorMessage error={history.error} />
      {history.data && entries.length === 0 && (
        <p className="muted">
          <Icon name="history.empty" fallback="🌱" /> No changes {figure || active > 0 ? "match" : "yet"}.
        </p>
      )}
      {entries.length > 0 && (
        <ol className={styles.feed} aria-label="Changes, newest first">
          {entries.map((e) => (
            <ChangeItem key={e.seq} entry={e} showBusiness={!filters.business} />
          ))}
        </ol>
      )}
      {history.data?.next_before != null && entries.length >= limit && (
        <button type="button" onClick={() => setLimit(limit + PAGE)}>
          Show older changes
        </button>
      )}
    </section>
  );
}

function ChangeItem({ entry: e, showBusiness }: { entry: HistoryEntry; showBusiness: boolean }) {
  const fields = e.changes?.fields ?? [];
  const tax = e.tax_change ?? 0;
  return (
    <li className={styles.item}>
      <p className={styles.description}>{e.description}</p>
      <p className={styles.meta}>
        <time dateTime={e.at}>{when.format(new Date(e.at))}</time>
        {showBusiness && e.business_name && <> · {e.business_name}</>}
      </p>
      {e.ai && (
        <p className={styles.ai}>
          <Icon name="history.ai" fallback="🤖" /> AI suggestion ({e.ai.model}), accepted by {e.who}
        </p>
      )}
      {tax !== 0 && (
        <p className={tax > 0 ? styles.up : styles.down}>
          <Icon name={tax > 0 ? "history.up" : "history.down"} fallback={tax > 0 ? "📈" : "📉"} /> Tax to pay{" "}
          {tax > 0 ? "up" : "down"} ${formatMoney(Math.abs(tax))}
        </p>
      )}
      {fields.length > 0 && (
        <details className={styles.fields}>
          <summary>Before and after ({fields.length})</summary>
          <ul>
            {fields.map((f, i) => (
              <li key={i}>
                <span className={styles.subject}>{f.subject}</span>, {f.label}: {f.before ?? "nothing"} →{" "}
                {f.after ?? "removed"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
