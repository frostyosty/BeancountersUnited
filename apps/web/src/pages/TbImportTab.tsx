import type { TbCsvError } from "@acct/types/TbCsvError";
import type { TbImportPreview } from "@acct/types/TbImportPreview";
import type { TbImportProblem } from "@acct/types/TbImportProblem";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { can, useCurrentUser } from "../auth";
import { ErrorMessage } from "../components/ErrorMessage";
import { previewTbImport } from "../lib/api";
import { formatMoney } from "../lib/money";
import { keys } from "../lib/queries";
import { useCommand } from "../lib/useCommand";
import styles from "./TbImportTab.module.css";
import { useYearContext } from "./YearLayout";

export function TbImportTab() {
  const { year } = useYearContext();
  const me = useCurrentUser();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const preview = useMutation({ mutationFn: (csv: string) => previewTbImport(year.id, csv) });

  if (!can(me, "staff")) {
    return <p className="muted">Only staff can import a trial balance.</p>;
  }
  if (year.status === "finalised") {
    return <p className="muted">This year is finalised.</p>;
  }
  if (year.books_source === "bank_coding") {
    return <p className="muted">This year's books come from bank coding, so a TB can't be imported too.</p>;
  }

  const choose = async (f: File | undefined) => {
    preview.reset();
    if (!f) {
      setFile(null);
      return;
    }
    const text = await f.text();
    setFile({ name: f.name, text });
    preview.mutate(text);
  };

  return (
    <>
      <div className="card form">
        <h2>Import a trial balance</h2>
        <p className="muted">
          A CSV with a header row, and either <code>code, name, debit, credit</code> or <code>code, name, amount</code>{" "}
          (debits positive). The import posts the TB less the opening balances as this year's TB-import journal. Importing
          again replaces that journal and leaves every other journal alone.
        </p>
        <label className="field">
          <span>CSV file</span>
          <input type="file" accept=".csv,text/csv" onChange={(e) => void choose(e.target.files?.[0])} />
        </label>
        <ErrorMessage error={preview.error} />
      </div>
      {preview.isPending && <p className="muted">Checking…</p>}
      {preview.data && file && (
        <Preview key={file.name + file.text.length} preview={preview.data} csv={file.text} onDone={() => setFile(null)} />
      )}
    </>
  );
}

function Preview({ preview: p, csv, onDone }: { preview: TbImportPreview; csv: string; onDone: () => void }) {
  const { year, client, chart } = useYearContext();
  const navigate = useNavigate();
  const importTb = useCommand([keys.years, keys.client(client.id)]);
  const names = new Map(chart.map((a) => [a.code, a.name]));

  if (p.file_errors.length > 0) {
    const lines = csv.split(/\r?\n/);
    return (
      <div className="card" role="alert">
        <h2>The file can't be read</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Row</th>
              <th>In the file</th>
              <th>Problem</th>
            </tr>
          </thead>
          <tbody>
            {p.file_errors.map((e, i) => {
              const row = "row" in e ? e.row : null;
              return (
                <tr key={i}>
                  <td>{row ?? "—"}</td>
                  <td>
                    <code>{row === null ? "" : (lines[row - 1] ?? "")}</code>
                  </td>
                  <td className="error">{describeFileError(e)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const byAccount = new Map<string, TbImportProblem[]>();
  const general: TbImportProblem[] = [];
  for (const problem of p.problems) {
    if ("account" in problem) {
      byAccount.set(problem.account, [...(byAccount.get(problem.account) ?? []), problem]);
    } else {
      general.push(problem);
    }
  }
  const debits = p.rows.reduce((s, r) => s + (r.balance > 0 ? r.balance : 0), 0);
  const credits = p.rows.reduce((s, r) => s + (r.balance < 0 ? -r.balance : 0), 0);
  const ready = p.problems.length === 0 && !p.unchanged;

  return (
    <div className="card">
      <h2>Preview</h2>
      {general.map((g, i) => (
        <p key={i} role="alert" className="error">
          {describeProblem(g)}
        </p>
      ))}
      {p.retained_earnings_gap && (
        <div className={styles.warning} role="status">
          <strong>Retained earnings don't match last year.</strong> The file has{" "}
          {formatMoney(p.retained_earnings_gap.imported)} in {p.retained_earnings_gap.account}, but last year rolls
          forward {formatMoney(p.retained_earnings_gap.rolled_forward)} (a difference of{" "}
          {formatMoney(p.retained_earnings_gap.difference)}). That usually means last year's adjustments were never
          posted in the client's own books.
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Row</th>
            <th>Code</th>
            <th>Name in file</th>
            <th>Account in chart</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => {
            const problems = byAccount.get(r.code) ?? [];
            return (
              <tr key={r.row} className={problems.length ? styles.bad : undefined}>
                <td>{r.row}</td>
                <td>{r.code}</td>
                <td>{r.name}</td>
                <td>
                  {names.get(r.code) ?? ""}
                  {problems.map((pr, i) => (
                    <div key={i} className="error">
                      {describeProblem(pr)}
                    </div>
                  ))}
                </td>
                <td className="num">{r.balance > 0 ? formatMoney(r.balance) : ""}</td>
                <td className="num">{r.balance < 0 ? formatMoney(-r.balance) : ""}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={4}>Totals</th>
            <th className="num">{formatMoney(debits)}</th>
            <th className="num">{formatMoney(credits)}</th>
          </tr>
        </tfoot>
      </table>

      {p.unchanged ? (
        <p>This matches what's already imported, so importing it would change nothing.</p>
      ) : (
        p.problems.length === 0 && (
          <details className={styles.journal}>
            <summary>
              The journal this posts ({p.lines.length} lines)
              {p.replaces_journal_id && ", replacing the current TB-import journal"}
            </summary>
            <table className="table">
              <tbody>
                {p.lines.map((l) => (
                  <tr key={l.account}>
                    <td>{l.account}</td>
                    <td>{names.get(l.account) ?? ""}</td>
                    <td className="num">{l.amount > 0 ? formatMoney(l.amount) : ""}</td>
                    <td className="num">{l.amount < 0 ? formatMoney(-l.amount) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )
      )}
      <ErrorMessage error={importTb.error} />
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={!ready || importTb.isPending}
          onClick={() =>
            importTb.mutate(
              {
                kind: "import_tb",
                payload: { client_year_id: year.id, rows: p.rows.map((r) => ({ account: r.code, balance: r.balance })) },
              },
              {
                onSuccess: () => {
                  onDone();
                  void navigate(`/years/${year.id}/tb`);
                },
              },
            )
          }
        >
          Import
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function describeFileError(e: TbCsvError): string {
  switch (e.code) {
    case "unreadable":
      return e.message;
    case "unknown_layout":
      return `The header (${e.header.join(", ")}) isn't one of the layouts above.`;
    case "bad_code":
      return `"${e.value}" isn't an account code: ${e.message}`;
    case "bad_amount":
      return `"${e.value}" in ${e.column} isn't an amount: ${e.message}`;
    case "debit_and_credit":
      return "This row has both a debit and a credit.";
    case "duplicate_code":
      return `${e.account} is also on row ${e.first_row}.`;
    case "unbalanced":
      return `The file doesn't balance: debits less credits is ${formatMoney(e.difference)}.`;
    case "empty":
      return "The file has no rows.";
  }
}

function describeProblem(p: TbImportProblem): string {
  switch (p.code) {
    case "unknown_account":
      return `${p.account} isn't in the client's chart. Add it on the chart page, then check again.`;
    case "inactive_account":
      return `${p.account} is inactive in the client's chart.`;
    case "duplicate_account":
      return `${p.account} appears more than once.`;
    case "unbalanced":
      return `The TB doesn't balance: debits less credits is ${formatMoney(p.difference)}.`;
    case "books_from_bank_coding":
      return "This year's books come from bank coding.";
    case "year_finalised":
      return "This year is finalised.";
  }
}
