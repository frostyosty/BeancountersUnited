import { useMemo, useRef, useState } from "react";
import { SiteHeader } from "../components/SiteHeader";
import { formatDate } from "../lib/dates";
import { Emoji, Icon } from "../lib/icons";
import { formatMoney, sumCents } from "../lib/money";
import { decodeText, readCsvStatement } from "../lib/pdfToOfx/csvIn";
import { fileKind, inPageOrder, MAX_PICTURES } from "../lib/pdfToOfx/files";
import {
  buildStatementFile,
  STATEMENT_FORMATS,
  type StatementFormat,
  CSV_LAYOUTS,
  type CsvLayout,
  statementFileName,
} from "../lib/pdfToOfx/formats";
import { canvasBlob, ocrTextRuns, type OcrProgress, PictureReadError } from "../lib/pdfToOfx/ocr";
import type { OfxAccountType } from "../lib/pdfToOfx/ofx";
import { PdfReadError, pdfPagePictures, pdfTextRuns } from "../lib/pdfToOfx/pdfText";
import { applyFixes, type Fixes, NO_FIXES } from "../lib/pdfToOfx/fixes";
import { hasReadableText, type ReadLine, type ReadStatement, readStatement } from "../lib/pdfToOfx/read";
import type { TextRun } from "../lib/pdfToOfx/layout";
import { Button, Card, Field, Notice, PageHeader } from "../ui";
import { StatementLines } from "./PdfToOfxLines";
import styles from "./PdfToOfxPage.module.css";

const SUBTITLE =
  "Drop in a bank or credit card statement (the PDF, a scan, photos or screenshots of its pages, or the bank's CSV), " +
  "check what we read, and download it as an OFX, QIF or CSV file for your accounting software. It's read on this " +
  "device and never uploaded.";

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

/** Where the statement came from: the PDF's text, OCR off a scanned PDF or pictures, or a CSV. */
type Source = "text" | "scan" | "picture" | "pictures" | "csv";

const SOURCE_TEXT: Record<Source, string> = {
  text: "The PDF's text",
  scan: "A scanned PDF, with text recognition",
  picture: "A picture, with text recognition",
  pictures: "Pictures, with text recognition",
  csv: "A CSV",
};

/** How to read what's dropped in: worked out from the file, or as the person says. */
type ReadAs = "auto" | "text" | "ocr" | "csv";

const READ_AS: Record<ReadAs, string> = {
  auto: "Work it out from the file",
  text: "A PDF's text",
  ocr: "A scan or pictures (text recognition)",
  csv: "A CSV from the bank",
};

/** The statement as read, given the year for dates printed without one. */
type ReadWithYear = (fallbackYear: number) => ReadStatement;

type Stage =
  | { kind: "idle" }
  | { kind: "reading"; name: string; progress: OcrProgress | null }
  | { kind: "failed"; name: string; message: string }
  | { kind: "read"; name: string; read: ReadWithYear; source: Source };

const ACCOUNT_TYPES: { value: OfxAccountType; label: string }[] = [
  { value: "cheque", label: "Everyday (cheque) account" },
  { value: "savings", label: "Savings account" },
  { value: "card", label: "Credit card" },
];

/** Turns a sign round without making a negative zero. */
const negate = (cents: number) => (cents === 0 ? 0 : -cents);

function failure(e: unknown): string {
  if (e instanceof PdfReadError || e instanceof PictureReadError) return e.message;
  return `We couldn't read this file: ${e instanceof Error ? e.message : String(e)}`;
}

/** What to say while a file is read. */
function readingText(name: string, progress: OcrProgress | null): string {
  if (!progress) return `Reading ${name}…`;
  if (progress.step === "loading") return "Getting the text reader ready (the first time takes a little while)…";
  const pct = `${Math.round(progress.done * 100)}%`;
  return progress.pages === 1 ? `Reading the words in ${name}… ${pct}` : `Reading page ${progress.page} of ${progress.pages}… ${pct}`;
}

const TAKE_A_BETTER_PICTURE =
  "Photos read best taken straight on, in good light, with the page flat and filling the picture; a screenshot of the statement on screen is better still.";

/** Hands the browser a file to save. */
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
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
  const [fixes, setFixes] = useState<Fixes>(NO_FIXES);
  const [format, setFormat] = useState<StatementFormat>("ofx");
  const [csvLayout, setCsvLayout] = useState<CsvLayout>("plain");
  const [readAs, setReadAs] = useState<ReadAs>("auto");
  const [saved, setSaved] = useState<string | null>(null);
  // Only the last file dropped in gets shown, however long an earlier one takes to read.
  const latest = useRef(0);
  // Kept so a file that couldn't be read can be tried again another way, straight from Read as.
  const lastFiles = useRef<File[] | null>(null);

  const open = async (files: File[], how: ReadAs) => {
    const token = ++latest.current;
    lastFiles.current = files;
    const name = files.length === 1 ? files[0]!.name : `${files.length} pictures`;
    const fail = (message: string) => {
      if (token === latest.current) setStage({ kind: "failed", name, message });
    };
    setSaved(null);
    if (files.some((f) => f.size > MAX_BYTES)) {
      fail("This file is too big to be a statement. Drop in the PDF you downloaded from your internet banking.");
      return;
    }
    if (files.length > MAX_PICTURES) {
      fail(`That's more than ${MAX_PICTURES} files. Drop in the pages of one statement at a time.`);
      return;
    }
    setStage({ kind: "reading", name, progress: null });
    const onProgress = (progress: OcrProgress) => {
      if (token === latest.current) setStage({ kind: "reading", name, progress });
    };
    try {
      const typed = await Promise.all(
        files.map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          return { file, bytes, kind: fileKind(bytes, file.name) };
        }),
      );
      const only = typed.length === 1 ? typed[0]! : null;
      let read: ReadWithYear;
      let source: Source;
      if (only && (how === "csv" || (how === "auto" && only.kind === "csv"))) {
        if (only.kind === "pdf" || only.kind === "picture") {
          fail(`This is a ${only.kind === "pdf" ? "PDF" : "picture"}, not a CSV: choose “${READ_AS.auto}” under Read as.`);
          return;
        }
        const text = decodeText(only.bytes);
        read = (fallbackYear) => readCsvStatement(text, { fallbackYear });
        source = "csv";
      } else if (how === "csv") {
        fail("Drop in one CSV at a time.");
        return;
      } else {
        let runs: TextRun[];
        if (only?.kind === "pdf") {
          runs = how === "ocr" ? [] : await pdfTextRuns(only.bytes);
          source = "text";
          if (!hasReadableText(runs)) {
            if (how === "text") {
              fail(`This PDF has no text in it, only pictures of its pages. Choose “${READ_AS.ocr}” under Read as to read them.`);
              return;
            }
            // A scan: no text, only pictures of the pages. Draw them and read the words off them.
            if (token !== latest.current) return;
            runs = await ocrTextRuns(await pdfPagePictures(only.bytes, canvasBlob), onProgress);
            source = "scan";
          }
        } else if (typed.every((t) => t.kind === "picture")) {
          if (how === "text") {
            fail(`A picture has no text in it to read. Choose “${READ_AS.ocr}” under Read as.`);
            return;
          }
          runs = await ocrTextRuns(inPageOrder(typed.map((t) => t.file)), onProgress);
          source = typed.length === 1 ? "picture" : "pictures";
        } else if (only) {
          fail(
            only.kind === "csv"
              ? `This is a CSV, not a PDF or a picture. Choose “${READ_AS.csv}” under Read as.`
              : only.kind === "bankFile"
                ? "This is already a bank file (OFX or QIF): you can use it as it is."
                : "This isn't a PDF, a picture or a CSV. Drop in the statement PDF from your internet banking, photos or screenshots of its pages, or the bank's CSV.",
          );
          return;
        } else {
          fail("Drop in one PDF or CSV at a time, or pictures of the pages of one statement together.");
          return;
        }
        if (token !== latest.current) return;
        const what = source === "scan" ? "this scan" : source === "picture" ? "this picture" : "these pictures";
        if (source !== "text" && !hasReadableText(runs)) {
          fail(`We couldn't make out any words in ${what}. ${TAKE_A_BETTER_PICTURE}`);
          return;
        }
        const recognised = source !== "text";
        read = (fallbackYear) => readStatement(runs, { fallbackYear, recognised });
      }
      if (token !== latest.current) return;
      const fallbackYear = new Date().getFullYear();
      const first = read(fallbackYear);
      if (first.lines.length === 0) {
        // Nothing to check or download: say why, and keep the drop zone up for the next try.
        const notes = first.notes.map((n) => n.text).join(" ");
        fail(source === "text" || source === "csv" ? notes : `${notes} ${TAKE_A_BETTER_PICTURE}`);
        return;
      }
      setYear(fallbackYear);
      setAccount(first.account ?? "");
      setAccountType(first.kind === "card" ? "card" : first.savings ? "savings" : "cheque");
      setSwapped(false);
      setFixes(NO_FIXES);
      setStage({ kind: "read", name, read, source });
    } catch (e) {
      fail(failure(e));
    }
  };

  const reset = () => {
    latest.current++;
    setStage({ kind: "idle" });
    setSaved(null);
  };

  return (
    <div className={styles.converter}>
      {stage.kind !== "read" && (
        <>
          <div className={styles.readAs}>
            <Field label="Read as" hint="Working it out suits almost every file. Choose another if what's read looks wrong.">
              <select
                value={readAs}
                onChange={(e) => {
                  const how = e.target.value as ReadAs;
                  setReadAs(how);
                  // A file that couldn't be read is tried again the new way.
                  if (stage.kind === "failed" && lastFiles.current) void open(lastFiles.current, how);
                }}
              >
                {(Object.keys(READ_AS) as ReadAs[]).map((value) => (
                  <option key={value} value={value}>
                    {READ_AS[value]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Drop busy={stage.kind === "reading"} onFiles={(f) => void open(f, readAs)} />
        </>
      )}
      {stage.kind === "reading" && (
        <p className="muted" role="status">
          <Emoji>⏳</Emoji> {readingText(stage.name, stage.progress)}
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
          read={stage.read}
          source={stage.source}
          format={format}
          onFormat={setFormat}
          csvLayout={csvLayout}
          onCsvLayout={setCsvLayout}
          year={year}
          onYear={setYear}
          account={account}
          onAccount={setAccount}
          accountType={accountType}
          onAccountType={setAccountType}
          swapped={swapped}
          onSwap={() => setSwapped((s) => !s)}
          fixes={fixes}
          onFixes={(f) => {
            setFixes(f);
            setSaved(null);
          }}
          saved={saved}
          onSaved={setSaved}
          onReset={reset}
        />
      )}
      <p className={styles.promise}>
        <Emoji>🔒</Emoji> Your statement never leaves this device, and no AI service reads it: fixed rules do, so the
        same PDF always gives the same file. Scans and pictures are read with text recognition (OCR) that also runs on
        this device.
      </p>
    </div>
  );
}

function Drop({ busy, onFiles }: { busy: boolean; onFiles: (files: File[]) => void }) {
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
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      }}
    >
      <span className={styles.dropIcon}>
        <Icon name="tools.pdfToOfx" fallback="🔄" />
      </span>
      <p className={styles.dropText}>
        {over ? "Drop it here" : "Drag a statement PDF, pictures of its pages, or the bank's CSV here"}
      </p>
      <Button size="sm" busy={busy} onClick={() => input.current?.click()}>
        <Emoji>📂</Emoji> Choose a file or pictures
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept="application/pdf,.pdf,image/*,.heic,text/csv,.csv"
        className={styles.hiddenInput}
        aria-label="Statement PDF, pictures or CSV"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
          e.target.value = "";
        }}
      />
      <span className={styles.dropHint}>
        The PDF from your internet banking works best. A scan works too, as do photos or screenshots of each page
        (choose them all at once), and so does the CSV your bank exports. Check what's read from a picture carefully.
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
  read: ReadWithYear;
  source: Source;
  format: StatementFormat;
  onFormat: (format: StatementFormat) => void;
  csvLayout: CsvLayout;
  onCsvLayout: (layout: CsvLayout) => void;
  year: number;
  onYear: (year: number) => void;
  account: string;
  onAccount: (account: string) => void;
  accountType: OfxAccountType;
  onAccountType: (type: OfxAccountType) => void;
  swapped: boolean;
  onSwap: () => void;
  fixes: Fixes;
  onFixes: (fixes: Fixes) => void;
  saved: string | null;
  onSaved: (name: string) => void;
  onReset: () => void;
}

/** What was read, with the few things a person may need to put right, and the download. */
function Result(p: ResultProps) {
  const { read: readWithYear, year } = p;
  const read: ReadStatement = useMemo(() => readWithYear(year), [readWithYear, year]);
  // The person's fixes laid over what was read: everything below, and the file, follow them.
  const fixed = useMemo(() => applyFixes(read, p.fixes), [read, p.fixes]);
  const lines: ReadLine[] = useMemo(
    () =>
      fixed.lines.map((l) => {
        const line: ReadLine = { page: l.page, date: l.date, description: l.description, amount: l.amount, balance: l.balance };
        if (l.madeOn) line.madeOn = l.madeOn;
        if (!p.swapped) return line;
        return { ...line, amount: negate(l.amount), balance: l.balance === null ? null : negate(l.balance) };
      }),
    [fixed, p.swapped],
  );
  const flip = (cents: number) => (p.swapped ? negate(cents) : cents);
  const opening = fixed.opening && { ...fixed.opening, amount: flip(fixed.opening.amount) };
  const closing = fixed.closing && { ...fixed.closing, amount: flip(fixed.closing.amount) };
  const lastBalance = fixed.lines.at(-1)?.balance ?? null;
  const moneyIn = sumCents(lines.filter((l) => l.amount > 0).map((l) => l.amount));
  const moneyOut = sumCents(lines.filter((l) => l.amount < 0).map((l) => l.amount));
  const worksOut = opening && closing ? sumCents([opening.amount, moneyIn, moneyOut]) : null;
  const trimmed = p.account.trim();
  // Lines whose dates were changed can fall outside the period read off the statement.
  const dates = lines.map((l) => l.date).sort();
  const periodStart = [read.periodStart, dates[0]].filter((d) => d != null).sort()[0] ?? null;
  const periodEnd = [read.periodEnd, dates.at(-1)].filter((d) => d != null).sort().at(-1) ?? null;
  const canSave = lines.length > 0 && trimmed !== "" && periodStart !== null && periodEnd !== null;

  const format = STATEMENT_FORMATS.find((f) => f.value === p.format) ?? STATEMENT_FORMATS[0]!;

  const save = () => {
    if (!canSave) return;
    const name = statementFileName(trimmed, periodEnd!, format.value);
    download(
      name,
      buildStatementFile(
        format.value,
        {
          accountType: p.accountType,
          account: trimmed,
          periodStart: periodStart!,
          periodEnd: periodEnd!,
          closing: closing?.amount ?? null,
          lines,
        },
        p.csvLayout,
      ),
      format.mime,
    );
    p.onSaved(name);
  };

  return (
    <>
      <div className={styles.head}>
        <p className={styles.file}>
          <Emoji>{p.source === "picture" || p.source === "pictures" ? "🖼️" : p.source === "csv" ? "📊" : "📄"}</Emoji>{" "}
          <strong>{p.name}</strong>
        </p>
        <Button size="sm" variant="ghost" onClick={p.onReset}>
          <Emoji>🔁</Emoji> Convert another statement
        </Button>
      </div>

      {p.source !== "text" && p.source !== "csv" && (
        <Notice tone="info" role="status">
          We read this from {p.source === "scan" ? "a scan" : p.source === "pictures" ? "pictures" : "a picture"}{" "}
          with text recognition, which can misread a character (an 8 for a 3, say). Check each line against the
          statement before you download it: lines whose running balance doesn't follow are marked.
        </Notice>
      )}

      {/* What's still marked is counted afresh beside the lines, as fixes are made. */}
      {read.notes
        .filter((n) => !n.about)
        .map((n) => (
          <Notice key={n.text} tone={n.tone} role={n.tone === "warn" ? "alert" : "status"}>
            {n.text}
          </Notice>
        ))}

      {fixed.all.length > 0 && (
        <>
          <Card title="What we read" icon={<Emoji>🔎</Emoji>}>
            <dl className="facts">
              <dt>Statement</dt>
              <dd>{read.kind === "card" ? "Credit card" : "Bank account"}</dd>
              <dt>Read from</dt>
              <dd>{SOURCE_TEXT[p.source]}</dd>
              <dt>Period</dt>
              <dd>
                {formatDate(periodStart!)} to {formatDate(periodEnd!)}
              </dd>
              <dt>Opening balance</dt>
              <dd>
                {opening
                  ? `${formatMoney(opening.amount)}${p.fixes.opening !== undefined ? " (set by you)" : opening.printed ? "" : " (worked out from the running balance)"}`
                  : "Not shown"}
              </dd>
              <dt>Closing balance</dt>
              <dd>
                {closing
                  ? `${formatMoney(closing.amount)}${p.fixes.closing !== undefined ? " (set by you)" : closing.printed ? "" : " (the last running balance)"}`
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
                    {closing.printed && lastBalance !== null && lastBalance !== fixed.closing?.amount && (
                      <>
                        {" "}
                        If the printed closing balance is for part of the file only, use the last running balance
                        instead.{" "}
                        <Button size="sm" onClick={() => p.onFixes({ ...p.fixes, closing: lastBalance })}>
                          <Emoji>🏁</Emoji> Close at {formatMoney(flip(lastBalance))}
                        </Button>
                      </>
                    )}
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
              <Field label="File type" hint="OFX suits almost everything. Pick another if your software asks for it.">
                <select value={format.value} onChange={(e) => p.onFormat(e.target.value as StatementFormat)}>
                  {STATEMENT_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
              {format.value === "csv" && (
                <Field label="CSV columns" hint="Plain suits a spreadsheet. Xero's suits its bank statement import.">
                  <select value={p.csvLayout} onChange={(e) => p.onCsvLayout(e.target.value as CsvLayout)}>
                    {CSV_LAYOUTS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <div className={styles.actions}>
              <Button variant="primary" disabled={!canSave} onClick={save}>
                <Emoji>⬇️</Emoji> Download {format.value.toUpperCase()}
              </Button>
              <Button variant="ghost" onClick={p.onSwap} aria-pressed={p.swapped}>
                <Emoji>🔃</Emoji> Swap money in and out
              </Button>
            </div>
            {p.saved && (
              <Notice tone="ok" role="status">
                Saved {p.saved}.{" "}
                {p.saved.endsWith(".csv")
                  ? "Open it in a spreadsheet, or import it into your accounting software."
                  : "Import it into your accounting software as a bank statement file."}
              </Notice>
            )}
          </Card>

          <StatementLines read={read} fixes={p.fixes} onFixes={p.onFixes} fixed={fixed} flip={p.swapped ? -1 : 1} />
        </>
      )}
    </>
  );
}
