import type { BankAccountView } from "@acct/types/BankAccountView";
import type { DetectedLine } from "@acct/types/DetectedLine";
import type { TaxPosition } from "@acct/types/TaxPosition";
import { type ChangeEvent, type DragEvent, type FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { can, isOwner, useCurrentUser } from "../auth";
import { ChangesButton } from "../components/ChangesButton";
import { ErrorMessage } from "../components/ErrorMessage";
import { formatDate } from "../lib/dates";
import { fileToBase64 } from "../lib/files";
import { newToken } from "../lib/id";
import { Icon } from "../lib/icons";
import { formatMoney, parseMoney } from "../lib/money";
import { keys, useBusiness, useTax } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import { Field, PageHeader } from "../ui";
import styles from "./BusinessPage.module.css";

/**
 * The owner's screen (PLAN.md M10): upload bank statements, see the tax to pay if submitted, and
 * submit to IRD. Save tax (M11) opens its own screen; Submit arrives in M14, so it shows but is switched off.
 */
export function BusinessPage({ clientId: given }: { clientId?: string }) {
  const params = useParams();
  const clientId = given ?? params.clientId ?? "";
  const me = useCurrentUser();
  const business = useBusiness(clientId);
  const tax = useTax(clientId);

  if (business.error) {
    return <ErrorMessage error={business.error} />;
  }
  if (!business.data) {
    return <p className="muted">Loading…</p>;
  }
  const b = business.data;
  const canEdit = can(me, "staff");
  return (
    <>
      <PageHeader
        crumbs={
          isOwner(me)
            ? undefined
            : [
                { to: "/", label: "Clients" },
                { to: `/clients/${clientId}`, label: "Accountant view" },
              ]
        }
        icon={<Icon name="business.home" fallback="🏪" />}
        title={b.name}
        subtitle={isOwner(me) ? "Overview" : undefined}
      />

      <div className={styles.areas}>
        <section className={styles.area} aria-labelledby="upload-heading">
          <h2 id="upload-heading">
            <Icon name="business.upload" fallback="📤" /> Upload bank statements
          </h2>
          {canEdit ? <Upload clientId={clientId} /> : <p className="muted">Viewers can't upload.</p>}
        </section>

        <section className={styles.area} aria-labelledby="tax-heading">
          <h2 id="tax-heading">
            <Icon name="business.tax" fallback="💰" /> Tax to pay if submitted
          </h2>
          <ErrorMessage error={tax.error} />
          {tax.data ? <TaxFigure tax={tax.data} clientId={clientId} /> : !tax.error && <p className="muted">Working it out…</p>}
        </section>

        <section className={styles.area} aria-labelledby="submit-heading">
          <h2 id="submit-heading">
            <Icon name="business.submit" fallback="📨" /> Submit to IRD
          </h2>
          <p className={styles.blurb}>Filing with IRD is coming. Until then, this shows what you'd file.</p>
          <button type="button" disabled>
            Submit
          </button>
        </section>
      </div>

      <h2>
        <Icon name="business.bank" fallback="🏦" /> Bank accounts
      </h2>
      {b.bank_accounts.length === 0 ? (
        <p className="muted">No statements yet. Upload one and its account is added for you.</p>
      ) : (
        b.bank_accounts.map((a) => <BankAccount key={a.id} account={a} clientId={clientId} canEdit={canEdit} />)
      )}

      <Detected transfers={b.transfers} ird={b.ird_payments} duplicates={b.possible_duplicates} />

      {isOwner(me) && <InviteAccountant clientId={clientId} />}
    </>
  );
}

/**
 * The owner invites their accountant (M12). Email isn't sent yet, so the owner copies the link to
 * them. The link's token is made here; the server keeps only its hash, and it works once, for 14 days.
 */
function InviteAccountant({ clientId }: { clientId: string }) {
  const invite = useCommand();
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const token = newToken();
    invite.mutate(
      { kind: "create_invite", payload: { client_id: clientId, email: email.trim(), token } },
      { onSuccess: () => setLink(`${window.location.origin}/invite/${token}`) },
    );
  };

  return (
    <section aria-labelledby="invite-heading">
      <h2 id="invite-heading">
        <Icon name="business.invite" fallback="🤝" /> Invite your accountant
      </h2>
      <p className="muted">They'll be able to see and work on this business. Nobody else can.</p>
      <form onSubmit={submit} className="form narrow">
        <Field label="Their email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <button type="submit" disabled={email.trim() === "" || invite.isPending}>
          Make an invite link
        </button>
        <ErrorMessage error={invite.error} />
      </form>
      {link && (
        <div role="status" className="form narrow">
          <p>We don't email it yet, so send them this link yourself. It works once, for 14 days:</p>
          <input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
        </div>
      )}
    </section>
  );
}

type UploadResult = { name: string; ok: true } | { name: string; ok: false; error: Error };

function Upload({ clientId }: { clientId: string }) {
  const upload = useCommand([keys.business(clientId)]);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const onPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void readFiles(files);
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    if (!busy) {
      void readFiles(Array.from(e.dataTransfer.files));
    }
  };

  const readFiles = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setBusy(true);
    const done: UploadResult[] = [];
    // One at a time, so each file sees the accounts and lines the one before it added.
    for (const file of files) {
      try {
        await upload.mutateAsync({
          kind: "import_statement",
          payload: { client_id: clientId, file_name: file.name, content_base64: await fileToBase64(file) },
        });
        done.push({ name: file.name, ok: true });
      } catch (error) {
        done.push({ name: file.name, ok: false, error: error as Error });
      }
    }
    setResults(done);
    setBusy(false);
  };

  return (
    <>
      <label
        className={`${styles.drop} ${over ? styles.over : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          multiple
          accept=".ofx,.qfx,.qif,.csv,.txt"
          onChange={onPicked}
          disabled={busy}
          className={styles.fileInput}
          aria-label="Choose statement files: OFX, QIF or CSV"
        />
        <span className={styles.dropButton} aria-hidden="true">
          <Icon name="business.upload" fallback="📤" /> Choose files
        </span>
        <span className="muted">or drop them here. OFX, QIF or CSV.</span>
      </label>
      {busy && <p className="muted">Reading your statements…</p>}
      {results.length > 0 && (
        <ul className={styles.results}>
          {results.map((r, i) =>
            r.ok ? (
              <li key={i}>
                <Icon name="business.ok" fallback="✅" /> {r.name}: read. Lines already uploaded were skipped.
              </li>
            ) : (
              <li key={i}>
                {r.name}: <ErrorMessage error={r.error} />
              </li>
            ),
          )}
        </ul>
      )}
    </>
  );
}

function TaxFigure({ tax, clientId }: { tax: TaxPosition; clientId: string }) {
  const navigate = useNavigate();
  return (
    <>
      <p className={styles.figure}>
        ${formatMoney(tax.total)}
        <ChangesButton figure={{ label: "tax to pay", figure: "tax" }} />
      </p>
      <p className={styles.blurb}>
        The most you could owe. Anything not sorted yet is counted the safe way: money in as income, and spending as claiming nothing.
        Save tax to bring it down.
      </p>
      <button type="button" className="primary" onClick={() => void navigate(`/businesses/${clientId}/save-tax`)}>
        <Icon name="business.save" fallback="✂️" /> Save tax
      </button>
      {tax.notices.map((n) => (
        <p key={n.code + n.message} className={styles.notice} role="status">
          <Icon name="business.notice" fallback="ℹ️" /> {n.message}
        </p>
      ))}
      {(tax.gst.length > 0 || tax.income.length > 0) && (
        <details className={styles.breakdown}>
          <summary>What it's made of</summary>
          <table className="table">
            <tbody>
              {tax.gst.map((g) => (
                <tr key={g.start}>
                  <td>
                    GST, {formatDate(g.start)} to {formatDate(g.end)}
                    {g.so_far && " (so far)"}
                    <br />
                    <span className="muted">{whenCanFile(g.can_file_from, g.so_far)}</span>
                  </td>
                  <td className="num">
                    {g.boxes ? formatMoney(g.boxes.box15) : g.problem}
                    <ChangesButton
                      figure={{ label: `GST for ${formatDate(g.start)} to ${formatDate(g.end)}`, figure: `gst:${g.start}` }}
                    />
                  </td>
                </tr>
              ))}
              {tax.income.map((y) => (
                <tr key={y.income_year}>
                  <td>
                    Income tax, year to 31 Mar {y.income_year}
                    {y.so_far && " (so far)"}
                    <br />
                    <span className="muted">
                      On ${formatMoney(y.taxable_income)} of income
                      {y.basis === "top_rate_flat" ? ", at 39% until you tell us about your other income" : ""}.{" "}
                      {whenCanFile(y.can_file_from, y.so_far)}
                    </span>
                  </td>
                  <td className="num">
                    {y.income_tax !== null ? formatMoney(y.income_tax) : y.problem}
                    <ChangesButton
                      figure={{ label: `income tax for the year to 31 Mar ${y.income_year}`, figure: `income:${y.income_year}` }}
                    />
                  </td>
                </tr>
              ))}
              {tax.income
                .filter((y) => y.student_loan !== null && y.student_loan !== 0)
                .map((y) => (
                  <tr key={`sl-${y.income_year}`}>
                    <td>
                      Student loan, year to 31 Mar {y.income_year}
                      <br />
                      <span className="muted">
                        {y.student_loan_basis === "all_income"
                          ? "12% of all of it until you tell us whether you have one."
                          : "12% of your income over the repayment threshold."}
                      </span>
                    </td>
                    <td className="num">{formatMoney(y.student_loan ?? 0)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

function whenCanFile(from: string, soFar: boolean): string {
  return soFar ? `Can file after ${formatDate(from)}.` : "Can file now.";
}

function BankAccount({ account: a, clientId, canEdit }: { account: BankAccountView; clientId: string; canEdit: boolean }) {
  const rec = a.reconciliation;
  return (
    <section className={styles.account}>
      <h3>
        {a.name} <span className="muted">{a.account_number ?? ""}</span>
      </h3>
      <ul>
        {a.statements.map((s, i) => (
          <li key={i}>
            {s.file_name}: {formatDate(s.start)} to {formatDate(s.end)}, {s.lines_added} of {s.lines_in_file} lines new
          </li>
        ))}
      </ul>
      {a.gaps.map((g) => (
        <p key={g.start} className={styles.notice}>
          <Icon name="business.gap" fallback="⚠️" /> No statement from {formatDate(g.start)} to {formatDate(g.end)}.{" "}
          {g.change === null
            ? "We can't tell what happened then, so the figure leaves it out. Upload a statement that covers it."
            : g.change > 0
              ? `The balance rose by $${formatMoney(g.change)}, which counts as income until you upload that statement.`
              : `The balance fell by $${formatMoney(-g.change)}.`}
        </p>
      ))}
      {rec && (
        <p>
          {rec.agrees === null ? (
            <>
              Balance on {formatDate(rec.date)}: ${formatMoney(rec.ledger)}. The statement gives no closing balance to
              check it against.
            </>
          ) : rec.agrees ? (
            <>
              <Icon name="business.ok" fallback="✅" /> Matches the statement: ${formatMoney(rec.ledger)} on{" "}
              {formatDate(rec.date)}.
            </>
          ) : (
            <span className="error">
              Doesn't match: the statement says ${formatMoney(rec.statement ?? 0)} on {formatDate(rec.date)}, but we
              have ${formatMoney(rec.ledger)}.
            </span>
          )}
        </p>
      )}
      {a.needs_opening_balance && canEdit && <OpeningBalanceForm account={a} clientId={clientId} />}
    </section>
  );
}

function OpeningBalanceForm({ account, clientId }: { account: BankAccountView; clientId: string }) {
  const set = useCommand([keys.business(clientId)]);
  const [text, setText] = useState("");
  const cents = parseMoney(text);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cents === null) {
      return;
    }
    set.mutate({ kind: "set_opening_balance", payload: { bank_account_id: account.id, balance: cents } });
  };
  return (
    <form onSubmit={submit} className="form narrow">
      <p>This account's first statement starts late. What was its balance when the business started?</p>
      <div className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" aria-label="Opening balance" />
        <button type="submit" disabled={cents === null || set.isPending}>
          Save balance
        </button>
      </div>
      <ErrorMessage error={set.error} />
    </form>
  );
}

function Detected({ transfers, ird, duplicates }: { transfers: [DetectedLine, DetectedLine][]; ird: DetectedLine[]; duplicates: DetectedLine[] }) {
  if (transfers.length + ird.length + duplicates.length === 0) {
    return null;
  }
  const line = (l: DetectedLine) => `${formatDate(l.date)} ${l.description} $${formatMoney(l.amount)}`;
  return (
    <>
      <h2>
        <Icon name="business.detected" fallback="🔎" /> We spotted these
      </h2>
      <p className="muted">They're counted the safe way for now. Save tax will ask you about each one.</p>
      <ul>
        {transfers.map(([out, inn], i) => (
          <li key={`t${i}`}>Maybe a transfer between your own accounts: {line(out)} and {line(inn)}</li>
        ))}
        {ird.map((l, i) => (
          <li key={`i${i}`}>Maybe a payment to or from IRD: {line(l)}</li>
        ))}
        {duplicates.map((l, i) => (
          <li key={`d${i}`}>Maybe a duplicate: {line(l)}</li>
        ))}
      </ul>
    </>
  );
}
