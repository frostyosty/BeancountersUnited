import type { AccountFindings } from "@acct/types/AccountFindings";
import type { AccountProof } from "@acct/types/AccountProof";
import type { Command } from "@acct/types/Command";
import type { Finding } from "@acct/types/Finding";
import type { Via } from "@acct/types/Via";
import { forwardRef, useContext, useState } from "react";
import { Link } from "react-router";
import { CurrentUser, isOwner } from "../../auth";
import { formatDate } from "../../lib/dates";
import { Icon } from "../../lib/icons";
import { formatMoney } from "../../lib/money";
import { keys } from "../../lib/queries";
import { useCommand } from "../../lib/useCommand";
import { Button, Notice } from "../../ui";
import { ErrorMessage } from "../ErrorMessage";
import styles from "./Findings.module.css";
import { afterFix, findingText, fixCommand, lineWords, linesOf, maySend } from "./FindingsText";
import { balanceWords } from "./wording";

export interface FindingsProps {
  proof: AccountProof;
  /** Called after a fix goes through, so the card can check again. */
  onFixed: () => void;
}

/** A finding that explains nothing, such as a gap the server filled: a note, whatever the verdict. */
const isNote = (f: Finding) => f.explains === 0;

/**
 * What might explain a difference (M18, Agent 6): the best explanation first, each finding with a
 * Fix it button that previews the balance afterwards and only sends its command on confirm; the
 * other findings in a list; and, when nothing explains it, where the books and the bank part ways.
 * The server works out every finding; this only words them and sends the fixes they suggest.
 */
export const Findings = forwardRef<HTMLElement, FindingsProps>(function Findings({ proof: p, onFixed }, ref) {
  const x = p.findings;
  const bank = p.proof.bank;
  if (!x || !bank) {
    return null;
  }
  const d = x.diagnosis;
  const notes = d.other_findings.filter(isNote);
  const others = d.other_findings.filter((f) => !isNote(f));
  if (d.difference === 0 && notes.length === 0) {
    return null;
  }
  return (
    <section ref={ref} className={styles.findings} aria-label="What might explain it" tabIndex={-1}>
      {notes.map((f, i) => (
        <Notice key={`note${i}`} tone="info" role="note">
          <FindingWords finding={f} findings={x} />
        </Notice>
      ))}
      {d.difference !== 0 &&
        (d.explained_by.length > 0 ? (
          <Explained proof={p} findings={x} onFixed={onFixed} />
        ) : (
          <Unexplained proof={p} findings={x} />
        ))}
      {others.length > 0 && (
        <details className={styles.others}>
          <summary>
            <Icon name="proof.findings" fallback="🔎" /> Other things we noticed ({others.length})
          </summary>
          <ul className={styles.list}>
            {others.map((f, i) => (
              <li key={i}>
                <FindingWords finding={f} findings={x} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
});

/** The best explanation, biggest first as the server ranked it, with its fixes. */
function Explained({ proof: p, findings: x, onFixed }: { proof: AccountProof; findings: AccountFindings; onFixed: () => void }) {
  const me = useContext(CurrentUser);
  const d = x.diagnosis;
  const all = d.explained_by;
  const send = useFix(p, x);
  const [confirming, setConfirming] = useState<number | "all" | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [failed, setFailed] = useState<Error | null>(null);
  const sendable = (f: Finding) => !!f.fix && !!fixCommand(f.fix) && maySend(f.fix, me);
  const canFixAll = all.length > 1 && all.every(sendable);

  const run = async (fs: Finding[]) => {
    setFailed(null);
    const notes: string[] = [];
    try {
      // One at a time, stopping at the first refusal.
      for (const f of fs) {
        await send(f);
        notes.push(afterFix(f, x) ?? "");
      }
    } catch (e) {
      setFailed(e as Error);
    } finally {
      setDone((ds) => [...ds, ...notes.filter((n) => n !== "")]);
      setConfirming(null);
      if (notes.length > 0) {
        onFixed();
      }
    }
  };

  return (
    <div className={styles.explained}>
      <h3>
        <Icon name="proof.findings" fallback="🔎" /> {all.length === 1 ? "Why they differ" : "Why they differ, as best we can tell"}
      </h3>
      {done.map((n, i) => (
        <Notice key={i} tone="ok" role="status">
          {n}
        </Notice>
      ))}
      <ol className={styles.list}>
        {all.map((f, i) => (
          <li key={i} className={styles.finding}>
            <FindingWords finding={f} findings={x} />
            {f.fix && fixCommand(f.fix) && !maySend(f.fix, me) && <p className="muted">Your accountant can make this change.</p>}
            {f.fix?.kind === "upload_missing" && (
              <p className="muted">
                <Icon name="business.upload" fallback="📤" /> Upload the statement for {formatDate(f.fix.start)} to {formatDate(f.fix.end)} on your
                business page.
              </p>
            )}
            {sendable(f) &&
              (confirming === i ? (
                <Preview proof={p} explains={f.explains} onConfirm={() => void run([f])} onCancel={() => setConfirming(null)} />
              ) : (
                <Button size="sm" onClick={() => setConfirming(i)} disabled={confirming !== null}>
                  <Icon name="proof.fix" fallback="🛠️" /> Fix it
                </Button>
              ))}
          </li>
        ))}
      </ol>
      {d.remainder !== 0 && (
        <p className="muted">
          That leaves ${formatMoney(Math.abs(d.remainder))} we couldn't explain.
        </p>
      )}
      {canFixAll &&
        (confirming === "all" ? (
          <Preview
            proof={p}
            explains={all.reduce((s, f) => s + f.explains, 0)}
            onConfirm={() => void run(all)}
            onCancel={() => setConfirming(null)}
          />
        ) : (
          <Button variant="primary" onClick={() => setConfirming("all")} disabled={confirming !== null}>
            <Icon name="proof.fix" fallback="🛠️" /> Fix all {all.length}
          </Button>
        ))}
      <ErrorMessage error={failed} />
    </div>
  );
}

/** The balance a fix would leave, worked out from what it explains. Nothing is sent until Confirm. */
function Preview({ proof: p, explains, onConfirm, onCancel }: { proof: AccountProof; explains: number; onConfirm: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const bank = p.proof.bank!;
  const ledger = p.proof.ledger - explains;
  const left = bank.compared.difference - explains;
  return (
    <div className={styles.preview} role="group" aria-label="Before you fix it">
      <p>
        Afterwards your books will say <strong>{balanceWords(ledger, p.kind)}</strong> at the end of {formatDate(p.proof.books_date)},{" "}
        {left === 0 ? (
          <>
            the same as your bank <Icon name="proof.agrees" fallback="✅" />
          </>
        ) : (
          <>still out by ${formatMoney(Math.abs(left))}</>
        )}
        .
      </p>
      <div className="row">
        <Button
          variant="primary"
          size="sm"
          busy={busy}
          onClick={() => {
            setBusy(true);
            onConfirm();
          }}
        >
          Confirm
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Nothing explains it: where the books and the bank part ways, and who to ask. */
function Unexplained({ proof: p, findings: x }: { proof: AccountProof; findings: AccountFindings }) {
  const me = useContext(CurrentUser);
  const [copied, setCopied] = useState(false);
  const w = p.proof.window;
  const out = `$${formatMoney(Math.abs(x.diagnosis.difference))}`;
  const from = w.last_agrees ? formatDate(w.last_agrees.checkpoint.date) : null;
  const to = w.first_differs ? formatDate(w.first_differs.checkpoint.date) : formatDate(p.proof.books_date);
  const where = from ? `Between ${from} and ${to}` : `By ${to}`;
  const message = `${where}, my books for ${p.name} and my bank go out by ${out}, and the app couldn't work out why. Could you take a look? It's on the Bank vs books card.`;
  const ask = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={styles.explained}>
      <p>
        We couldn't work out why. {where} your books and your bank go out by {out}.
      </p>
      {me && isOwner(me) && x.has_accountant && (
        <>
          <Button variant="secondary" size="sm" onClick={() => void ask()}>
            <Icon name="proof.ask" fallback="💬" /> Ask your accountant
          </Button>
          {copied ? (
            <p className="muted" role="status">
              Copied a message for them. Paste it into an email or text. They can already see your books.
            </p>
          ) : (
            <p className="muted">Your accountant can see your books, so they can look into it.</p>
          )}
        </>
      )}
      {me && isOwner(me) && !x.has_accountant && (
        <p className="muted">If you invite your accountant from your business page, they can look into it with you.</p>
      )}
    </div>
  );
}

/** A finding's words, with the lines it points at, each linking to its statement. */
function FindingWords({ finding: f, findings: x }: { finding: Finding; findings: AccountFindings }) {
  const t = findingText(f, x);
  const ls = linesOf(f, x);
  return (
    <>
      <p className={styles.headline}>{t.headline}</p>
      {ls.length > 0 && (
        <ul className={styles.lines} aria-label="The lines">
          {ls.map((l) => {
            const file = x.statements.find((s) => s.statement_id === l.statement_id)?.file_name;
            return (
              <li key={l.bank_line_id}>
                <Link to={`/businesses/${x.client_id}#statement-${l.statement_id}`}>{lineWords(l)}</Link>
                {file && <span className="muted">, in {file}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <p className={styles.detail}>{t.detail}</p>
    </>
  );
}

/** Sends a finding's fix, saying it came from a finding (M13's history). */
function useFix(p: AccountProof, x: AccountFindings) {
  const command = useCommand([keys.business(x.client_id), keys.years, ["bank-account", p.bank_account_id]]);
  return (f: Finding) => {
    const c = f.fix ? fixCommand(f.fix) : null;
    if (!c) {
      return Promise.resolve(null);
    }
    const via: Via = { kind: "finding", finding: f.kind };
    return command.mutateAsync({ ...c, via } as Command & { via: Via });
  };
}
