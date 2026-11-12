import { useMemo, useRef, useState } from "react";
import { SiteHeader } from "../components/SiteHeader";
import { formatDate } from "../lib/dates";
import { Emoji, Icon } from "../lib/icons";
import { formatMoney, sumCents } from "../lib/money";
import { buildOfx, type OfxAccountType, ofxFileName } from "../lib/pdfToOfx/ofx";
import { looksLikePdf, PdfReadError, pdfTextRuns } from "../lib/pdfToOfx/pdfText";
import { type ReadLine, type ReadStatement, readStatement } from "../lib/pdfToOfx/read";
import type { TextRun } from "../lib/pdfToOfx/layout";
import { Button, Card, Field, Notice, PageHeader } from "../ui";
import styles from "./PdfToOfxPage.module.css";

const SUBTITLE =
  "Drop in a bank or credit card statement saved as a PDF, check what we read, and download it as an OFX file for " +
  "your accounting software. Your PDF is read on this device and never uploaded.";

/** Bigger than any statement; a file this size is something else. */
const MAX_BYTES = 30 * 1024 * 1024;

/** PDF to OFX under Settings → Tools, for anyone signed in. */
export function PdfToOfxPage() {
  return (
    <>
      <PageHeader
        crumbs={[{ to: "/settings/tools", label: "Tools" }]}
        icon={<Icon name="tools.pdfToOfx" fallback="🔄" />}
        title="PDF to OFX"
        subtitle={SUBTITLE}
      />
      <Converter />
    </>
  );
}

/** The same converter for anyone not signed in: it needs no account, and keeps nothing. */
export function PublicPdfToOfxPage() {
  return (
    <>
      <SiteHeader />
      <main className="page">
        <PageHeader icon={<Icon name="tools.pdfToOfx" fallback="🔄" />} title="PDF to OFX" subtitle={SUBTITLE} />
        <Converter />
      </main>
    </>
  );
}

type Stage =
  | { kind: "idle" }
  | { kind: "reading"; name: string }
  | { kind: "failed"; name: string; message: string }
  | { kind: "read"; name: string; runs: TextRun[] };

const ACCOUNT_TYPES: { value: OfxAccountType; label: string }[] = [
  { value: "cheque", label: "Everyday (cheque) account" },
  { value: "savings", label: "Savings account" },
  { value: "card", label: "Credit card" },
];

/** Turns a sign round without making a negative zero. */
const negate = (cents: number) => (cents === 0 ? 0 : -cents);

function failure(e: unknown): string {
  if (e instanceof PdfReadError) return e.message;
  return `We couldn't read this PDF: ${e instanceof Error ? e.message : String(e)}`;
}

/** Hands the browser a file to save. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-ofx" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Converter() {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [account, setAccount] = useState("");
  const [accountType, setAccountType] = useState<OfxAccountType>("cheque");
  const [swapped, setSwapped] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  // Only the last file dropped in gets shown, however long an earlier one takes to read.
  const latest = useRef(0);

  const open = async (file: File) => {
    const token = ++latest.current;
    setSaved(null);
    if (file.size > MAX_BYTES) {
      setStage({
        kind: "failed",
        name: file.name,
        message: "This file is too big to be a statement. Drop in the PDF you downloaded from your internet banking.",
      });
      return;
    }
    setStage({ kind: "reading", name: file.name });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!looksLikePdf(bytes)) {
        throw new PdfReadError(
          /\.(ofx|qfx|qif|csv)$/i.test(file.name)
            ? "This is already a bank file, not a PDF: you can use it as it is."
            : "This isn't a PDF. Drop in the statement PDF from your internet banking.",
          "invalid",
        );
      }
      const runs = await pdfTextRuns(bytes);
      if (token !== latest.current) return;
      const fallbackYear = new Date().getFullYear();
      const first = readStatement(runs, { fallbackYear });
      if (first.lines.length === 0) {
        // Nothing to check or download: say why, and keep the drop zone up for the next try.
        setStage({ kind: "failed", name: file.name, message: first.notes.map((n) => n.text).join(" ") });
        return;
      }
      setYear(fallbackYear);
      setAccount(first.account ?? "");
      setAccountType(first.kind === "card" ? "card" : first.savings ? "savings" : "cheque");
      setSwapped(false);
      setStage({ kind: "read", name: file.name, runs });
    } catch (e) {
      if (token === latest.current) setStage({ kind: "failed", name: file.name, message: failure(e) });
    }
  };

  const reset = () => {
    latest.current++;
    setStage({ kind: "idle" });
    setSaved(null);
  };

  return (
    <div className={styles.converter}>
      {stage.kind !== "read" && <Drop busy={stage.kind === "reading"} onFile={(f) => void open(f)} />}
      {stage.kind === "reading" && (
        <p className="muted" role="status">
          <Emoji>⏳</Emoji> Reading {stage.name}…
        </p>
      )}
      {stage.kind === "failed" && (
        <Notice tone="warn" role="alert">
          <strong>{stage.name}</strong>: {stage.message}
        </Notice>
      )}
      {stage.kind === "read" && (
        <Result
          name={stage.name}
          runs={stage.runs}
          year={year}
          onYear={setYear}
          account={account}
          onAccount={setAccount}
          accountType={accountType}
          onAccountType={setAccountType}
          swapped={swapped}
          onSwap={() => setSwapped((s) => !s)}
          saved={saved}
          onSaved={setSaved}
          onReset={reset}
        />
      )}
      <p className={styles.promise}>
        <Emoji>🔒</Emoji> Your PDF never leaves this device, and no AI reads it: fixed rules do, so the same PDF always
        gives the same file.
      </p>
    </div>
  );
}

function Drop({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  return (
    <div
      className={`${styles.drop} ${over ? styles.dropOver : ""}`}
      data-testid="pdf-drop"
      onDragEnter={(e) => {
        if (hasFiles(e)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
    >
      <span className={styles.dropIcon}>
        <Icon name="tools.pdfToOfx" fallback="🔄" />
      </span>
      <p className={styles.dropText}>{over ? "Drop it here" : "Drag a statement PDF here"}</p>
      <Button size="sm" busy={busy} onClick={() => input.current?.click()}>
        <Emoji>📂</Emoji> Choose a PDF
      </Button>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className={styles.hiddenInput}
        aria-label="Statement PDF"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
      <span className={styles.dropHint}>
        The PDF from your internet banking works best. A scan or a photo of a statement has no text to read.
      </span>
    </div>
  );
}

/** The year for dates printed without one. What's typed is kept as typed; the dates change once it's a whole year. */
function YearField({ year, onYear }: { year: number; onYear: (year: number) => void }) {
  const [text, setText] = useState(String(year));
  return (
    <Field label="Year of the dates">
      <input
        inputMode="numeric"
        maxLength={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const y = Number(e.target.value);
          if (/^\d{4}$/.test(e.target.value) && y >= 1990 && y <= 2100) onYear(y);
        }}
      />
    </Field>
  );
}

interface ResultProps {
  name: string;
  runs: TextRun[];
  year: number;
  onYear: (year: number) => void;
  account: string;
  onAccount: (account: string) => void;
  accountType: OfxAccountType;
  onAccountType: (type: OfxAccountType) => void;
  swapped: boolean;
  onSwap: () => void;
  saved: string | null;
  onSaved: (name: string) => void;
  onReset: () => void;
}

/** What was read, with the few things a person may need to put right, and the download. */
function Result(p: ResultProps) {
  const read: ReadStatement = useMemo(() => readStatement(p.runs, { fallbackYear: p.year }), [p.runs, p.year]);
  const lines: ReadLine[] = useMemo(
    () =>
      p.swapped
        ? read.lines.map((l) => {
            const balance = l.balance === null ? null : negate(l.balance);
            const line: ReadLine = { ...l, amount: negate(l.amount), balance };
            if (l.balanceOff !== undefined) line.balanceOff = negate(l.balanceOff);
            return line;
          })
        : read.lines,
    [read, p.swapped],
  );
  const flip = (cents: number) => (p.swapped ? negate(cents) : cents);
  const opening = read.opening && { ...read.opening, amount: flip(read.opening.amount) };
  const closing = read.closing && { ...read.closing, amount: flip(read.closing.amount) };
  const moneyIn = sumCents(lines.filter((l) => l.amount > 0).map((l) => l.amount));
  const moneyOut = sumCents(lines.filter((l) => l.amount < 0).map((l) => l.amount));
  const worksOut = opening && closing ? sumCents([opening.amount, moneyIn, moneyOut]) : null;
  const trimmed = p.account.trim();
  const canSave = lines.length > 0 && trimmed !== "" && read.periodStart !== null && read.periodEnd !== null;

  const save = () => {
    if (!canSave) return;
    const name = ofxFileName(trimmed, read.periodEnd!);
    download(
      name,
      buildOfx({
        accountType: p.accountType,
        account: trimmed,
        periodStart: read.periodStart!,
        periodEnd: read.periodEnd!,
        closing: closing?.amount ?? null,
        lines,
      }),
    );
    p.onSaved(name);
  };

  return (
    <>
      <div className={styles.head}>
        <p className={styles.file}>
          <Emoji>📄</Emoji> <strong>{p.name}</strong>
        </p>
        <Button size="sm" variant="ghost" onClick={p.onReset}>
          <Emoji>🔁</Emoji> Convert another PDF
        </Button>
      </div>

      {read.notes.map((n) => (
        <Notice key={n.text} tone={n.tone} role={n.tone === "warn" ? "alert" : "status"}>
          {n.text}
        </Notice>
      ))}

      {lines.length > 0 && (
        <>
          <Card title="What we read" icon={<Emoji>🔎</Emoji>}>
            <dl className="facts">
              <dt>Statement</dt>
              <dd>{read.kind === "card" ? "Credit card" : "Bank account"}</dd>
              <dt>Period</dt>
              <dd>
                {formatDate(read.periodStart!)} to {formatDate(read.periodEnd!)}
              </dd>
              <dt>Opening balance</dt>
              <dd>
                {opening
                  ? `${formatMoney(opening.amount)}${opening.printed ? "" : " (worked out from the running balance)"}`
                  : "Not shown"}
              </dd>
              <dt>Closing balance</dt>
              <dd>
                {closing
                  ? `${formatMoney(closing.amount)}${closing.printed ? "" : " (the last running balance)"}`
                  : "Not shown"}
              </dd>
              <dt>Transactions</dt>
              <dd>
                {lines.length}: {formatMoney(moneyIn)} in, {formatMoney(negate(moneyOut))} out
              </dd>
            </dl>
            {worksOut !== null && closing && (
              <div className={styles.check}>
                {worksOut === closing.amount ? (
                  <Notice tone="ok" role="status">
                    It adds up: the opening balance plus every line gives the closing balance.
                  </Notice>
                ) : (
                  <Notice tone="warn" role="alert">
                    The opening balance plus every line comes to {formatMoney(worksOut)}, but the closing balance is{" "}
                    {formatMoney(closing.amount)}. A line may be missing or misread: check the list against the PDF
                    before you import it.
                  </Notice>
                )}
              </div>
            )}
          </Card>

          <Card title="Before you download" icon={<Emoji>✏️</Emoji>}>
            <div className="row">
              <Field
                label="Account number"
                hint={
                  read.account
                    ? "As the statement prints it. Change it if your software expects something else."
                    : "We couldn't find it on the statement: type it in."
                }
              >
                <input
                  value={p.account}
                  onChange={(e) => p.onAccount(e.target.value)}
                  maxLength={40}
                  placeholder="12-3456-0123456-00"
                />
              </Field>
              <Field label="Account type">
                <select value={p.accountType} onChange={(e) => p.onAccountType(e.target.value as OfxAccountType)}>
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
              {read.assumedYear !== null && <YearField year={p.year} onYear={p.onYear} />}
            </div>
            <div className={styles.actions}>
              <Button variant="primary" disabled={!canSave} onClick={save}>
                <Emoji>⬇️</Emoji> Download OFX
              </Button>
              <Button variant="ghost" onClick={p.onSwap} aria-pressed={p.swapped}>
                <Emoji>🔃</Emoji> Swap money in and out
              </Button>
            </div>
            {p.saved && (
              <Notice tone="ok" role="status">
                Saved {p.saved}. Import it into your accounting software as a bank statement file.
              </Notice>
            )}
          </Card>

          <div className={styles.tableWrap}>
            <table className="table" aria-label="Transactions">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Money in</th>
                  <th className="num">Money out</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className={l.balanceOff !== undefined ? styles.off : undefined}>
                    <td className={styles.date}>
                      {formatDate(l.date)}
                      {l.madeOn && <span className={styles.madeOn}>made {formatDate(l.madeOn)}</span>}
                    </td>
                    <td>{l.description || <span className="muted">(no description)</span>}</td>
                    <td className="num">{l.amount > 0 ? formatMoney(l.amount) : ""}</td>
                    <td className="num">{l.amount < 0 ? formatMoney(negate(l.amount)) : ""}</td>
                    <td className="num">
                      {l.balanceOff !== undefined && (
                        <span title={`This balance is ${formatMoney(l.balanceOff)} away from the one before plus this line`}>
                          <Emoji>⚠️</Emoji>{" "}
                        </span>
                      )}
                      {l.balance === null ? "" : formatMoney(l.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
