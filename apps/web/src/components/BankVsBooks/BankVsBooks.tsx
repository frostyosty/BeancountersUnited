import type { AccountProof } from "@acct/types/AccountProof";
import type { Checkpoint } from "@acct/types/Checkpoint";
import type { StatementExcerpt } from "@acct/types/StatementExcerpt";
import { useQuery } from "@tanstack/react-query";
import { useContext, useId, useRef, useState } from "react";
import { CurrentUser } from "../../auth";
import { getJson } from "../../lib/api";
import { formatDate, todayIso } from "../../lib/dates";
import { Icon } from "../../lib/icons";
import { lineDescription } from "../../lib/lines";
import { formatMoney } from "../../lib/money";
import { Button, Modal, cx } from "../../ui";
import { ErrorMessage } from "../ErrorMessage";
import styles from "./BankVsBooks.module.css";
import { Findings } from "./Findings";
import { balanceWords, verdictWords } from "./wording";

export interface BankVsBooksProps {
  open: boolean;
  onClose: () => void;
  /**
   * One account's proofs, as the server works them out: at the end of a statement, and at 31 March
   * when the statement runs past it. With more than one, the modal lets you switch between them.
   */
  proofs: AccountProof[];
}

/**
 * Bank vs books (M18): the balance the bank's own file gives, beside the books' balance on the same
 * day, with whether they agree, and below it what might explain a difference, with fixes (Agent 6).
 * It only shows what the server worked out, and prints as one A4 page (the card, not the findings).
 */
export function BankVsBooks({ open, onClose, proofs }: BankVsBooksProps) {
  const [chosen, setChosen] = useState(0);
  const [printedAt, setPrintedAt] = useState(() => new Date());
  // After a fix, the card as the server works it out again, by which proof it replaces.
  const [fresh, setFresh] = useState<Record<number, AccountProof>>({});
  const findingsRef = useRef<HTMLElement>(null);
  const me = useContext(CurrentUser);
  const id = useId();
  const index = Math.min(chosen, proofs.length - 1);
  const p = fresh[index] ?? proofs[index];
  if (!p) {
    return null;
  }
  const recheck = async () => {
    const path = `/api/bank-accounts/${encodeURIComponent(p.bank_account_id)}/proof?date=${p.proof.date}`;
    try {
      const again = await getJson<AccountProof>(path);
      setFresh((f) => ({ ...f, [index]: again }));
    } catch {
      // The card stays as it was; reopening it checks again.
    }
  };
  const explains = !!p.findings && p.findings.diagnosis.difference !== 0;
  const bank = p.proof.bank;
  const difference = bank?.compared.difference ?? null;
  const print = () => {
    setPrintedAt(new Date());
    // After the new time has rendered.
    window.setTimeout(() => window.print(), 0);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      icon={<Icon name="proof.open" fallback="⚖️" />}
      title="Bank vs books"
      footer={
        <Button variant="secondary" onClick={print}>
          <Icon name="proof.print" fallback="🖨️" /> Print
        </Button>
      }
    >
      <div className={styles.sheet}>
        <header className={styles.printHead}>
          <p className={styles.business}>{p.business_name}</p>
          <p>
            {p.code} {p.name}
            {p.account_number && <span className="muted"> {p.account_number}</span>}
          </p>
          <p>Bank vs books at the end of {formatDate(p.proof.date)}</p>
          <p className={cx(styles.printOnly, "muted")}>
            Printed {printedAtText(printedAt)}
            {me && ` by ${me.display_name}`}
          </p>
        </header>

        {proofs.length > 1 && (
          <div className={styles.dates} role="group" aria-label="Which date">
            {proofs.map((q, i) => (
              <Button
                key={q.proof.date}
                size="sm"
                variant={q === p ? "primary" : "secondary"}
                aria-pressed={q === p}
                onClick={() => setChosen(i)}
              >
                {formatDate(q.proof.date)}
              </Button>
            ))}
          </div>
        )}

        {bank && p.proof.at === "nearest" && (
          <p className={styles.nearest}>
            Nearest balance your bank gave: {formatDate(endOf(bank.checkpoint))}. Its files give none for{" "}
            {formatDate(p.proof.date)} itself.
          </p>
        )}

        <div className={styles.compare}>
          <section className={styles.cutout} aria-labelledby={`${id}-bank`}>
            <h3 id={`${id}-bank`}>
              <Icon name="proof.bank" fallback="🏛" /> Your bank's file says
            </h3>
            {bank ? (
              <BankSide proof={p} checkpoint={bank.checkpoint} />
            ) : (
              <p className="muted">Your bank's files give no balance on or before {formatDate(p.proof.date)}.</p>
            )}
          </section>

          <div className={cx(styles.verdict, difference === null ? styles.unknown : difference === 0 ? styles.agrees : styles.out)} role="status">
            {difference === null ? (
              <span>Can't check: no balance from the bank</span>
            ) : (
              <>
                <span className={styles.verdictText}>
                  {difference === 0 ? <Icon name="proof.agrees" fallback="✅" /> : <Icon name="proof.out" fallback="⚠️" />}{" "}
                  {verdictWords(difference)}
                </span>
                {difference !== 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.findings}
                    disabled={!explains}
                    onClick={() => {
                      findingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                      findingsRef.current?.focus();
                    }}
                  >
                    <Icon name="proof.findings" fallback="🔎" /> See what might explain it
                  </Button>
                )}
              </>
            )}
          </div>

          <section className={styles.cutout} aria-labelledby={`${id}-books`}>
            <h3 id={`${id}-books`}>
              <Icon name="ui.empty" fallback="🏭" /> Your books say
            </h3>
            <p className={styles.figure}>{balanceWords(p.proof.ledger, p.kind)}</p>
            <p className="muted">At the end of {formatDate(p.proof.books_date)}</p>
            {p.proof.recent.length > 0 ? (
              <table className={cx("table", styles.recent)} aria-label="The last lines in your books">
                <tbody>
                  {p.proof.recent.map((l) => (
                    <tr key={l.journal_id}>
                      <td className={styles.when}>{formatDate(l.date)}</td>
                      <td>{lineDescription(l.narration)}</td>
                      <td className="num">{formatMoney(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">Nothing in the books on this account yet.</p>
            )}
          </section>
        </div>
      </div>
      <Findings ref={findingsRef} proof={p} onFixed={() => void recheck()} />
    </Modal>
  );
}

/** The left cutout: the bank's own words around the balance, or what we stored if the file wasn't kept. */
function BankSide({ proof: p, checkpoint: c }: { proof: AccountProof; checkpoint: Checkpoint }) {
  const balance = c.source.balance;
  const query = balance.kind === "running" ? `line=${encodeURIComponent(balance.bank_line_id)}` : `kind=${balance.kind}`;
  const excerpt = useQuery({
    queryKey: ["statement", c.source.statement_id, "excerpt", query],
    queryFn: () => getJson<StatementExcerpt>(`/api/statements/${encodeURIComponent(c.source.statement_id)}/excerpt?${query}`),
  });
  const e = excerpt.data;
  return (
    <>
      {excerpt.error ? (
        <ErrorMessage error={excerpt.error} />
      ) : !e ? (
        <p className="muted">Opening the file…</p>
      ) : !e.kept ? (
        <p className={styles.noFile}>
          <Icon name="proof.no_file" fallback="📭" /> Original file not kept. It was uploaded before we kept a copy, so
          this is the figure we stored.
        </p>
      ) : e.lines.length === 0 ? (
        <p className="muted">The file doesn't state this balance, so it's worked out from the file's lines.</p>
      ) : (
        <pre className={styles.excerpt} aria-label={`Lines from ${e.file_name}`}>
          {e.lines.map((l) => (
            <span key={l.number} className={styles.excerptLine}>
              <span className={styles.lineNo} aria-hidden="true">
                {l.number}
              </span>
              <Highlighted text={l.text} range={e.highlight && e.highlight.line === l.number ? e.highlight : null} />
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      <p className={styles.figure}>{balanceWords(c.stated, p.kind)}</p>
      <p className="muted">
        At the {c.source.balance.kind === "opening" ? "start" : "end"} of {formatDate(c.date)}
      </p>
      <p className={cx("muted", styles.file)}>
        {p.statement_file ?? e?.file_name}
        {e?.sha256 && (
          <>
            {" "}
            <span title="The start of the file's SHA-256 fingerprint">SHA-256 {e.sha256.slice(0, 12)}</span>
          </>
        )}
      </p>
    </>
  );
}

/** A line of the file with the balance marked. `start` and `end` count UTF-16 units, as JS strings do. */
function Highlighted({ text, range }: { text: string; range: { start: number; end: number } | null }) {
  if (!range) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, range.start)}
      <mark className={styles.mark}>{text.slice(range.start, range.end)}</mark>
      {text.slice(range.end)}
    </>
  );
}

/** The day a balance is the end of: an opening balance is the end of the day before. */
function endOf(c: Checkpoint): string {
  if (c.source.balance.kind !== "opening") {
    return c.date;
  }
  const d = new Date(`${c.date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function printedAtText(at: Date): string {
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${formatDate(todayIso(at))} at ${hh}:${mm}`;
}

export interface BankVsBooksForAccountProps {
  open: boolean;
  onClose: () => void;
  bankAccountId: string;
  /** The day to check; without it, the end of the account's latest statement. */
  date?: string | null;
}

/** Bank vs books for one account, loaded when it opens: from a bank account or the Reconcile tab. */
export function BankVsBooksForAccount({ open, onClose, bankAccountId, date }: BankVsBooksForAccountProps) {
  const path = `/api/bank-accounts/${encodeURIComponent(bankAccountId)}/proof${date ? `?date=${date}` : ""}`;
  const proof = useQuery({
    queryKey: ["bank-account", bankAccountId, "proof", date ?? null],
    queryFn: () => getJson<AccountProof>(path),
    enabled: open,
  });
  if (!open) {
    return null;
  }
  if (!proof.data) {
    return (
      <Modal open onClose={onClose} title="Bank vs books" icon={<Icon name="proof.open" fallback="⚖️" />}>
        {proof.error ? <ErrorMessage error={proof.error} /> : <p className="muted">Checking…</p>}
      </Modal>
    );
  }
  return <BankVsBooks open onClose={onClose} proofs={[proof.data]} />;
}
